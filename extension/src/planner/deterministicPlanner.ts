import {
  resolveStructuralField,
  allowsRegionSuffix,
  chooseDiscoverySource,
  mayReasonAbout,
  isNeverGuessedQuestion,
  sectionForQuestion,
  contractViolation,
  isTextFieldType,
  repairActionFor,
  deterministicFillPlanSchema,
  isDeclinePhrasing,
  isLocationQuestion,
  isPasswordConfirmationField,
  isPasswordField,
  isUsernameField,
  locationSearchText,
  matchLocationOption,
  matchOption,
  normalizeOptionText,
  activeEducationEntry,
  type ApplicationScanResult,
  type ApprovedAnswer,
  type DeterministicFillAction,
  type DeterministicFillPlan,
  type DetectedField,
  type FieldMatch,
  type LocationTarget,
  type MatchHint,
  type Profile,
  type SavedDocument,
} from '@internship-agent/shared';
import {
  educationTypeAlternatives,
  isLegalAttestation,
  matchField,
} from '../matcher/deterministicMatcher.js';

/**
 * Page-level facts the planner resolved once and every action may need. The
 * location comes straight from the saved profile; nothing here is inferred.
 */
export interface PlanContext {
  location?: LocationTarget;
  hasPhoneCountryCodeField?: boolean;
  /** The saved answer for "How did you hear about us?", when the user set one. */
  discoverySource?: string;
  /** See `MatchContext.emailAsUsername`. Decided once, per page, below. */
  emailAsUsername?: boolean;
  /** Whether a conditional child's parent has switched it on. Built per scan. */
  conditionalGate?: (field: DetectedField) => ConditionalGate | null;
  /**
   * How many saved records back the repeating section this field sits in, or
   * null when the field is not part of one. Built once per plan from the
   * profile.
   */
  recordCount?: (field: DetectedField) => number | null;
  /** Other wordings of the same saved record, for a differently-worded list. */
  alternativeValues?: (field: DetectedField) => string[];
}

/**
 * The alternative wordings each question can offer, built once per plan.
 *
 * Deliberately a short, closed list. Only `education_type` needs one today, and
 * it needs it because two real employers ask that question with two different
 * vocabularies. Everything else supplies one value, as before.
 */
export function alternativeValuesFor(profile: Profile): (field: DetectedField) => string[] {
  return (field) => {
    if (field.canonicalKey !== 'education_type') return [];
    // The block's own record, by the same rule the matcher uses.
    const education =
      field.recordIndex === undefined
        ? activeEducationEntry(profile)
        : profile.education[field.recordIndex];
    // The first entry is the value the matcher already proposed, so it is
    // dropped here — the engine tries the proposed value first by construction.
    return educationTypeAlternatives(education).slice(1);
  };
}

/** "st", "nd", "rd", "th" — so a reason reads as a sentence rather than a log. */
function ordinalSuffix(value: number): string {
  if (value % 100 >= 11 && value % 100 <= 13) return 'th';
  if (value % 10 === 1) return 'st';
  if (value % 10 === 2) return 'nd';
  if (value % 10 === 3) return 'rd';
  return 'th';
}

/**
 * How many saved records exist for the section a field belongs to.
 *
 * Consulted only for a field the scanner numbered, so a page with one block of
 * each kind never reaches it.
 */
export function recordCountFor(profile: Profile): (field: DetectedField) => number | null {
  return (field) => {
    const canonical = field.canonicalKey;
    if (!canonical) return null;
    const section = sectionForQuestion(canonical);
    if (section === 'experience') return profile.experience.length;
    if (section === 'education') return profile.education.length;
    if (section === 'projects') return profile.projects.length;
    return null;
  };
}

/** Whether a conditional control's parent currently activates it. */
export interface ConditionalGate {
  active: boolean;
  /** True when the parent holds *some* answer — just not the activating one. */
  parentAnswered: boolean;
  reason: string;
}

/**
 * Reads the parent's observed answer for every conditional child on the page.
 *
 * The evidence is the parent's `currentValue` from this same scan — what the
 * control actually holds right now, not what the plan intends it to hold. That
 * distinction is the safety property: a plan that intends to choose "Other" has
 * not chosen it, and a child filled on that intention is filled against a form
 * state that does not exist yet.
 */
export function conditionalGateFor(
  fields: readonly DetectedField[],
): (field: DetectedField) => ConditionalGate | null {
  const byId = new Map(fields.map((field) => [field.id, field]));
  return (field) => {
    const dependency = field.dependsOn;
    if (!dependency) return null;
    const parent = byId.get(dependency.fieldId);
    if (!parent) {
      return {
        active: false,
        parentAnswered: false,
        reason: `"${field.question}" depends on a question that is no longer on the page.`,
      };
    }
    const held = parent.currentValue;
    const answers = (Array.isArray(held) ? held : [held])
      .filter((value) => value !== undefined && value !== '')
      // Normalized the same way option labels are, so a page spelling its
      // escape hatch "Other/Not Listed" and storing it as `other_not_listed`
      // both reduce to the same words as the activation value "other".
      .map((value) => normalizeOptionText(String(value)));
    const parentAnswered = answers.length > 0;
    // Matched against the option's value *and* its label, because a page
    // spelling "Other School" in the list stores it as `other`, and either is
    // the same answer.
    const chosenLabels = (parent.options ?? [])
      .filter((option) => answers.includes(normalizeOptionText(option.value)))
      .map((option) => normalizeOptionText(option.label));
    const active = [...answers, ...chosenLabels].some(
      (value) => value === dependency.value || value.startsWith(`${dependency.value} `),
    );
    return {
      active,
      parentAnswered,
      reason: active
        ? `"${parent.question}" is answered "${dependency.value}", so this applies.`
        : parentAnswered
          ? `"${parent.question}" is not answered "${dependency.value}", so this does not apply and stays blank.`
          : `"${parent.question}" has to be answered first; this fills only if that answer is "${dependency.value}".`,
    };
  };
}

