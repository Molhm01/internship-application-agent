/**
 * Canonical question identifiers. The scanner reduces a page's wording to one of
 * these so later milestones can match a question to profile data without caring
 * whether the form said "Legal First Name", "Given Name", or "First name*".
 *
 * `unknown` is a legitimate outcome, not a failure: an unrecognized question is
 * still scanned and reported, it just carries no canonical meaning yet.
 */
export const CANONICAL_QUESTIONS = [
  // Identity
  'first_name',
  'middle_name',
  'last_name',
  // A form that asks the applicant to confirm they have no middle name is a
  // different question from the middle-name box, and a blank cannot answer it.
  'no_middle_name',
  'name_suffix',
  'full_name',
  'preferred_name',
  'pronouns',
  // Contact
  'email',
  'phone',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'country',
  'current_location',
  // The nearest metropolitan area, which Taleo and iCIMS ask for and which is
  // routinely not the city of residence.
  'metro_region',
  'phone_country_code',
  // Which *kind* of phone or address a repeating contact block is recording.
  // Structural facts about the form, not facts about the applicant, and
  // meaningless without the section they sit under.
  'phone_type',
  'address_type',
  /** The employer-portal account identifier, distinct from the email. */
  'account_username',
  // Links
  'linkedin',
  'github',
  'portfolio',
  'website',
  // Education
  'school',
  'degree',
  'major',
  'minor',
  'gpa',
  'degree_level',
  // The *kind* of institution — High School, College/University, Trade School —
  // which is not the degree, not its level, and not the subject. Conflating it
  // with `degree_level` is why an "Education Type" control offering
  // institution kinds was matched against "Bachelor's Degree" and left unset.
  'education_type',
  // Whether the qualification was actually awarded. Distinct from
  // `graduation_date`: a form asking "Graduated?" wants Yes or No, and offering
  // it a date matched no option on any list.
  'graduated',
  // "Are you currently a university student?" — a fact about enrolment now,
  // answered from an active education record and from nothing else.
  'education_status',
  /**
   * "Will you be enrolled during the internship?" — a claim about a future term,
   * which stored start and graduation dates do not prove. Its own question, so
   * it can never be answered from the current-enrolment fact beside it.
   */
  'enrolled_during_internship',
  'education_start_date',
  'graduation_date',
  // Some forms split graduation into two controls; each is its own question so
  // a month picker is never handed a year and vice versa.
  'graduation_month',
  'graduation_year',
  // Distinct from 'degree', which is what the applicant is currently pursuing.
  'highest_degree_awarded',
  // Experience
  'employer',
  'job_title',
  // Where a *past job* was, which is not where the applicant lives. Filling the
  // saved home address into it is how "Work-experience location = Clifton, NJ"
  // became the only thing an entire run managed to write.
  'experience_location',
  'currently_employed',
  'responsibilities',
  'employment_start_date',
  'employment_end_date',
  // Structured facts about one past job that the profile records per role.
  // Without these the controls were unnamed: "Employment Type" and "Reason for
  // Leaving" resolved to no canonical question at all, so the planner reported
  // them as waiting on an analysis that had nothing to say about them, and they
  // sat at "No Selection" on every run.
  'employment_type',
  'reason_for_leaving',
  'years_of_experience',
  // Free-text summaries of prior work and prior projects, distinct from the
  // structured employer/title controls above.
  'employment_history',
  'project_experience',
  // The structured columns a repeating Projects block asks for, distinct from
  // the free-text 'project_experience' summary above. Without these a Projects
  // section had no questions at all, so no saved project could reach one.
  'project_name',
  'project_role',
  'project_description',
  'project_technologies',
  'project_url',
  'project_start_date',
  'project_end_date',
  // Documents
  'resume',
  'cover_letter',
  'transcript',
  'portfolio_document',
  // Eligibility
  'work_authorization',
  'sponsorship_required',
  'citizenship',
  'willing_to_relocate',
  'willing_to_travel',
  'drivers_license',
  'minimum_age',
  'earliest_start_date',
  'internship_availability',
  'onsite_availability',
  'hybrid_availability',
  'remote_availability',
  'notice_period',
  // Demographics and other sensitive questions
  'gender',
  'race_ethnicity',
  'veteran_status',
  'disability_status',
  'sexual_orientation',
  'hispanic_latino',
  // Asked separately from gender on real forms ("Do you identify as
  // transgender?"), and never answerable from a gender answer.
  'transgender',
  'religion',
  'medical_information',
  'criminal_history',
  'security_clearance',
  'salary_expectation',
  'salary_minimum',
  // Open-ended
  'why_this_company',
  'why_this_role',
  'additional_information',
  'how_did_you_hear',
  'referral',
  'referral_source',
  'employee_referral',
  'referral_name',
  'referral_email',
  'referral_relationship',
  // Facts about the applicant's relationship with this one employer. None has a
  // profile-wide default, and an unanswered one becomes a question for the user.
  'previously_employed',
  'previously_applied',
  'previously_interviewed',
  'family_member_employed',
  // "Are you under any contract or employment restriction with a current or
  // previous employer?" — a legal fact about the applicant's own agreements
  // that no profile field states. It carried the word "employer", so it matched
  // the `employer` question and the planner offered a company *name* to a
  // Yes/No control, which the page refused and the report called a failed
  // autofill. It is its own question, and it is never answered from inference.
  'employment_restriction',
  // Opt-in only, and never ticked from silence.
  'marketing_text_consent',
  // Which locations and which industry the applicant is interested in.
  'preferred_locations',
  'industry',
  'recruiting_event',
  'job_board_source',
  'terms_attestation',
  'signature',
  // Written-answer categories. Classifying these separately lets a generated
  // answer be grounded in the right evidence — an achievement question needs
  // experience, a teamwork question needs projects — instead of one
  // undifferentiated "custom" bucket.
  'achievements',
  'leadership',
  'teamwork',
  'challenge',
  'goals',
  'technical_skills',
  'custom_written_answer',
  'other_custom',
  'unknown',
] as const;

