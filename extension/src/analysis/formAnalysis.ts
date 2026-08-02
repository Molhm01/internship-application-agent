import {
  buildNormalizedQuestions,
  deterministicFillPlanSchema,
  matchOption,
  allowsRegionSuffix,
  resolveSemanticOption,
  isDeclinePhrasing,
  type ApplicationBundle,
  type ApplicationScanResult,
  type ApprovedAnswer,
  type DeterministicFillAction,
  type DeterministicFillPlan,
  type DetectedField,
  type FormAnalysisRequest,
  type FormFillPlan,
  type NormalizedQuestion,
  type PlannedAnswer,
  type Profile,
} from '@internship-agent/shared';
import { calculatePlanStatistics } from '../planner/deterministicPlanner.js';

/**
 * Semantic analysis of whatever deterministic resolution could not settle.
 *
 * The order is fixed and never reordered: profile rules, then approved answers,
 * then semantic similarity — all of which have already run in the deterministic
 * planner — and only then this. Everything here is the last tier before "ask
 * the user", so it is deliberately conservative:
 *
 * - one batched request per page, never one per field;
 * - only unresolved questions are sent, with only the facts they could need;
 * - no document bytes ever go to the model;
 * - a sensitive question is dropped from the model's answer even if it answers
 *   it, because a sensitive answer comes from an explicit saved preference or
 *   from nobody;
 * - the model names a question and an option label; the deterministic executor
 *   is what touches the page.
 */

/** Plan actions that mean the deterministic pass could not answer the field. */
const UNRESOLVED_ACTIONS = new Set<DeterministicFillAction['action']>([
  'missing_information',
  'manual_review',
  'unsupported',
]);

export function isUnresolved(action: DeterministicFillAction): boolean {
  return UNRESOLVED_ACTIONS.has(action.action);
}

/**
 * The saved facts a set of questions could plausibly need.
 *
 * Sending the whole profile would mean handing a local model a person's address
 * and demographic policies to answer a question about their GitHub. Facts are
 * keyed by the question they answer, and a question that nobody asked
 * contributes nothing.
 */