/**
 * True when this page's account identifier may be answered with the saved email.
 *
 * Both halves matter. The page must be an ordinary application step — never a
 * sign-in or a registration, which belong to the account executor and the
 * credential vault — and the portal itself must have said the identifier is an
 * email address, either by typing the control `email` or by labelling it so.
 * Neither is inferred: a "Username" box on an application form that says nothing
 * about email stays the applicant's to fill.
 */
export function isEmailBackedLoginField(field: DetectedField): boolean {
  if (!isUsernameField(field) && field.canonicalKey !== 'account_username') return false;
  return (
    field.fieldType === 'email' ||
    /\be-?mail\b/i.test(`${field.label} ${field.question} ${field.helpText ?? ''}`)
  );
}

export function allowsEmailAsUsername(scan: ApplicationScanResult): boolean {
  const kind = scan.navigation?.kind;
  if (kind === 'login' || kind === 'account_creation') return false;
  return scan.fields.some(isEmailBackedLoginField);
}

/**
 * True when the scan found a control that takes the dialling code by itself.
 *
 * "By itself" is the whole of it. A combined phone widget renders its country
 * chooser *inside* the number's control, where nobody — agent or applicant —
 * can answer it separately; counting that as a split control made the planner
 * strip "+1" from the number and put it nowhere, leaving the dialling code off
 * the application entirely.
 *
 * The evidence is the scanner's, because it is the only place the two designs
 * differ observably: `embeddedInPhoneControl` says the chooser shares the
 * number's field container. A Greenhouse-style split control in its own block
 * carries no such mark and stays a control of its own, even though its choices
 * — like the combined one's — are not visible until it is opened.
 */
export function hasPhoneCountryCodeField(scan: ApplicationScanResult): boolean {
  return scan.fields.some(
    (field) =>
      field.canonicalKey === 'phone_country_code' &&
      !field.disabled &&
      field.metadata.embeddedInPhoneControl !== true,
  );
}

/** True when a saved answer is a decline rather than a substantive value. */
function isDeclineValue(value: unknown): value is string {
  return typeof value === 'string' && isDeclinePhrasing(value);
}

/** True when this field answers by choosing from a list rather than by typing. */
function isOptionControl(field: DetectedField): boolean {
  return ['select', 'combobox', 'radio', 'multi_select'].includes(field.fieldType);
}

/**
 * Optional questions that are answered by *not* answering them.
 *
 * Narrow on purpose. A blank optional free-text box is not automatically fine
 * — "Anything else you would like us to know?" is optional and still worth an
 * answer — so only fields whose emptiness is itself the correct answer are
 * listed here. Everything else keeps asking.
 */
const OPTIONAL_BLANK_QUESTIONS = new Set<string>([
  'middle_name',
  'address_line2',
  'name_suffix',
  'preferred_name',
  'pronouns',
  // A minor is a credential you either have or do not. An optional "Minor" box
  // on a profile that lists none is correctly empty, and asking the user to
  // confirm an absence is the noise this set exists to remove.
  'minor',
]);

function leaveOptionalBlank(field: DetectedField): boolean {
  return field.canonicalKey !== undefined && OPTIONAL_BLANK_QUESTIONS.has(field.canonicalKey);
}

function optionalBlankReason(field: DetectedField): string {
  if (field.canonicalKey === 'middle_name') {
    return 'Optional, and no middle name is saved, so it is correctly left blank.';
  }
  if (field.canonicalKey === 'address_line2') {
    return 'Optional, and your saved address has no second line. Address line 1 is never repeated here.';
  }
  if (field.canonicalKey === 'minor') {
    return 'Optional, and your saved education records no minor, so it is correctly left blank.';
  }
  return 'Optional, and nothing saved answers it, so it is correctly left blank.';
}

/** True when an option is a prompt rather than something a person can pick. */
function isPlaceholderOption(option: { label: string; value: string }): boolean {
  const label = option.label.trim().toLowerCase();
  if (option.value === '' || label.length === 0) return true;
  return /^(please )?(select|choose)\b/.test(label) || label === '--' || label === 'n/a';
}

/**
 * Controls whose choices are produced by another field on the page.
 *
 * Recognized structurally — a choice control offering nothing but prompts — so
 * this is not a list of vendor quirks to maintain. A dependent control is never
 * a failure; it is a control that has not had its turn yet.
 */
export function isDependentControl(field: DetectedField): boolean {
  if (field.fieldType !== 'select' && field.fieldType !== 'radio') return false;
  const options = field.options ?? [];
  if (options.length === 0) return true;
  return options.every(isPlaceholderOption);
}

/** The field a dependent control is waiting on, in the user's words. */
function dependsOnLabel(field: DetectedField): string {
  return field.canonicalKey === 'state' ? 'Country' : 'the field it depends on';
}

function locationOf(profile: Profile): LocationTarget {
  const address = profile.personal.address;
  return {
    ...(address.city ? { city: address.city } : {}),
    ...(address.state ? { state: address.state } : {}),
    ...(address.country ? { country: address.country } : {}),
  };
}

/**
 * The grounding a custom combobox executor needs, because such a control
 * reveals its options only once opened. Carries saved facts only — never a
 * selector, a script, or a position in a list.
 */
