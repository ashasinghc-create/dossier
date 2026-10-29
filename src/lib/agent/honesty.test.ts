import { describe, expect, it } from "vitest";

import type { Extracted, Unit } from "@/lib/application-data";
import { demoProfile } from "@/lib/demo-profile";

import { honestyProblems } from "./honesty";

const profile = demoProfile();
const extracted: Extracted = {
  title: "Senior Product Designer · Ledgerly",
  company: "Ledgerly",
  role: "Senior Product Designer",
  location: "Amsterdam",
  mode: "Hybrid",
  salary: null,
  deadline: null,
  requirements: [
    { text: "5+ years of product design", kind: "years", skill: null, years: 5, language: null },
    { text: "Strong prototyping skills in Figma", kind: "skill", skill: "Figma", years: null, language: null },
    { text: "Accessibility know-how (WCAG 2.2)", kind: "skill", skill: "Accessibility", years: null, language: null },
    { text: "Dutch is a plus", kind: "language", skill: null, years: null, language: "Dutch" },
  ],
  asksForReferences: false,
  language: "English",
};

const unit = (id: string, text: string, unverified?: string[]): Unit => ({ id, label: id, text, ...(unverified ? { unverified } : {}) });
const check = (parts: { resume?: Unit[]; letter?: Unit[]; email?: Unit[] }) =>
  honestyProblems({ profile, extracted, facts: [], resume: parts.resume ?? [], letter: parts.letter ?? [], email: parts.email ?? [], today: new Date("2026-10-29") });

describe("the honesty check before an auto-send", () => {
  it("lets through what the profile backs, and naming the employer", () => {
    expect(check({ resume: [unit("summary", "Product designer who prototypes in Figma.")] })).toEqual([]);
    expect(check({ letter: [unit("paragraph:1", "I'd love to bring my Figma prototyping to Ledgerly in Amsterdam.")] })).toEqual([]);
  });

  it("stops anything the fact guard flagged", () => {
    expect(check({ resume: [unit("summary", "Led a team of 12.", ["12"])] })).toHaveLength(1);
  });

  it("stops a resume that names what only the posting has", () => {
    const problems = check({ resume: [unit("summary", "Designer fluent in WCAG audits.")] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("WCAG");
  });

  it("stops a letter or email that claims a requirement the profile lacks", () => {
    expect(check({ letter: [unit("paragraph:2", "My WCAG expertise fits your team.")] })[0]).toContain("WCAG");
    expect(check({ email: [unit("body", "Dear team,\n\nI bring 15 years of design.")] })[0]).toContain("15");
  });

  it("lets a letter name the employer's own work", () => {
    expect(check({ letter: [unit("paragraph:1", "Your work on Payments at Ledgerly is why I'm writing.")] })).toEqual([]);
  });

  it("skips the units built from the profile", () => {
    expect(check({ resume: [unit("skills", "Kubernetes · Figma")] })).toEqual([]);
  });
});
