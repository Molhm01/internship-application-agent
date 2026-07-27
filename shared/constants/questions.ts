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
  'education_start_date',
  'graduation_date',
  // Experience
  'employer',
  'job_title',
  'employment_start_date',
  'employment_end_date',
  'years_of_experience',
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
  'notice_period',
  // Demographics and other sensitive questions
  'gender',
  'race_ethnicity',
  'veteran_status',
  'disability_status',
  'sexual_orientation',
  'criminal_history',
  'security_clearance',
  'salary_expectation',
  // Open-ended
  'why_this_company',
  'why_this_role',
  'additional_information',
  'how_did_you_hear',
  'referral',
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
  last_name: 'personal_information',
  full_name: 'personal_information',
  preferred_name: 'personal_information',
  pronouns: 'personal_information',

  email: 'contact_information',
  phone: 'contact_information',
  address_line1: 'contact_information',
  address_line2: 'contact_information',
  city: 'contact_information',
  state: 'contact_information',
  postal_code: 'contact_information',
  country: 'contact_information',

  linkedin: 'contact_information',
  github: 'contact_information',
  portfolio: 'contact_information',
  website: 'contact_information',

  school: 'education',
  degree: 'education',
  major: 'education',
  minor: 'education',
  gpa: 'education',
  education_start_date: 'education',
  graduation_date: 'education',

  employer: 'experience',
  job_title: 'experience',
  employment_start_date: 'experience',
  employment_end_date: 'experience',
  years_of_experience: 'experience',

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
  notice_period: 'eligibility',

  gender: 'demographics',
  race_ethnicity: 'demographics',
  veteran_status: 'demographics',
  disability_status: 'demographics',
  sexual_orientation: 'demographics',
  criminal_history: 'demographics',
  security_clearance: 'demographics',
  salary_expectation: 'demographics',

  why_this_company: 'additional_questions',
  why_this_role: 'additional_questions',
  additional_information: 'additional_questions',
  how_did_you_hear: 'additional_questions',
  referral: 'additional_questions',

  unknown: 'other',
};

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
];