function buildMatchHint(field: DetectedField, context: PlanContext): MatchHint | undefined {
  // Other wordings of the same record, for a form whose list uses a different
  // vocabulary than the first one. Supplied by the resolver, never by the page.
  const alternatives = context.alternativeValues?.(field) ?? [];
  if (!isLocationQuestion(field.canonicalKey) || !context.location?.city) {
    if (!field.canonicalKey) return undefined;
    return {
      canonicalQuestion: field.canonicalKey,
      ...(alternatives.length > 0 ? { alternativeValues: alternatives } : {}),
    };
  }
  return {
    canonicalQuestion: field.canonicalKey,
    location: context.location,
    searchText: locationSearchText(context.location),
    ...(alternatives.length > 0 ? { alternativeValues: alternatives } : {}),
  };
}

const ACTIONABLE = new Set<DeterministicFillAction['action']>([
  'fill_text',
  'fill_generated_text',
  'select_option',
  'select_suggested_option',
  'select_resolved_option',
  'choose_radio',
  'toggle_checkbox',
  'set_date',
  'upload_file',
]);

export function actionIdForField(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `action-${(hash >>> 0).toString(36)}`;
}

/**
 * Enforces the control-type contract on a finished action.
 *
 * The planner is the first of two places this is checked; the executor is the
 * second, and neither trusts the other. A repairable mismatch — an option
 * action on a text box — is rewritten to the right strategy, because the value
 * is usually correct and only the strategy is wrong. Anything unrepairable
 * becomes `manual_review` naming the mismatch, rather than being handed to an
 * executor that will fail in a way nobody can read.
 */
function enforceContract(
  field: DetectedField,
  action: DeterministicFillAction,
): DeterministicFillAction {
  const violation = contractViolation(field.fieldType, action.action);
  if (!violation) return action;

  const repaired = repairActionFor(field.fieldType);
  if (repaired && typeof action.proposedValue === 'string' && action.proposedValue.length > 0) {
    return {
      ...action,
      action: repaired,
      // The matched option is meaningless on a text control and would make the
      // executor look for a list again on the next pass.
      ...(isTextFieldType(field.fieldType) ? { matchedOption: undefined } : {}),
      warnings: [...action.warnings, violation.reason],
    };
  }
  return {
    ...action,
    action: 'manual_review',
    requiresReview: true,
    reason: violation.reason,
    warnings: [...action.warnings, violation.reason],
  };
}

function actionFor(
  field: DetectedField,
  match: FieldMatch,
  selectedDocument?: SavedDocument,
  context: PlanContext = {},
): DeterministicFillAction {
  return enforceContract(field, planAction(field, match, selectedDocument, context));
}

