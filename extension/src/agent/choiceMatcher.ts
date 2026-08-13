import {
  agentChoiceDecisionSchema,
  agentChoiceRequestSchema,
  displaysSelection,
  isPlaceholderSelection,
  normalizeOptionText,
  type AgentChoiceDecision,
  type AgentChoiceRequest,
  type ErrorCode,
  type ObservedElement,
} from '@internship-agent/shared';

export type ChoiceMatchStrategy = 'EXACT' | 'ALIAS' | 'SEMANTIC' | 'UNKNOWN';

export interface ChoiceMatch {
  strategy: ChoiceMatchStrategy;
  optionId?: string;
  label?: string;
}

const groups: ReadonlyArray<{ intents: readonly string[]; values: readonly string[] }> = [
  { intents: ['state'], values: ['new jersey', 'nj', 'n j'] },
  {
    intents: ['country'],
    values: ['united states', 'united states of america', 'us', 'u s', 'usa', 'u s a'],
  },
  {
    intents: ['education_type', 'degree'],
    values: [
      'bachelor',
      'bachelors',
      'bachelor s',
      'bachelor degree',
      'bachelor s degree',
      'bachelor of science',
      'bs',
      'b s',
    ],
  },
  {
    intents: ['employment_type'],
    values: [
      'freelance',
      'freelancer',
      'self employed',
      'self employment',
      'independent contractor',
    ],
  },
  {
    intents: [
      'gender',
      'race_ethnicity',
      'hispanic_latino',
      'veteran_status',
      'disability_status',
      'sexual_orientation',
    ],
    values: [
      'decline to answer',
      'decline to self identify',
      'prefer not to disclose',
      'prefer not to answer',
      'prefer not to say',
      'i do not wish to answer',
      'i do not wish to disclose',
      'choose not to disclose',
    ],
  },
];

export function normalizeChoice(value: string): string {
  return normalizeOptionText(value)
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasEquivalent(element: Pick<ObservedElement, 'intent' | 'label'>, left: string, right: string): boolean {
  const intent = element.intent ?? '';
  const a = normalizeChoice(left);
  const b = normalizeChoice(right);
  if (!a || !b) return false;

  // Boolean aliases are safe only because the answer itself is explicit. The
  // question still travels with the comparison; absence of evidence never
  // reaches this matcher as a guessed "No".
  const yes = new Set(['yes', 'y', 'true']);
  const no = new Set(['no', 'n', 'false']);
  if ((yes.has(a) && yes.has(b)) || (no.has(a) && no.has(b))) return true;

  return groups.some(
    (group) =>
      group.intents.includes(intent) && group.values.includes(a) && group.values.includes(b),
  );
}

export function safeChoiceEquivalent(
  element: Pick<ObservedElement, 'intent' | 'label'>,
  offered: string,
  wanted: string,
): ChoiceMatchStrategy {
  if (isPlaceholderSelection(offered)) return 'UNKNOWN';
  const a = normalizeChoice(offered);
  const b = normalizeChoice(wanted);
  if (!a || !b) return 'UNKNOWN';
  if (a === b) return 'EXACT';
  if (aliasEquivalent(element, offered, wanted)) return 'ALIAS';
  // This is the existing boundary-checked decoration/token equivalence. It is
  // deliberately after explicit aliases and never uses unrestricted substring
  // matching, so "No Selection" cannot resolve to "No".
  if (displaysSelection(offered, wanted) || displaysSelection(wanted, offered)) {
    return 'SEMANTIC';
  }
  return 'UNKNOWN';
}

export function matchActualChoice(element: ObservedElement): ChoiceMatch {
  const wanted = element.proposedValue?.trim() ?? '';
  if (!wanted) return { strategy: 'UNKNOWN' };
  const choices = element.options.filter(
    (option) => !option.disabled && !isPlaceholderSelection(option.label),
  );
  for (const strategy of ['EXACT', 'ALIAS', 'SEMANTIC'] as const) {
    const matches = choices.filter(
      (option) => safeChoiceEquivalent(element, option.label, wanted) === strategy,
    );
    if (matches.length === 1 && matches[0]) {
      return { strategy, optionId: matches[0].optionId, label: matches[0].label };
    }
    if (matches.length > 1) return { strategy: 'UNKNOWN' };
  }
  return { strategy: 'UNKNOWN' };
}

export function matchActualChoices(element: ObservedElement): ChoiceMatch[] {
  const wanted = (element.proposedValue ?? '')
    .split('||')
    .map((value) => value.trim())
    .filter(Boolean);
  if (wanted.length === 0) return [];
  const matches: ChoiceMatch[] = [];
  for (const value of wanted) {
    const candidate = matchActualChoice({ ...element, proposedValue: value });
    if (!candidate.optionId) return [];
    matches.push(candidate);
  }
  return matches;
}

export function choiceRequestFor(element: ObservedElement): AgentChoiceRequest {
  return agentChoiceRequestSchema.parse({
    fieldType: element.interactionType,
    question: element.label,
    candidateContext: {
      trustedAnswerAvailable: Boolean(element.proposedValue?.trim()),
      ...(element.proposedValue?.trim() ? { trustedAnswer: element.proposedValue.trim() } : {}),
      ...(element.intent ? { fieldIntent: element.intent } : {}),
    },
    choices: element.options
      .filter((option) => !option.disabled && !isPlaceholderSelection(option.label))
      .map((option) => ({ optionId: option.optionId, label: option.label })),
  });
}

export type ChoiceDecisionValidation =
  | { valid: true; decision: AgentChoiceDecision }
  | { valid: false; errorCode: ErrorCode; reason: string };

/** Validates the model twice: schema first, then membership in the exact list. */
export function validateModelChoiceDecision(
  request: AgentChoiceRequest,
  raw: unknown,
): ChoiceDecisionValidation {
  const parsed = agentChoiceDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      errorCode: 'AGENT_INVALID_DECISION',
      reason: 'The model did not return the required multiple-choice decision shape.',
    };
  }
  const selectedIds = parsed.data.optionIds ??
    (parsed.data.optionId ? [parsed.data.optionId] : []);
  if (
    parsed.data.decision === 'SELECT' &&
    selectedIds.some(
      (optionId) => !request.choices.some((choice) => choice.optionId === optionId),
    )
  ) {
    return {
      valid: false,
      errorCode: 'INVALID_OPTION_ID',
      reason: 'The model named an optionId outside the choices it received.',
    };
  }
  return { valid: true, decision: parsed.data };
}
