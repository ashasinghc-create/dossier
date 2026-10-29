import { factSources, sourcesFor, unverifiedFacts } from "@/lib/ai/fact-guard";
import type { Extracted, Unit } from "@/lib/application-data";
import { isParagraph } from "@/lib/letter-frame";
import { experienceMonths, type ProfileData } from "@/lib/profile";

// The honesty check before auto-apply sends anything on its own. The fact
// guard (fact-guard.ts) accepts what the profile or the posting backs, which
// is right for a draft the user reads. Unattended, that's not enough: a skill
// or a number the posting asks for would pass the guard even when the profile
// doesn't have it. So before a send, this asks for more:
//
// - Every unit the fact guard flagged blocks the send.
// - The resume is checked against the profile alone (plus the job's title,
//   company, role and place, which a summary may name).
// - The cover letter's paragraphs and the email's message may name the
//   employer and what it does, but not a requirement of the posting the
//   profile doesn't back, nor a number the profile doesn't have.
//
// Anything it finds keeps the application for the user to review.

/** Units built from the profile in code, which nothing can invent in. */
const BUILT_FROM_PROFILE = new Set(["skills", "languages", "sign-off"]);

export type HonestyInput = {
  profile: ProfileData;
  extracted: Extracted;
  /** What the user told the AI for this application (APP-15): true, from them. */
  facts: string[];
  resume: Unit[];
  letter: Unit[];
  email: Unit[];
  today?: Date;
};

/** A unit's name for a problem, e.g. "Resume, Summary". */
const where = (document: string, unit: Unit) => `${document}, ${unit.label || unit.id}`;

const looksNumeric = (flag: string) => /\d/.test(flag) || /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)$/i.test(flag);

/**
 * Why the application can't be sent without the user's review, one line
 * each; empty when every claim is backed by the profile.
 */
export function honestyProblems({ profile, extracted, facts, resume, letter, email, today = new Date() }: HonestyInput): string[] {
  const problems: string[] = [];
  const years = Math.floor(experienceMonths(profile, today) / 12);
  // The profile and the user's facts, with the job's name fields but none of its requirements.
  const profileOnly = sourcesFor(profile, { ...extracted, requirements: [] }, facts.join("\n"), years);
  // What the posting asks for, to tell "names the employer" from "claims the requirement".
  const asked = factSources(extracted.requirements.flatMap((requirement) => [requirement.text, requirement.skill ?? "", requirement.language ?? ""]));
  const isAsked = (flag: string) => asked.words.has(flag.toLowerCase()) || asked.text.includes(flag.toLowerCase());

  const flagged = (document: string, units: Unit[]) => {
    for (const unit of units) {
      if (unit.unverified && unit.unverified.length > 0) problems.push(`${where(document, unit)}: couldn't find ${unit.unverified.join(", ")} in your profile.`);
    }
  };
  flagged("Resume", resume);
  flagged("Cover letter", letter);
  flagged("Email", email);

  for (const unit of resume) {
    if (BUILT_FROM_PROFILE.has(unit.id) || unit.unverified?.length) continue;
    const missing = unverifiedFacts(unit.text, profileOnly);
    if (missing.length > 0) problems.push(`${where("Resume", unit)}: ${missing.join(", ")} isn't in your profile.`);
  }

  const written = [
    ...letter.filter(isParagraph).map((unit) => ["Cover letter", unit] as const),
    ...email.filter((unit) => unit.id === "body").map((unit) => ["Email", unit] as const),
  ];
  for (const [document, unit] of written) {
    if (unit.unverified?.length) continue;
    const claimed = unverifiedFacts(unit.text, profileOnly).filter((flag) => looksNumeric(flag) || isAsked(flag));
    if (claimed.length > 0) problems.push(`${where(document, unit)}: mentions ${claimed.join(", ")}, which your profile doesn't back.`);
  }
  return problems;
}