function planAction(
  field: DetectedField,
  match: FieldMatch,
  selectedDocument?: SavedDocument,
  context: PlanContext = {},
): DeterministicFillAction {
  const hint = buildMatchHint(field, context);
  const base = {
    ...(hint ? { matchHint: hint } : {}),
    id: actionIdForField(field.id),
    fieldId: field.id,
    question: field.question,
    fieldType: field.fieldType,
    source: match.source,
    ...(match.sourceReference ? { sourceReference: match.sourceReference } : {}),
    confidence: match.confidence,
    sensitive: match.sensitive,
    requiresReview: match.requiresReview,
    approved: false,
    reason: match.reason,
    warnings: [...match.warnings],
    originalMatch: match,
  };
  // Before every other test, including the ones that would find a value.
  //
  // A conditional child is not a question about the applicant until its parent
  // says it is. The live run typed the applicant's own name into "If yes,
  // provide the name, location and relationship of each relative" — the label
  // contains "name", so the matcher found one — while the relatives question
  // above it sat unanswered. The form then stated to an employer that the
  // applicant had a relative working there. Nobody had said that.
  //
  // So the parent's *observed* answer decides, and until it activates the child
  // there is nothing here to plan. Once the parent verifies — Other chosen on a
  // School dropdown, Yes chosen on the relatives question — the next pass
  // rescans, sees the activating value, and this returns the real action.
  // A repeating block the applicant has no record for is not an unanswered
  // question — it is a block that does not apply.
  //
  // A form offers three Employer blocks to everybody; an applicant with one job
  // fills one of them. Reporting the other two as facts the user must confirm
  // adds ten cards of outstanding work to a finished application, and filling
  // them from the first record instead — which is what used to happen — states
  // an employment history that does not exist.
  if (field.recordIndex !== undefined && context.recordCount) {
    const available = context.recordCount(field);
    if (available !== null && field.recordIndex >= available) {
      return {
        ...base,
        action: 'skip',
        requiresReview: false,
        reason: `Your saved history has no ${field.recordIndex + 1}${ordinalSuffix(field.recordIndex + 1)} entry, so this block is correctly left empty.`,
        warnings: base.warnings,
      };
    }
  }
  const gate = context.conditionalGate?.(field);
  if (gate && !gate.active) {
    return {
      ...base,
      action: 'missing_information',
      requiresReview: gate.parentAnswered,
      reason: gate.reason,
      warnings: [...base.warnings, 'A conditional field is never filled ahead of its parent.'],
    };
  }
  if (!field.visible) {
    return { ...base, action: 'manual_review', reason: 'Scanned field is not visible.' };
  }
  if (field.disabled) {
    return { ...base, action: 'manual_review', reason: 'Scanned field is disabled.' };
  }
  if (field.fieldType === 'file') {
    const isResumeField =
      field.canonicalKey === 'resume' || /\b(resume|cv|curriculum vitae)\b/i.test(field.question);
    if (selectedDocument?.type === 'resume' && isResumeField) {
      return {
        ...base,
        action: 'upload_file',
        source: 'document',
        sourceReference: `documents.${selectedDocument.id}`,
        confidence: 1,
        requiresReview: true,
        approved: false,
        documentId: selectedDocument.id,
        documentName: selectedDocument.name,
        reason: `Attach ${selectedDocument.name} only after explicit approval.`,
        warnings: [
          ...base.warnings,
          'Document uploads always require explicit approval and never submit the application.',
        ],
      };
    }
    // An upload field the executor can drive, waiting only on a document choice.
    // Reporting this as `unsupported` hid a one-click fix behind a dead end.
    return {
      ...base,
      action: 'missing_information',
      requiresReview: true,
      reason: isResumeField
        ? 'No approved document selected.'
        : 'No approved document is selected for this upload field.',
      warnings: [
        ...base.warnings,
        'Choose a resume in settings, or pick one here, then approve the upload.',
      ],
    };
  }
  // Credentials never enter a deterministic plan, and the reason must say so.
  //
  // A `DeterministicFillPlan` is stored, sent to the popup, and rendered on a
  // review screen, so an employer-site password may not be in one. The account
  // form is filled by a separate path that writes straight to the page and
  // keeps the value in the credential vault.
  //
  // What was wrong was not the exclusion but the explanation: these fields fell
  // through to the generic unmatched branch and were reported as "the page
  // analysis could not run, so this question was never interpreted" — which
  // tells the user to start a local model to fix something a local model has
  // nothing to do with.
  //
  // The one exception is an account identifier the portal has itself declared
  // to be an email address, on a page that is not a sign-in — see
  // `allowsEmailAsUsername`. That is the applicant's own email, which is
  // already in the plan for the email box beside it, so nothing secret is added
  // by letting it fill the login box too.
  const usernameAnsweredByEmail =
    Boolean(context.emailAsUsername) && isEmailBackedLoginField(field);
  if ((isUsernameField(field) && !usernameAnsweredByEmail) || isPasswordField(field)) {
    const confirmation = isPasswordConfirmationField(field);
    return {
      ...base,
      action: 'manual_review',
      requiresReview: true,
      sensitive: true,
      reason: isUsernameField(field)
        ? 'Sign-in details are never put in a stored plan. Turn on employer account creation in settings, or type it yourself.'
        : confirmation
          ? 'Password confirmation is written straight to the page from the credential vault, never through a plan. Turn on employer account creation in settings, or type it yourself.'
          : 'A password is written straight to the page from the credential vault, never through a plan. Turn on employer account creation in settings, or type it yourself.',
      warnings: [...base.warnings, 'No credential is ever stored in, or shown by, a fill plan.'],
    };
  }
  // `combobox` is handled below, alongside `select`: its options were read off
  // the page by the scanner, and the executor drives it deterministically.
  if (['contenteditable', 'unknown'].includes(field.fieldType)) {
    return {
      ...base,
      action: 'unsupported',
      reason: `${field.fieldType} has no deterministic executor strategy.`,
    };
  }
  // A field about the form rather than about the applicant — "Phone Type",
  // "Address Type". These have one correct answer derivable from the form's own
  // vocabulary, and asking the user for them is noise: it is how a page of 26
  // fields produced a stack of "Information needed" cards for questions nobody
  // wants to be asked.
  //
  // Checked ahead of the canonical match, and only for option controls, because
  // the canonical key here is actively wrong: "Phone Type" classifies as
  // `phone`, so the matcher offers the phone *number* to a dropdown of Mobile /
  // Home / Work, fails to find it, and defers the field. A label this specific
  // is better evidence than a canonical key inferred from the word "phone". A
  // fact about the *person* is never a structural field and never reaches here.
  // "How did you hear about us?" is answered by inspecting every option the
  // page offers and choosing the closest category that is actually true —
  // never the first one on the list, and never a referral or a career fair
  // that did not happen.
  if (isOptionControl(field) && field.canonicalKey === 'how_did_you_hear') {
    const chosen = chooseDiscoverySource(field.options ?? [], context.discoverySource);
    if (chosen) {
      return {
        ...base,
        action: field.fieldType === 'radio' ? 'choose_radio' : 'select_option',
        proposedValue: chosen.option.value,
        matchedOption: { label: chosen.option.label, value: chosen.option.value },
        source: 'profile',
        sourceReference: context.discoverySource
          ? 'profile.preferences.discoverySource'
          : 'form.discoverySource',
        confidence: chosen.confidence,
        requiresReview: chosen.confidence < 0.9,
        reason: chosen.reason,
      };
    }
    return {
      ...base,
      action: 'missing_information',
      requiresReview: true,
      reason: 'None of this form’s source options truthfully describes how this job was found.',
      warnings: [
        ...base.warnings,
        'Pick the closest option yourself; one is never guessed for you.',
      ],
    };
  }
  // Only when the applicant has not answered it themselves.
  //
  // The profile now stores `phoneType` and `address.type`, and a stored answer
  // outranks anything inferred from the form's wording — the structural rules
  // are a fallback for facts nobody wrote down, not a substitute for the ones
  // that were.
  if (isOptionControl(field) && (!match.matched || match.formattedValue === undefined)) {
    const structural = resolveStructuralField(field);
    if (structural) {
      return {
        ...base,
        action: field.fieldType === 'radio' ? 'choose_radio' : 'select_option',
        proposedValue: structural.option.value,
        matchedOption: { label: structural.option.label, value: structural.option.value },
        source: 'profile',
        sourceReference: 'form.structural',
        confidence: structural.confidence,
        requiresReview: false,
        reason: structural.reason,
      };
    }
  }
  if (!match.matched || match.formattedValue === undefined) {
    // Nothing grounded this field. If an executor exists for the control, say so
    // — the blocker is a missing value, not a missing strategy.
    if (match.requiresReview) return { ...base, action: 'manual_review' };
    // An optional field with no saved value is *correctly* blank, and calling
    // that "Information needed" is wrong twice over: it asks the user for
    // something the employer did not, and it inflates the outstanding count
    // with work that does not exist. Middle Name on a profile that states there
    // is no middle name, and Address 2 for someone with no second line, are
    // both this case.
    if (!field.required && leaveOptionalBlank(field)) {
      return {
        ...base,
        action: 'skip',
        requiresReview: false,
        reason: optionalBlankReason(field),
        warnings: base.warnings,
      };
    }
    // A question the deterministic pass could not settle is *not* a dead end.
    //
    // This used to read "No saved answer applies to X yet", which stated the
    // rule that was wrong: that an ordinary question needs an exact saved
    // answer whose wording matches the page's. It does not. The deterministic
    // pass is the first of several tiers, and a field arriving here is on its
    // way to semantic option matching and then to the batched analysis — so the
    // reason says which stage it is waiting on, and only a question nobody may
    // reason about is described as needing the user.
    const awaitingUser = !mayReasonAbout(field.canonicalKey);
    return {
      ...base,
      action: 'missing_information',
      requiresReview: awaitingUser,
      reason: match.matched
        ? match.reason
        : awaitingUser
          ? `"${field.question}" is a fact only you can confirm.`
          : `"${field.question}" is waiting on the page analysis.`,
      warnings: [
        ...base.warnings,
        ...(isOptionControl(field)
          ? ['Its available choices are read when the control is opened.']
          : []),
      ],
    };
  }
  const existing = field.currentValue;
  const hasExistingValue =
    existing !== undefined &&
    existing !== '' &&
    existing !== false &&
    (!Array.isArray(existing) || existing.length > 0);
  const alreadyDifferent = (): void => {
    base.requiresReview = true;
    base.warnings.push(
      'The field already contains a different value; it will not be overwritten without review.',
    );
  };
  // Only for controls that are typed into.
  //
  // A `<select>` holds an option *value* — "US", "NJ", "1" — and the saved
  // value is "United States", "New Jersey", "+1". Comparing the two as strings
  // says they differ every time, so on a second run over a correctly filled
  // form Country, State and the dialling code were all escalated to
  // "Information needed" for holding exactly the right answer. An option
  // control is compared below instead, against the option that was matched.
  if (hasExistingValue && !isOptionControl(field)) {
    if (JSON.stringify(existing) !== JSON.stringify(match.formattedValue)) alreadyDifferent();
  }
  if (
    field.fieldType === 'select' ||
    field.fieldType === 'radio' ||
    field.fieldType === 'combobox'
  ) {
    if (typeof match.formattedValue === 'object') {
      return {
        ...base,
        action: 'manual_review',
        requiresReview: true,
        reason: 'A single-choice control requires one scalar value.',
      };
    }
    const options = field.options ?? [];
    // A combobox whose options were already visible was matched against real
    // choices, so it is `select_resolved_option` — the matched option is
    // evidence. One whose list is still unknown stays `select_suggested_option`,
    // where the match is confirmed against the live list at fill time.
    const selectKind =
      field.fieldType === 'radio'
        ? ('choose_radio' as const)
        : field.fieldType === 'combobox'
          ? options.length > 0
            ? ('select_resolved_option' as const)
            : ('select_suggested_option' as const)
          : ('select_option' as const);

    // A control whose choices another field has not produced yet.
    //
    // "State/Province" before "Country" is chosen offers exactly one option —
    // "Select a country first" — which is a prompt, not a choice. Matching the
    // saved state against it fails, and the failure was reported as
    // "No option on the page matched 'New Jersey'", which blames the profile
    // for the page's ordering. It is a dependency, so it is reported as one and
    // filled on the pass after Country lands.
    if (isDependentControl(field)) {
      return {
        ...base,
        action: 'missing_information',
        requiresReview: false,
        reason: `"${field.question}" has no choices yet — it fills once ${dependsOnLabel(field)} is set.`,
        warnings: [...base.warnings, 'Its options are read again after the field it depends on.'],
      };
    }

    // A custom combobox often renders its list only once opened, so the scanner
    // may have seen no options. The executor reads the real list at fill time and
    // refuses anything that is not an exact match there.
    if (options.length === 0 && field.fieldType === 'combobox') {
      const deferred = String(match.formattedValue);
      return {
        ...base,
        action: 'select_suggested_option',
        proposedValue: deferred,
        matchedOption: { label: deferred, value: deferred },
        // Inherited, not forced.
        //
        // This used to be `true`, and the reasoning was sound at the time: the
        // scanner had seen no options, so nothing had confirmed the answer was
        // on the list, and a person should look first. What that produced in
        // practice was a form where every custom dropdown sat unfilled behind a
        // confirmation the user had no way to give without doing the work
        // themselves — Education Country, Education State, School, Phone Type,
        // all of them, on every run.
        //
        // The confirmation now happens, and it happens against better evidence:
        // the executor opens the control, reads the choices it is actually
        // offering, and refuses anything that is not a literal, documented, or
        // defensible match — then verifies what the control displays afterwards.
        // A question the agent may not reason about never reaches here.
        requiresReview: base.requiresReview,
        warnings: [
          ...base.warnings,
          'Options are read when the list opens; the exact match is confirmed at fill time.',
        ],
      };
    }

    // A place is matched on city, state, and country together. Matching on the
    // city alone would happily pick Clifton, Colorado for a New Jersey profile.
    if (isLocationQuestion(field.canonicalKey) && context.location?.city) {
      const located = matchLocationOption(context.location, options);
      if (located.matched && located.option) {
        return {
          ...base,
          action: selectKind,
          proposedValue: located.option.value,
          matchedOption: { label: located.option.label, value: located.option.value },
          // An option that never named a region confirms nothing, so the user
          // confirms it instead.
          requiresReview: base.requiresReview || !located.stateConfirmed,
          reason: located.reason,
          warnings: [...base.warnings, ...located.warnings],
        };
      }
      return {
        ...base,
        action: located.ambiguous ? 'manual_review' : 'missing_information',
        requiresReview: true,
        reason: located.reason,
        warnings: [...base.warnings, ...located.warnings],
      };
    }

    const option = matchOption(match.formattedValue, options, {
      allowRegionSuffix: allowsRegionSuffix(field.canonicalKey),
    });
    if (!option.matched || !option.option) {
      // Two very different situations, and treating them alike is what turned
      // working dropdowns into dead ends.
      //
      // *Ambiguous* means the page offers several equally good answers, and
      // picking one would be a guess — that is genuinely the user's.
      //
      // *Not found* means it was not in the list the **scanner** recorded, which
      // is not evidence about the list the control is offering now. A State
      // select the page rebuilt after Country was chosen, an Education Country
      // list populated by script after load, and a searchable School list that
      // does not exist until it is opened all fail here, on a snapshot, with an
      // answer that was known the whole time. So the field is handed to the
      // executor, which opens the control, reads what it is *currently*
      // offering, and refuses anything that is not an exact match there.
      // A question nobody may reason about is not deferred either. Work
      // authorization, sponsorship and the protected characteristics are
      // answered from an exact saved fact in the form's own words or not at
      // all: a saved "U.S. Citizen" against a Yes/No control is a legal
      // conclusion the profile never stated, and the executor must not be
      // handed it to "match semantically". It is the applicant's to confirm,
      // and it is reported that way rather than as a dropdown that failed.
      // A question nobody may reason about is not deferred either. Work
      // authorization, sponsorship and the protected characteristics are
      // answered from an exact saved fact in the form's own words or not at
      // all: a saved "U.S. Citizen" against a Yes/No control is a legal
      // conclusion the profile never stated, and the executor must not be
      // handed it to "match semantically". It is the applicant's to confirm,
      // and it is reported that way rather than as a dropdown that failed.
      //
      // Scoped to *sensitive and eligibility* questions rather than to
      // `mayReasonAbout`, which is a different rule with a different purpose:
      // it stops the model inventing a matter of record. Matching a school or a
      // field of study the applicant already recorded against the options a
      // page is offering involves no model and invents nothing, and blocking it
      // here left "Area of Study" at No Selection with the answer in hand.
      if (
        option.ambiguous ||
        field.fieldType === 'radio' ||
        isNeverGuessedQuestion(field.canonicalKey)
      ) {
        return {
          ...base,
          action: 'manual_review',
          requiresReview: true,
          reason: option.reason,
          warnings: [
            ...base.warnings,
            option.ambiguous ? 'Option match is ambiguous.' : 'No exact option exists.',
          ],
        };
      }
      const deferred = String(match.formattedValue);
      return {
        ...base,
        action: 'select_suggested_option',
        proposedValue: deferred,
        matchedOption: { label: deferred, value: deferred },
        // Same reasoning as the branch above: the live list is the evidence,
        // and it is read by the executor rather than asked of the user.
        requiresReview: base.requiresReview,
        reason: `${option.reason} The control's own list is read again when it is opened.`,
        warnings: [
          ...base.warnings,
          'The choices recorded during the scan did not include this answer; the live list is checked at fill time.',
        ],
      };
    }
    // A spelling alias ("United States" → "United States of America") is an
    // equivalent wording of the saved value, so it stays auto-approvable. A
    // region-suffix match adds information the profile never stated, so it is
    // always confirmed by the user first.
    const inferredRegion = option.matchKind === 'region_suffix';
    // Now that the form's own word for the saved value is known, a control that
    // already holds something can be judged against it. Holding the matched
    // option is the *correct* state and needs no confirmation; holding anything
    // else is a value the agent did not write and will not overwrite unseen.
    if (
      hasExistingValue &&
      existing !== option.option.value &&
      existing !== option.option.label &&
      !(Array.isArray(existing) && existing.includes(option.option.value))
    ) {
      alreadyDifferent();
    }
    return {
      ...base,
      action: selectKind,
      proposedValue: option.option.value,
      matchedOption: { label: option.option.label, value: option.option.value },
      requiresReview: base.requiresReview || inferredRegion,
      warnings: option.aliasUsed
        ? [...base.warnings, `Matched via ${option.aliasUsed}.`]
        : base.warnings,
    };
  }
  if (field.fieldType === 'checkbox' || field.fieldType === 'multi_select') {
    if (isLegalAttestation(field) && match.source !== 'approved_answer') {
      return {
        ...base,
        action: 'manual_review',
        requiresReview: true,
        reason: 'Legal attestation requires an explicit approved answer.',
      };
    }
    if (field.fieldType === 'multi_select') {
      // "Mark all that apply" still accepts a single answer, and declining is
      // exactly that: one option, chosen instead of the categories, never
      // alongside them. A scalar decline is therefore a valid one-item set.
      if (!Array.isArray(match.formattedValue) && isDeclineValue(match.formattedValue)) {
        const declineOptions = field.options ?? [];
        const declineMatch = matchOption(match.formattedValue, declineOptions);
        if (declineMatch.matched && declineMatch.option) {
          return {
            ...base,
            action: 'toggle_checkbox',
            proposedValue: [declineMatch.option.value],
            reason: `Your saved preference corresponds to "${declineMatch.option.label}".`,
            warnings: [
              ...base.warnings,
              'Only the decline option is selected; no category is marked.',
            ],
          };
        }
        if (declineOptions.length === 0) {
          // A custom multi-select reveals its choices only once opened, so the
          // decline option is matched against the live list at fill time.
          const deferred = String(match.formattedValue);
          return {
            ...base,
            action: 'select_suggested_option',
            proposedValue: deferred,
            matchedOption: { label: deferred, value: deferred },
            requiresReview: true,
            warnings: [
              ...base.warnings,
              'Options are read when the list opens; only the decline option is selected.',
            ],
          };
        }
        return {
          ...base,
          action: 'missing_information',
          requiresReview: true,
          reason: 'This form offers no way to decline this question.',
          warnings: [...base.warnings, 'A category is never marked on your behalf.'],
        };
      }
      if (!Array.isArray(match.formattedValue)) {
        return {
          ...base,
          action: 'manual_review',
          requiresReview: true,
          reason: 'A checkbox group requires an explicit list of selected values.',
        };
      }
      const exactValues: string[] = [];
      for (const value of match.formattedValue) {
        const option = matchOption(value, field.options ?? []);
        if (!option.matched || !option.option) {
          return {
            ...base,
            action: 'manual_review',
            requiresReview: true,
            reason: option.reason,
          };
        }
        exactValues.push(option.option.value);
      }
      return { ...base, action: 'toggle_checkbox', proposedValue: exactValues };
    }
    if (typeof match.formattedValue !== 'boolean') {
      return {
        ...base,
        action: 'manual_review',
        requiresReview: true,
        reason: 'A single checkbox requires an explicit boolean value.',
      };
    }
    return { ...base, action: 'toggle_checkbox', proposedValue: match.formattedValue };
  }
  if (field.fieldType === 'date' || field.fieldType === 'month') {
    return {
      ...base,
      action: 'set_date',
      // A month control accepts "YYYY-MM" and rejects a full ISO date, so a
      // saved "2027-05-01" is trimmed rather than written and silently dropped.
      proposedValue:
        field.fieldType === 'month' ? monthValue(match.formattedValue) : match.formattedValue,
    };
  }
  return { ...base, action: 'fill_text', proposedValue: match.formattedValue };
}