export function relevantFacts(
  profile: Profile,
  questions: readonly NormalizedQuestion[],
): FormAnalysisRequest['facts'] {
  const wanted = new Set(questions.map((question) => question.likelyIntent));
  const asksSomethingUnknown = questions.some((question) => question.likelyIntent === 'unknown');
  const personal = profile.personal;
  const education = profile.education[0];
  const eligibility = profile.eligibility;

  const candidates: Array<{
    id: string;
    label: string;
    value: string | number | boolean | undefined;
    /** The questions this fact can answer. */
    answers: readonly string[];
  }> = [
    {
      id: 'profile.personal.legalFirstName',
      label: 'legal first name',
      value: personal.legalFirstName,
      answers: ['first_name', 'full_name', 'preferred_name'],
    },
    {
      id: 'profile.personal.legalMiddleName',
      label: 'legal middle name',
      value: personal.legalMiddleName,
      answers: ['middle_name', 'full_name'],
    },
    {
      id: 'profile.personal.legalLastName',
      label: 'legal last name',
      value: personal.legalLastName,
      answers: ['last_name', 'full_name'],
    },
    {
      id: 'profile.personal.preferredName',
      label: 'preferred name',
      value: personal.preferredName,
      answers: ['preferred_name'],
    },
    {
      id: 'profile.personal.email',
      label: 'email address',
      value: personal.email,
      answers: ['email'],
    },
    {
      id: 'profile.personal.phone',
      label: 'phone number',
      value: personal.phone,
      answers: ['phone', 'phone_country_code'],
    },
    {
      id: 'profile.personal.address.line1',
      label: 'street address',
      value: personal.address.line1,
      answers: ['address_line1', 'current_location'],
    },
    {
      id: 'profile.personal.address.line2',
      label: 'address line 2',
      value: personal.address.line2,
      answers: ['address_line2'],
    },
    {
      id: 'profile.personal.address.city',
      label: 'city',
      value: personal.address.city,
      answers: ['city', 'current_location'],
    },
    {
      id: 'profile.personal.address.state',
      label: 'state or province',
      value: personal.address.state,
      answers: ['state', 'current_location'],
    },
    {
      id: 'profile.personal.address.postalCode',
      label: 'postal code',
      value: personal.address.postalCode,
      answers: ['postal_code'],
    },
    {
      id: 'profile.personal.address.country',
      label: 'country',
      value: personal.address.country,
      answers: ['country', 'current_location', 'phone_country_code'],
    },
    {
      id: 'profile.personal.linkedin',
      label: 'LinkedIn URL',
      value: personal.linkedin,
      answers: ['linkedin', 'website'],
    },
    {
      id: 'profile.personal.github',
      label: 'GitHub URL',
      value: personal.github,
      answers: ['github', 'website'],
    },
    {
      id: 'profile.personal.portfolio',
      label: 'portfolio URL',
      value: personal.portfolio,
      answers: ['portfolio', 'website'],
    },
    {
      id: 'profile.personal.personalWebsite',
      label: 'personal website',
      value: personal.personalWebsite,
      answers: ['website'],
    },
    {
      id: 'profile.education[0].institution',
      label: 'school',
      value: education?.institution,
      answers: ['school'],
    },
    {
      id: 'profile.education[0].degree',
      label: 'degree',
      value: education?.degree,
      answers: ['degree', 'degree_level', 'education_status'],
    },
    {
      id: 'profile.education[0].major',
      label: 'major',
      value: education?.major,
      answers: ['major'],
    },
    {
      id: 'profile.education[0].minor',
      label: 'minor',
      value: education?.minor,
      answers: ['minor'],
    },
    { id: 'profile.education[0].gpa', label: 'GPA', value: education?.gpa, answers: ['gpa'] },
    {
      id: 'profile.education[0].graduationDate',
      label: 'graduation date',
      value: education?.graduationDate,
      answers: ['graduation_date', 'graduation_month', 'graduation_year'],
    },
    {
      id: 'profile.eligibility.willingToRelocate',
      label: 'willing to relocate',
      value: eligibility.willingToRelocate,
      answers: ['willing_to_relocate'],
    },
    {
      id: 'profile.eligibility.willingToTravelPercent',
      label: 'willing to travel (percent)',
      value: eligibility.willingToTravelPercent,
      answers: ['willing_to_travel'],
    },
    {
      id: 'profile.eligibility.hasDriversLicense',
      label: 'holds a driver licence',
      value: eligibility.hasDriversLicense,
      answers: ['drivers_license'],
    },
    {
      id: 'profile.eligibility.meetsMinimumAge',
      label: 'meets the minimum age',
      value: eligibility.meetsMinimumAge,
      answers: ['minimum_age'],
    },
    {
      id: 'profile.eligibility.earliestStartDate',
      label: 'earliest start date',
      value: eligibility.earliestStartDate,
      answers: ['earliest_start_date', 'notice_period'],
    },
    {
      id: 'profile.eligibility.internshipAvailability',
      label: 'internship availability',
      value: eligibility.internshipAvailability,
      answers: [
        'internship_availability',
        'onsite_availability',
        'hybrid_availability',
        'remote_availability',
      ],
    },
    {
      id: 'profile.preferences.discoverySource',
      label: 'how they found the role',
      value: profile.preferences.discoverySource,
      answers: ['how_did_you_hear', 'referral', 'referral_source', 'job_board_source'],
    },
  ];

  return (
    candidates
      .filter((candidate) => candidate.value !== undefined && candidate.value !== '')
      // An unknown question could be about anything the user saved, so it gets the
      // ordinary facts — never the sensitive ones, which are not in this list at all.
      .filter(
        (candidate) =>
          asksSomethingUnknown || candidate.answers.some((name) => wanted.has(name as never)),
      )
      .map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        value: String(candidate.value),
      }))
  );
}

export interface AnalysisRequestInput {
  scan: ApplicationScanResult;
  plan: DeterministicFillPlan;
  profile: Profile;
  answers: readonly ApprovedAnswer[];
  bundle?: ApplicationBundle | null;
  model?: string;
  timeoutMs?: number;
}

export interface AnalysisRequestBuild {
  request: FormAnalysisRequest | null;
  questions: NormalizedQuestion[];
  /** Which scanned field each question stands for, for applying the result. */
  fieldsByQuestionId: Map<string, DetectedField[]>;
}

/**
 * Assembles the one request this page needs, or reports that no request is
 * needed at all — a fully resolved page must not cost a model call.
 */
