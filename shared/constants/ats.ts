/**
 * Adapter identifiers. Only `generic` has an implementation planned for the
 * early milestones; the rest are listed so detection, reporting, and the
 * documentation share one vocabulary.
 */
export const ATS_IDS = [
  'generic',
  'greenhouse',
  'lever',
  'workday',
  'ashby',
  'icims',
  'smartrecruiters',
  'successfactors',
  'taleo',
  'oracle',
  'unknown',
] as const;

export type AtsId = (typeof ATS_IDS)[number];

export const ATS_DISPLAY_NAMES: Record<AtsId, string> = {
  generic: 'Generic HTML form',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workday: 'Workday',
  ashby: 'Ashby',
  icims: 'iCIMS',
  smartrecruiters: 'SmartRecruiters',
  successfactors: 'SAP SuccessFactors',
  taleo: 'Oracle Taleo',
  oracle: 'Oracle Recruiting Cloud',
  unknown: 'Not detected',
};

/** Questions in these categories can never be answered by inference. */
export const SENSITIVE_CATEGORIES = [
  'race',
  'ethnicity',
  'gender',
  'disability',
  'veteran_status',
  'religion',
  'sexual_orientation',
  'citizenship',
  'sponsorship',
  'criminal_history',
  'medical',
  'salary_expectation',
  'security_clearance',
] as const;

export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

export const SENSITIVE_POLICIES = [
  'approved_auto_fill',
  'review_required',
  'decline_to_answer',
  'leave_blank',
] as const;

export type SensitivePolicy = (typeof SENSITIVE_POLICIES)[number];

/** Absent an explicit policy, a sensitive question always goes to review. */
export const DEFAULT_SENSITIVE_POLICY: SensitivePolicy = 'review_required';