/**
 * `YYYY-MM` for a month control.
 *
 * Trims a full ISO date rather than rejecting it, because the profile stores
 * one date and both control shapes are legitimate readings of it. A value that
 * is not a date at all is passed through untouched for the verifier to fail on
 * honestly, rather than being mangled into something that looks plausible.
 */
function monthValue<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  const match = /^(\d{4}-\d{2})(?:-\d{2})?$/.exec(value.trim());
  return match?.[1] ?? value;
}

/** True only when the action carries a value an executor can actually apply. */
export function isExecutable(action: DeterministicFillAction): boolean {
  if (!ACTIONABLE.has(action.action)) return false;
  if (action.action === 'upload_file') return Boolean(action.documentId);
  return action.proposedValue !== undefined;
}

/**
 * Assigns every action to exactly one bucket, in priority order, so the totals
 * always reconcile. Previously an action could be counted in several buckets and
 * an unsupported one could still look approved.
 */
export function classifyAction(
  action: DeterministicFillAction,
): 'approved' | 'ready' | 'review' | 'missingInformation' | 'skipped' | 'unsupported' {
  if (action.action === 'unsupported') return 'unsupported';
  if (action.action === 'skip') return 'skipped';
  if (action.action === 'missing_information') return 'missingInformation';
  // No value means nothing to be ready or approved about, whatever the flags say.
  if (!isExecutable(action))
    return action.action === 'manual_review' ? 'review' : 'missingInformation';
  if (action.approved) return 'approved';
  if (action.requiresReview || action.confidence < 0.8) return 'review';
  return 'ready';
}

