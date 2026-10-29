import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { extractedOf, unitsSchema, type Unit } from "@/lib/application-data";
import { emailAddresses, emailParts } from "@/lib/application-email";
import { loadGoogleAccount } from "@/lib/google/account";
import { sendApplicationEmail } from "@/lib/google/send";
import type { JobContext } from "@/lib/jobs/runner";
import { writeEmailJob } from "@/lib/jobs/write-email";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { loadFactTexts, loadProfile } from "@/lib/profile-data";
import { AUTO_APPLY_LOG_KEPT, type AutoApplyEntry } from "@/lib/settings";
import { loadSettings, saveSettings } from "@/lib/settings-data";

import { approveCandidate } from "./draft";
import { honestyProblems } from "./honesty";

// Auto-apply (this fork): once the agent has drafted an application, it may
// send it on its own, from the connected Gmail account, with the tailored
// resume and cover letter attached. Only when all of this holds:
//
// - Auto-apply is on, and so is "Never invent experience".
// - The posting scored at least the auto-apply minimum.
// - Fewer than the daily cap went out in the past 24 hours.
// - The posting gives an address to send applications to.
// - The honesty check finds nothing the profile doesn't back.
//
// Otherwise the draft waits on the Agent screen, as without auto-apply, and
// the reason is kept in the log. It never fills in forms on job sites.

const DAY = 24 * 60 * 60 * 1000;

/** Sends in the past 24 hours, from the log. */
export const sentInPastDay = (log: readonly AutoApplyEntry[], now: Date) =>
  log.filter((entry) => entry.sent && now.getTime() - Date.parse(entry.at) < DAY).length;

// One instance runs per database (README), so one lock in the process keeps
// two drafts finishing together from both passing the daily cap.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function record(entry: AutoApplyEntry) {
  const settings = await loadSettings();
  await saveSettings({ autoApplyLog: [entry, ...settings.autoApplyLog].slice(0, AUTO_APPLY_LOG_KEPT) });
}

const unitsOf = (documents: { kind: DocumentKind; units: unknown }[], kind: DocumentKind): Unit[] => {
  const parsed = unitsSchema.safeParse(documents.find((document) => document.kind === kind)?.units);
  return parsed.success ? parsed.data : [];
};

/** What's in the way of sending this draft on its own, or an empty list. */
async function problemsWith(applicationId: string, score: number): Promise<string[]> {
  const settings = await loadSettings();
  if (!settings.strict) return ["\"Never invent experience\" is off in Settings → AI provider; auto-apply only sends with it on."];
  if (score < settings.autoApplyMinScore) return [`It scored ${score}, below the auto-apply minimum of ${settings.autoApplyMinScore}.`];
  if (sentInPastDay(settings.autoApplyLog, new Date()) >= settings.autoApplyDailyCap) return [`Today's limit of ${settings.autoApplyDailyCap} sent applications is reached.`];
  if (!(await loadGoogleAccount())) return ["Gmail isn't connected in Settings → Google."];

  const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, include: { documents: { select: { kind: true, units: true } } } });
  const email = unitsOf(application.documents, DocumentKind.EMAIL);
  if (emailAddresses(emailParts(email).to).length === 0) return ["The posting doesn't give an email address to apply to: apply on its website."];

  return honestyProblems({
    profile: await loadProfile(),
    extracted: extractedOf(application),
    facts: await loadFactTexts(applicationId),
    resume: unitsOf(application.documents, DocumentKind.RESUME),
    letter: unitsOf(application.documents, DocumentKind.COVER_LETTER),
    email,
  });
}

/**
 * After a draft: writes its email, checks it all, and sends it when nothing
 * is in the way; otherwise leaves the draft for review. Never throws: the
 * draft is made either way.
 */
export async function autoApplyDraft(candidateId: string, applicationId: string, context: JobContext): Promise<boolean> {
  const settings = await loadSettings();
  if (!settings.autoApplyEnabled || context.signal.aborted) return false;
  const candidate = await prisma.agentCandidate.findUnique({ where: { id: candidateId }, select: { title: true, company: true, score: true } });
  if (!candidate) return false;
  const entry = { at: new Date().toISOString(), applicationId, title: candidate.title, company: candidate.company };

  try {
    // The email first, outside the lock: it's the slow part.
    await context.step(`Writing the email for ${candidate.company || "the posting"}`);
    await writeEmailJob.run({ applicationId }, context);

    return await oneAtATime(async () => {
      const reasons = await problemsWith(applicationId, candidate.score);
      if (reasons.length > 0) {
        await record({ ...entry, at: new Date().toISOString(), sent: false, reasons });
        await prisma.agentCandidate.update({ where: { id: candidateId }, data: { error: `Not sent on its own: ${reasons[0]}` } });
        return false;
      }
      await context.step(`Sending the application to ${candidate.company || "the employer"}`);
      await approveCandidate(candidateId);
      await sendApplicationEmail(applicationId);
      await record({ ...entry, at: new Date().toISOString(), sent: true, reasons: [] });
      return true;
    });
  } catch (error) {
    if (context.signal.aborted) return false;
    const message = error instanceof Error && error.message ? error.message : "Sending failed.";
    logServerError("auto-apply", error);
    await record({ ...entry, at: new Date().toISOString(), sent: false, reasons: [`Sending failed: ${message}`] }).catch(() => undefined);
    return false;
  }
}