export function buildAnalysisRequest(input: AnalysisRequestInput): AnalysisRequestBuild {
  const unresolvedFieldIds = new Set(
    input.plan.actions.filter(isUnresolved).map((action) => action.fieldId),
  );
  const fields = input.scan.fields.filter((field) => unresolvedFieldIds.has(field.id));
  const questions = buildNormalizedQuestions(fields);

  const fieldsByQuestionId = new Map<string, DetectedField[]>();
  for (const question of questions) {
    fieldsByQuestionId.set(
      question.questionId,
      fields.filter((field) => question.fieldIds.includes(field.id)),
    );
  }

  if (questions.length === 0) {
    return { request: null, questions, fieldsByQuestionId };
  }

  const request: FormAnalysisRequest = {
    pageId: input.scan.id,
    questions,
    facts: relevantFacts(input.profile, questions),
    approvedAnswers: input.answers
      .filter((answer) => answer.approved && !answer.sensitive)
      .slice(0, 200)
      .map((answer) => ({
        id: answer.id,
        question: answer.canonicalQuestion,
        answer:
          typeof answer.answer === 'boolean'
            ? answer.answer
              ? 'Yes'
              : 'No'
            : String(answer.answer),
      })),
    jobContext: {
      ...((input.bundle?.company ?? input.scan.jobContext.company)
        ? { company: input.bundle?.company ?? input.scan.jobContext.company }
        : {}),
      ...((input.bundle?.jobTitle ?? input.scan.jobContext.jobTitle)
        ? { jobTitle: input.bundle?.jobTitle ?? input.scan.jobContext.jobTitle }
        : {}),
      // Truncated deliberately: the model needs the gist, not the whole posting,
      // and a 40 kB description is what turns one call into a slow one.
      ...(input.bundle?.jobDescription
        ? { jobDescriptionExcerpt: input.bundle.jobDescription.slice(0, 6000) }
        : {}),
    },
    // Metadata only. Document bytes never reach the model.
    documents: [
      ...(input.bundle?.resume
        ? [
            {
              kind: 'resume' as const,
              filename: input.bundle.resume.filename,
              mimeType: input.bundle.resume.mimeType,
            },
          ]
        : []),
      ...(input.bundle?.coverLetter
        ? [
            {
              kind: 'cover_letter' as const,
              filename: input.bundle.coverLetter.filename,
              mimeType: input.bundle.coverLetter.mimeType,
            },
          ]
        : []),
    ],
    ...(input.model ? { model: input.model } : {}),
    timeoutMs: input.timeoutMs ?? 60_000,
  };

  return { request, questions, fieldsByQuestionId };
}

/** Why an answer from the model was discarded, in the user's terms. */
export interface DiscardedAnswer {
  questionId: string;
  reason: string;
}

function uploadActionFor(
  base: DeterministicFillAction,
  bundle: ApplicationBundle | null | undefined,
  kind: 'resume' | 'cover_letter',
  answer: PlannedAnswer,
): DeterministicFillAction | { discarded: string } {
  const document = kind === 'resume' ? bundle?.resume : bundle?.coverLetter;
  if (!document) {
    return { discarded: `No ${kind === 'resume' ? 'résumé' : 'cover letter'} is loaded.` };
  }
  return {
    ...base,
    action: 'upload_file',
    source: 'document',
    sourceReference: `bundle.${bundle?.id ?? 'active'}.${kind}`,
    documentId: document.bytesReference,
    documentName: document.filename,
    confidence: Math.max(answer.confidence, 0.8),
    requiresReview: true,
    approved: false,
    reason: `Attach ${document.filename}.`,
    warnings: [...base.warnings, 'Document uploads never submit the application.'],
  };
}

/**
 * Turns one validated model answer into a deterministic action, or explains why
 * it could not become one. Every option is matched against the choices the page
 * really offers; a label the model invented is discarded, not typed.
 */
function actionFromAnswer(
  existing: DeterministicFillAction,
  field: DetectedField,
  question: NormalizedQuestion,
  answer: PlannedAnswer,
  bundle: ApplicationBundle | null | undefined,
): DeterministicFillAction | { discarded: string } {
  const base: DeterministicFillAction = {
    ...existing,
    source: 'ai_suggestion',
    sourceReference: `analysis.${question.questionId}`,
    confidence: answer.confidence,
    requiresReview: answer.requiresReview,
    approved: false,
    reason: answer.reason || 'Proposed by page analysis from your saved data.',
    warnings: [...existing.warnings],
  };

  // Defence in depth. The prompt forbids it, the schema does not encode it, so
  // the extension enforces it: a sensitive question is never answered from a
  // model, whatever the model returned.
  if (question.sensitiveCategory && answer.action !== 'REQUIRE_USER_REVIEW') {
    return {
      discarded: `"${question.questionText}" is a ${question.sensitiveCategory} question and is only ever answered from an explicit saved preference.`,
    };
  }

  switch (answer.action) {
    case 'LEAVE_BLANK':
      return {
        ...base,
        action: 'skip',
        requiresReview: false,
        reason: answer.reason || 'Left blank.',
      };
    case 'REQUIRE_USER_REVIEW':
      return { ...base, action: 'manual_review', requiresReview: true };
    case 'UPLOAD_RESUME':
      return uploadActionFor(base, bundle, 'resume', answer);
    case 'UPLOAD_COVER_LETTER':
      return uploadActionFor(base, bundle, 'cover_letter', answer);
    case 'SET_CHECKBOX': {
      const checked = answer.value === 'true';
      return { ...base, action: 'toggle_checkbox', proposedValue: checked };
    }
    case 'SET_DATE':
      return { ...base, action: 'set_date', proposedValue: answer.value ?? '' };
    case 'SET_TEXT': {
      if (!answer.value) return { discarded: 'The proposed text was empty.' };
      return { ...base, action: 'fill_text', proposedValue: answer.value };
    }
    case 'SELECT_OPTION':
    case 'SELECT_RADIO': {
      const options = field.options ?? question.options ?? [];
      const wanted = answer.selectedOption ?? answer.value ?? '';
      if (options.length === 0) {
        // A combobox that has not opened yet has no list to check against. The
        // executor reads the real list and refuses anything not on it.
        return {
          ...base,
          action: 'select_suggested_option',
          proposedValue: wanted,
          matchedOption: { label: wanted, value: wanted },
          requiresReview: true,
          warnings: [
            ...base.warnings,
            'Options are read when the list opens; the exact match is confirmed at fill time.',
          ],
        };
      }
      const matched = matchOption(wanted, options, {
        allowRegionSuffix: allowsRegionSuffix(field.canonicalKey),
      });
      const semantic =
        matched.matched && matched.option
          ? { label: matched.option.label, value: matched.option.value }
          : resolveOptionSemantically(field, question, wanted);
      if (!semantic) {
        return {
          discarded: `"${wanted}" is not one of the options this form offers for "${question.questionText}".`,
        };
      }
      return {
        ...base,
        action: answer.action === 'SELECT_RADIO' ? 'choose_radio' : 'select_option',
        proposedValue: semantic.value,
        matchedOption: semantic,
      };
    }
    default:
      return { discarded: 'Unrecognized action.' };
  }
}