export function calculatePlanStatistics(actions: readonly DeterministicFillAction[]) {
  const buckets = actions.map(classifyAction);
  const count = (name: ReturnType<typeof classifyAction>): number =>
    buckets.filter((bucket) => bucket === name).length;

  return {
    total: actions.length,
    ready: count('ready'),
    approved: count('approved'),
    review: count('review'),
    missingInformation: count('missingInformation'),
    skipped: count('skipped'),
    unsupported: count('unsupported'),
    sensitive: actions.filter((action) => action.sensitive).length,
  };
}

function withActions(
  plan: DeterministicFillPlan,
  actions: DeterministicFillAction[],
): DeterministicFillPlan {
  return deterministicFillPlanSchema.parse({
    ...plan,
    updatedAt: new Date().toISOString(),
    actions,
    statistics: calculatePlanStatistics(actions),
  });
}

/**
 * Controls that must be written before the controls that depend on them.
 *
 * The executor walks the plan in order, and document order is *usually* right —
 * but not always, and three pairs genuinely matter:
 *
 * - A phone country-code control reformats the number beside it when it
 *   changes. A number written first is silently rewritten, or wiped, by a code
 *   chosen afterwards.
 * - A country control repopulates the state list. A state written first is
 *   discarded when the country lands.
 * - A current-student control reveals the anticipated-graduation control beside
 *   it. A graduation date written into a box that is still hidden — or still
 *   disabled — is written nowhere, and the run then reports a date the page
 *   never took.
 *
 * Everything not named here keeps its document position exactly, so this cannot
 * reorder a form into an order the applicant would not recognize.
 */