export type CanonicalQuestion = (typeof CANONICAL_QUESTIONS)[number];

/** Sections a question can belong to, in the order a review screen shows them. */
export const FIELD_SECTIONS = [
  'personal_information',
  'contact_information',
  'education',
  'experience',
  'projects',
  'skills',
  'documents',
  'eligibility',
  'demographics',
  'additional_questions',
  'other',
] as const;

export type FieldSection = (typeof FIELD_SECTIONS)[number];

export const FIELD_SECTION_LABELS: Record<FieldSection, string> = {
  personal_information: 'Personal Information',
  contact_information: 'Contact Information',
  education: 'Education',
  experience: 'Experience',
  projects: 'Projects',
  skills: 'Skills',
  documents: 'Documents',
  eligibility: 'Eligibility',
  demographics: 'Demographics',
  additional_questions: 'Additional Questions',
  other: 'Other',
};

/** Where a canonical question belongs when the page gives no section heading. */
export const CANONICAL_QUESTION_SECTIONS: Record<CanonicalQuestion, FieldSection> = {
  first_name: 'personal_information',
  middle_name: 'personal_information',
  no_middle_name: 'personal_information',
  name_suffix: 'personal_information',
  last_name: 'personal_information',
  full_name: 'personal_information',
  preferred_name: 'personal_information',
  pronouns: 'personal_information',

  email: 'contact_information',
  phone: 'contact_information',
  address_line1: 'contact_information',
  address_line2: 'contact_information',
  metro_region: 'contact_information',
  city: 'contact_information',
  state: 'contact_information',
  postal_code: 'contact_information',
  country: 'contact_information',
  current_location: 'contact_information',
  phone_country_code: 'contact_information',
  phone_type: 'contact_information',
  account_username: 'personal_information',
  address_type: 'contact_information',

  linkedin: 'contact_information',
  github: 'contact_information',
  portfolio: 'contact_information',
  website: 'contact_information',

  school: 'education',
  degree: 'education',
  major: 'education',
  minor: 'education',
  gpa: 'education',
  degree_level: 'education',
  education_type: 'education',
  graduated: 'education',
  education_status: 'education',
  enrolled_during_internship: 'education',
  education_start_date: 'education',
  graduation_date: 'education',
  graduation_month: 'education',
  graduation_year: 'education',
  highest_degree_awarded: 'education',

  employer: 'experience',
  experience_location: 'experience',
  currently_employed: 'experience',
  responsibilities: 'experience',
  job_title: 'experience',
  employment_start_date: 'experience',
  employment_end_date: 'experience',
  employment_type: 'experience',
  reason_for_leaving: 'experience',
  years_of_experience: 'experience',
  employment_history: 'experience',
  project_experience: 'projects',
  project_name: 'projects',
  project_role: 'projects',
  project_description: 'projects',
  project_technologies: 'projects',
  project_url: 'projects',
  project_start_date: 'projects',
  project_end_date: 'projects',

  resume: 'documents',
  cover_letter: 'documents',
  transcript: 'documents',
  portfolio_document: 'documents',

  work_authorization: 'eligibility',
  sponsorship_required: 'eligibility',
  citizenship: 'eligibility',
  willing_to_relocate: 'eligibility',
  willing_to_travel: 'eligibility',
  drivers_license: 'eligibility',
  minimum_age: 'eligibility',
  earliest_start_date: 'eligibility',
  internship_availability: 'eligibility',
  onsite_availability: 'eligibility',
  hybrid_availability: 'eligibility',
  remote_availability: 'eligibility',
  notice_period: 'eligibility',

  gender: 'demographics',
  race_ethnicity: 'demographics',
  veteran_status: 'demographics',
  disability_status: 'demographics',
  sexual_orientation: 'demographics',
  hispanic_latino: 'demographics',
  transgender: 'demographics',
  religion: 'demographics',
  medical_information: 'demographics',
  criminal_history: 'demographics',
  security_clearance: 'demographics',
  salary_expectation: 'demographics',
  salary_minimum: 'additional_questions',

  why_this_company: 'additional_questions',
  why_this_role: 'additional_questions',
  additional_information: 'additional_questions',
  how_did_you_hear: 'additional_questions',
  referral: 'additional_questions',
  referral_name: 'additional_questions',
  referral_email: 'additional_questions',
  referral_relationship: 'additional_questions',
  previously_employed: 'additional_questions',
  previously_applied: 'additional_questions',
  previously_interviewed: 'additional_questions',
  family_member_employed: 'additional_questions',
  employment_restriction: 'additional_questions',
  marketing_text_consent: 'additional_questions',
  preferred_locations: 'additional_questions',
  industry: 'additional_questions',
  referral_source: 'additional_questions',
  employee_referral: 'additional_questions',
  recruiting_event: 'additional_questions',
  job_board_source: 'additional_questions',
  terms_attestation: 'other',
  signature: 'other',
  achievements: 'additional_questions',
  leadership: 'additional_questions',
  teamwork: 'additional_questions',
  challenge: 'additional_questions',
  goals: 'additional_questions',
  technical_skills: 'skills',
  custom_written_answer: 'additional_questions',
  other_custom: 'additional_questions',

  unknown: 'other',
};