/**
 * Second chance for an option the page words differently — "I don't wish to
 * answer" against "Decline to self-identify". Still only ever returns an option
 * the page actually has.
 */
function resolveOptionSemantically(
  field: DetectedField,
  question: NormalizedQuestion,
  wanted: string,
): { label: string; value: string } | null {
  const options = field.options ?? question.options ?? [];
  const decision = resolveSemanticOption({
    fieldId: field.id,
    question: question.questionText,
    canonicalQuestion: field.canonicalKey ?? question.likelyIntent,
    options,
    intendedAnswer: wanted,
    ...(isDeclinePhrasing(wanted) ? { canonicalIntent: 'prefer_not_to_answer' as const } : {}),
    source: 'ai_semantic_match',
  });
  return decision.status === 'matched' && decision.selectedOption
    ? { label: decision.selectedOption.label, value: decision.selectedOption.value }
    : null;
}

export interface AppliedAnalysis {
  plan: DeterministicFillPlan;
  applied: number;
  discarded: DiscardedAnswer[];
}

/**
 * Folds a validated fill plan into the deterministic plan.
 *
 * Only actions the deterministic pass left unresolved can be replaced: an
 * answer the user actually saved is never displaced by an analysis.
 */
export function applyAnalysisToPlan(
  plan: DeterministicFillPlan,
  scan: ApplicationScanResult,
  analysis: FormFillPlan,
  fieldsByQuestionId: ReadonlyMap<string, DetectedField[]>,
  questions: readonly NormalizedQuestion[],
  bundle?: ApplicationBundle | null,
): AppliedAnalysis {
  const questionsById = new Map(questions.map((question) => [question.questionId, question]));
  const fieldsById = new Map(scan.fields.map((field) => [field.id, field]));
  const discarded: DiscardedAnswer[] = [];
  const replacements = new Map<string, DeterministicFillAction>();

  for (const answer of analysis.answers) {
    const question = questionsById.get(answer.questionId);
    const targets = fieldsByQuestionId.get(answer.questionId) ?? [];
    if (!question || targets.length === 0) {
      discarded.push({ questionId: answer.questionId, reason: 'No such question on this page.' });
      continue;
    }
    for (const target of targets) {
      const field = fieldsById.get(target.id);
      const existing = plan.actions.find((action) => action.fieldId === target.id);
      if (!field || !existing || !isUnresolved(existing)) {
        discarded.push({
          questionId: answer.questionId,
          reason: 'The deterministic pass already answered this field.',
        });
        continue;
      }
      const produced = actionFromAnswer(existing, field, question, answer, bundle);
      if ('discarded' in produced) {
        discarded.push({ questionId: answer.questionId, reason: produced.discarded });
        continue;
      }
      replacements.set(target.id, produced);
    }
  }

  const actions = plan.actions.map((action) => replacements.get(action.fieldId) ?? action);
  return {
    plan: deterministicFillPlanSchema.parse({
      ...plan,
      updatedAt: new Date().toISOString(),
      actions,
      statistics: calculatePlanStatistics(actions),
    }),
    applied: replacements.size,
    discarded,
  };
}