const EXECUTION_PRECEDENCE: Readonly<Record<string, number>> = {
  phone_country_code: -2,
  country: -1,
  education_status: -1,
};

function orderForExecution(
  fields: readonly DetectedField[],
  actions: readonly DeterministicFillAction[],
): DeterministicFillAction[] {
  const canonicalOf = new Map(fields.map((field) => [field.id, field.canonicalKey]));
  const precedence = (action: DeterministicFillAction): number =>
    EXECUTION_PRECEDENCE[canonicalOf.get(action.fieldId) ?? ''] ?? 0;

  // A stable sort, so fields sharing a precedence keep document order and the
  // review screen still reads top to bottom the way the form does.
  return [...actions]
    .map((action, index) => ({ action, index }))
    .sort((left, right) => {
      const byPrecedence = precedence(left.action) - precedence(right.action);
      return byPrecedence !== 0 ? byPrecedence : left.index - right.index;
    })
    .map((entry) => entry.action);
}

export function buildDeterministicPlan(
  scan: ApplicationScanResult,
  profile: Profile,
  answers: readonly ApprovedAnswer[],
  selectedDocument?: SavedDocument,
): DeterministicFillPlan {
  const context: PlanContext = {
    location: locationOf(profile),
    hasPhoneCountryCodeField: hasPhoneCountryCodeField(scan),
    emailAsUsername: allowsEmailAsUsername(scan),
    conditionalGate: conditionalGateFor(scan.fields),
    recordCount: recordCountFor(profile),
    alternativeValues: alternativeValuesFor(profile),
    ...(profile.preferences?.discoverySource
      ? { discoverySource: profile.preferences.discoverySource }
      : {}),
  };
  const actions = orderForExecution(
    scan.fields,
    scan.fields.map((field) =>
      actionFor(
        field,
        matchField(field, profile, answers, undefined, {
          ...(context.hasPhoneCountryCodeField ? { hasPhoneCountryCodeField: true } : {}),
          ...(context.emailAsUsername ? { emailAsUsername: true } : {}),
        }),
        selectedDocument,
        context,
      ),
    ),
  );
  const now = new Date().toISOString();
  return deterministicFillPlanSchema.parse({
    id: `plan-${crypto.randomUUID()}`,
    scanId: scan.id,
    createdAt: now,
    updatedAt: now,
    url: scan.url,
    domain: scan.domain,
    ats: scan.ats.id,
    actions,
    warnings: [
      'This deterministic plan never submits or advances the application.',
      ...(scan.ats.id === 'workday'
        ? ['Workday support covers only the scanned, currently rendered step.']
        : []),
    ],
    statistics: calculatePlanStatistics(actions),
  });
}