/**
 * Alternative names for questions this taxonomy already carries, so a spec, an
 * imported preset, or a website field can name a question its own way and still
 * resolve to one canonical identifier.
 *
 * These are renames, not new concepts — adding a second identifier for the same
 * question would let two parts of the system answer it differently.
 */
export const CANONICAL_QUESTION_ALIASES: Readonly<Record<string, CanonicalQuestion>> = {
  address: 'address_line1',
  state_region: 'state',
  region: 'state',
  cv: 'resume',
  enrollment_status: 'education_status',
  current_student: 'education_status',
  currently_enrolled: 'education_status',
  highest_completed_degree: 'highest_degree_awarded',
  current_degree: 'degree',
  degree_type: 'degree',
  expected_graduation_date: 'graduation_date',
  how_heard: 'how_did_you_hear',
  job_board: 'job_board_source',
  event_source: 'recruiting_event',
  race: 'race_ethnicity',
  ethnicity: 'race_ethnicity',
  veteran: 'veteran_status',
  disability: 'disability_status',
  medical: 'medical_information',
  salary: 'salary_expectation',
  legal_attestation: 'terms_attestation',
  sponsorship: 'sponsorship_required',
  relocation: 'willing_to_relocate',
  availability: 'internship_availability',
  start_date: 'earliest_start_date',
  onsite: 'onsite_availability',
  hybrid: 'hybrid_availability',
  remote: 'remote_availability',
  why_company: 'why_this_company',
  why_role: 'why_this_role',
  project: 'custom_written_answer',
  work_history: 'employment_history',
  projects: 'project_experience',
  grad_month: 'graduation_month',
  grad_year: 'graduation_year',
};

/** Resolves any accepted spelling of a question to its canonical identifier. */
export function canonicalQuestionFor(name: string): CanonicalQuestion | null {
  const key = name.trim().toLowerCase();
  if ((CANONICAL_QUESTIONS as readonly string[]).includes(key)) return key as CanonicalQuestion;
  return CANONICAL_QUESTION_ALIASES[key] ?? null;
}

/** Canonical questions the sensitive-answer policy applies to. */
export const SENSITIVE_CANONICAL_QUESTIONS: readonly CanonicalQuestion[] = [
  'gender',
  'race_ethnicity',
  'veteran_status',
  'disability_status',
  'sexual_orientation',
  'criminal_history',
  'security_clearance',
  'salary_expectation',
  'citizenship',
  'sponsorship_required',
  'hispanic_latino',
  'transgender',
  'religion',
  'medical_information',
];
