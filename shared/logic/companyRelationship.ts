import type { CanonicalQuestion } from '../constants/questions.js';
import type { CompanyRelationship } from '../schemas/applicationBundle.js';

/**
 * Answering the questions that are about the employer, not about the applicant.
 *
 * "Have you worked here before?", "Does a family member work here?", "Do you
 * have a referral?" — none of these can be answered from a résumé, from the
 * rest of the profile, or by a model. They are facts about a relationship, and
 * the only honest sources are what the user recorded for *this* company and
 * nothing else.
 *
 * The distinction this module exists to preserve is between an unknown and a
 * no. Both would produce an unticked checkbox on the page, which is why it is
 * so easy to conflate them — and why conflating them is a fabrication: it
 * asserts to an employer that the applicant has never worked there, on the
 * strength of the user simply never having been asked.
 */

export const COMPANY_RELATIONSHIP_QUESTIONS = [
  'previously_employed',
  'previously_applied',
  'previously_interviewed',
  'family_member_employed',
  'employee_referral',
  'referral_name',
  'referral_email',
  'referral_relationship',
] as const satisfies readonly CanonicalQuestion[];

export type CompanyRelationshipQuestion = (typeof COMPANY_RELATIONSHIP_QUESTIONS)[number];

export function isCompanyRelationshipQuestion(
  question: CanonicalQuestion | undefined | null,
): question is CompanyRelationshipQuestion {
  return (
    question !== undefined &&
    question !== null &&
    (COMPANY_RELATIONSHIP_QUESTIONS as readonly string[]).includes(question)
  );
}

export type CompanyAnswer =
  | { status: 'answered'; value: string | boolean; reference: string; reason: string }
  | { status: 'ask_user'; reason: string; question: string };

/** The wording shown to the user when a fact has to be asked for. */
const USER_QUESTIONS: Record<CompanyRelationshipQuestion, string> = {
  previously_employed: 'Have you been employed by {company} before?',
  previously_applied: 'Have you applied to {company} before?',
  previously_interviewed: 'Have you interviewed with {company} before?',
  family_member_employed: 'Does a family member work at {company}?',
  employee_referral: 'Do you have an employee referral at {company}?',
  referral_name: 'What is the name of your referral at {company}?',
  referral_email: 'What is your referral’s email address at {company}?',
  referral_relationship: 'How do you know your referral at {company}?',
};

const BOOLEAN_FACTS: Partial<
  Record<CompanyRelationshipQuestion, keyof CompanyRelationship>
> = {
  previously_employed: 'previouslyEmployed',
  previously_applied: 'previouslyApplied',
  previously_interviewed: 'previouslyInterviewed',
  family_member_employed: 'familyMemberEmployed',
  employee_referral: 'hasReferral',
};

const TEXT_FACTS: Partial<Record<CompanyRelationshipQuestion, keyof CompanyRelationship>> = {
  referral_name: 'referralName',
  referral_email: 'referralEmail',
  referral_relationship: 'referralRelationship',
};

/**
 * Resolves one company question, or says it must be asked.
 *
 * Note what is missing: there is no fallback, no default, and no inference from
 * a neighbouring fact. `hasReferral === false` does not make `referral_name`
 * answerable with an empty string — it makes the whole referral group moot, and
 * the caller handles that by not showing the fields, not by filling them.
 */
export function resolveCompanyQuestion(
  question: CompanyRelationshipQuestion,
  relationship: CompanyRelationship | undefined,
  companyName: string,
): CompanyAnswer {
  const ask = (): CompanyAnswer => ({
    status: 'ask_user',
    question: USER_QUESTIONS[question].replace('{company}', companyName || 'this employer'),
    reason:
      'Only you know this, and the agent will not answer it for you. Once you answer, it can be saved for this employer.',
  });

  if (!relationship) return ask();

  const booleanKey = BOOLEAN_FACTS[question];
  if (booleanKey) {
    const value = relationship[booleanKey];
    if (typeof value !== 'boolean') return ask();
    return {
      status: 'answered',
      value,
      reference: `companyRelationship.${booleanKey}`,
      reason: `You recorded this for ${relationship.companyName}.`,
    };
  }

  const textKey = TEXT_FACTS[question];
  if (textKey) {
    // A referral's details are only meaningful when there is a referral. Asked
    // without one, they are not "blank" — they are not applicable, and the
    // honest response is still to ask rather than to type nothing.
    if (relationship.hasReferral !== true) return ask();
    const value = relationship[textKey];
    if (typeof value !== 'string' || !value.trim()) return ask();
    return {
      status: 'answered',
      value: value.trim(),
      reference: `companyRelationship.${textKey}`,
      reason: `Your saved referral details for ${relationship.companyName}.`,
    };
  }

  return ask();
}

/**
 * A company-specific override for a question the user answered once for this
 * employer, keyed by the question's own words.
 */
export function companyOverride(
  relationship: CompanyRelationship | undefined,
  questionText: string,
): string | null {
  const overrides = relationship?.overrides;
  if (!overrides) return null;
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = normalize(questionText);
  const found = Object.entries(overrides).find(([key]) => normalize(key) === wanted);
  return found?.[1]?.trim() || null;
}