export function setActionApproval(
  plan: DeterministicFillPlan,
  actionId: string,
  approved: boolean,
): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) => {
      if (action.id !== actionId) return action;
      // Nothing without a real value can be approved, so the review screen can
      // never show "Approved" beside "No proposed value".
      const canApprove =
        isExecutable(action) &&
        (action.action === 'upload_file'
          ? action.requiresReview
          : action.action === 'fill_generated_text'
            ? action.answerValidationPassed === true
            : action.action === 'select_suggested_option' ||
                action.action === 'select_resolved_option'
              ? // Both carry an exact option; the resolved one was matched
                // against choices the page really offered.
                true
              : action.confidence >= 0.8);
      return { ...action, approved: approved && canApprove };
    }),
  );
}

export function approveSafeActions(plan: DeterministicFillPlan): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) => ({
      ...action,
      // "Resolve safe fields" approves only what is grounded, unambiguous, and
      // non-sensitive. A sensitive answer is never bulk-approved.
      approved:
        isExecutable(action) &&
        action.confidence >= 0.8 &&
        !action.requiresReview &&
        !action.sensitive &&
        action.source !== 'ai_suggestion',
    })),
  );
}

export function updateActionOverride(
  plan: DeterministicFillPlan,
  field: DetectedField,
  actionId: string,
  value: string | string[] | boolean,
): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) => {
      if (action.id !== actionId) return action;
      const match = matchField(field, {} as Profile, [], value);
      return {
        ...actionFor(field, match),
        ...(action.matchHint ? { matchHint: action.matchHint } : {}),
        originalMatch: action.originalMatch,
      };
    }),
  );
}

export function resetActionOverride(
  plan: DeterministicFillPlan,
  field: DetectedField,
  actionId: string,
): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) =>
      action.id === actionId && action.originalMatch
        ? {
            ...actionFor(field, action.originalMatch),
            // The saved location the plan was built with survives a reset; it is
            // profile data, not part of the edit being undone.
            ...(action.matchHint ? { matchHint: action.matchHint } : {}),
          }
        : action,
    ),
  );
}

export function skipAction(plan: DeterministicFillPlan, actionId: string): DeterministicFillPlan {
  return withActions(
    plan,
    plan.actions.map((action) =>
      action.id === actionId
        ? {
            ...action,
            action: 'skip' as const,
            approved: false,
            requiresReview: false,
            reason: 'Skipped explicitly by the user.',
          }
        : action,
    ),
  );
}
