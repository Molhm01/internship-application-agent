/**
 * Questions that ask for *somebody else's* details.
 *
 * This exists because of the worst thing this project has done to a real
 * application. Lincoln Electric asks:
 *
 *     Do you have any relatives, including those by marriage, employed by our
 *     Company?
 *
 * and, beneath it:
 *
 *     If you have any relatives currently employed, provide their full name,
 *     location and your relationship to them.
 *
 * The parent was left unanswered — "No Selection" — and the child was filled
 * with the applicant's own legal name. The form then told an employer that the
 * applicant has a relative working there, and named them. Nobody had said that.
 * It is a false statement about a third party on a job application, and it is
 * categorically worse than any unfilled field.
 *
 * ## Why the existing protections did not stop it
 *
 * There were two, and both were structural, and both missed:
 *
 *  - `markConditionalChildren` links a child to its parent only when the label
 *    *begins* "If yes" / "If other". Lincoln's begins "If you have any
 *    relatives currently employed," so no link was made, and the executor's
 *    conditional gate had nothing to enforce.
 *  - the intent matcher scored the label against "full name" — it contains the
 *    words "full name" — and returned `full_name` at confidence 1.0.
 *
 * Both are being repaired. This module is the third protection, and it is the
 * one that does not depend on the page's structure at all: it reads the
 * *question* and decides whether it is asking about the applicant or about
 * someone else. A question about someone else can never be answered from the
 * applicant's identity, however the form is built and however the label is
 * worded.
 *
 * ## The rule
 *
 * Two things must both be present:
 *
 *  1. a **subject** who is plainly not the applicant — a relative, an emergency
 *     contact, a reference, a supervisor, the employee who referred them;
 *  2. a request for a **personal detail** — a name, an address, a phone number,
 *     a relationship.
 *
 * Requiring both is what keeps this from swallowing the questions around it.
 * The parent above names a subject ("relatives") and asks for no detail, so it
 * stays an ordinary yes/no question the applicant answers. "Employer Name" and
 * "Company Name" ask for a detail and name no third-party subject, so work
 * history still fills.
 */

/**
 * People a form can ask about who are not the applicant.
 *
 * Deliberately a closed list of *relationships*, never job words. `employer`,
 * `company` and `school` are absent on purpose: "Employer Name" is a work
 * history field the agent fills correctly, and adding it here would break it.
 */
const THIRD_PARTY_SUBJECTS: readonly RegExp[] = [
  /\brelatives?\b/,
  /\bfamily\s+members?\b/,
  /\bnext\s+of\s+kin\b/,
  /\bspouse\b/,
  /\bsiblings?\b/,
  // "parent" alone, but never "parent company".
  /\bparents?\b(?!\s+(company|organi[sz]ation|firm))/,
  /\bguardian\b/,
  /\bemergency\s+contact\b/,
  /\bcontact\s+person\b/,
  /\breferences?\b/,
  /\brefer(red|rer|ring)\b/,
  /\bsupervisors?\b/,
  /\bmanagers?\s+(name|phone|email|title)\b/,
  /\bco[-\s]?workers?\b/,
  /\bcolleagues?\b/,
  /\bbeneficiar(y|ies)\b/,
  /\bdependents?\b/,
  // "name of employee", "an employee of our company" — the person who referred
  // them, or the relative who works there.
  /\bemployees?\b/,
  /\bacquaintances?\b/,
  /\bfriends?\b/,
  /\bthird\s+part(y|ies)\b/,
];

/**
 * The details a form asks about a person.
 *
 * `employed` and `employment` are deliberately *not* here: "Do you have any
 * relatives … employed by our Company?" is a yes/no question about the
 * applicant's situation, and treating it as a request for somebody's details
 * would make the applicant unable to answer their own question.
 */
const PERSONAL_DETAILS: readonly RegExp[] = [
  /\bnames?\b/,
  /\baddress(es)?\b/,
  /\blocations?\b/,
  /\bphone\b/,
  /\btelephone\b/,
  /\bemail\b/,
  /\brelationships?\b/,
  /\brelation\b/,
  /\boccupations?\b/,
  /\bjob\s+titles?\b/,
  /\bposition\s+(held|title)\b/,
  /\bcontact\s+(details|information)\b/,
];

/**
 * True when this question asks for a person other than the applicant.
 *
 * The one question every caller here is really asking: *may a saved fact about
 * the applicant be written into this control?* When this returns true the
 * answer is no — not from the profile, not from an approved answer matched on
 * wording, and not from a generated one.
 */
export function describesThirdPartyDetails(rawLabel: string): boolean {
  // Normalised here rather than through `normalizeLabel`, which lives in
  // `normalizeQuestion` — the module that calls this one. Importing it back
  // would make the cycle, and this reduction is the same one: lowercase, no
  // punctuation, single spaces. Idempotent, so a caller that has already
  // normalised loses nothing by passing it through again.
  const label = rawLabel
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (label.length === 0) return false;
  const namesSomeoneElse = THIRD_PARTY_SUBJECTS.some((pattern) => pattern.test(label));
  if (!namesSomeoneElse) return false;
  return PERSONAL_DETAILS.some((pattern) => pattern.test(label));
}

/**
 * The sentence shown to the applicant about such a field.
 *
 * Says what the agent will not do and why, because "Information needed" over a
 * box asking about a relative reads as a defect unless the reason is given.
 */
/**
 * The activation value for a conditional child whose label states a condition
 * without naming the option that satisfies it.
 *
 * Lincoln Electric writes "If you have any relatives currently employed, …"
 * rather than "If yes, …". Both are the same claim, and the second names its
 * own activating value while the first does not. Rather than guess which option
 * on the parent counts, the scanner records this and the planner's gate reads
 * it as "the parent must hold an affirmative answer" — never as a licence to
 * fill while the parent is unanswered, which is the state the live form was in.
 *
 * Lives here rather than in the scanner because the scanner writes it, the
 * planner reads it, and the executor re-checks it against the live page. Three
 * packages agreeing on one string is the whole reason it is a shared constant.
 */
export const ACTIVATED_BY_ANY_ANSWER = '__affirmative__';

export const THIRD_PARTY_DETAILS_REASON =
  'This asks about someone other than you, so nothing saved about you can answer it. Fill it in yourself if it applies.';
