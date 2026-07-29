import {
  CANONICAL_QUESTION_SECTIONS,
  type CanonicalQuestion,
  type FieldSection,
} from '../constants/questions.js';

/**
 * Reduces a label to a comparable form: lowercase, no punctuation, no required
 * marker, single spaces. "Legal First Name *" and "legal  first-name" both
 * become "legal first name".
 */
export function normalizeLabel(raw: string): string {
  return (
    raw
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .toLowerCase()
      // Required markers and the noise around them.
      .replace(/\(\s*required\s*\)|\brequired\b|\(\s*optional\s*\)|\boptional\b/g, ' ')
      .replace(/[*✱]/g, ' ')
      .replace(/[_-]+/g, ' ')
      .replace(/[^\p{L}\p{N}\s'/]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

interface Rule {
  question: CanonicalQuestion;
  /** Matched against the normalized label. First match wins. */
  patterns: RegExp[];
}

/**
 * Ordered most-specific first. "first name" must beat "name", and
 * "linkedin profile" must beat the generic "profile" rule, so ordering carries
 * real meaning here.
 */
const RULES: readonly Rule[] = [
  // Links — before name/profile rules, since they often say "profile".
  { question: 'linkedin', patterns: [/\blinked ?in\b/] },
  { question: 'github', patterns: [/\bgit ?hub\b/] },
  {
    question: 'portfolio',
    patterns: [
      /\bportfolio\b(?!.*\b(upload|attach|file|document)\b)/,
      /\bdribbble\b/,
      /\bbehance\b/,
    ],
  },
  {
    question: 'website',
    patterns: [/\bpersonal (web ?site|page|url)\b/, /\bweb ?site\b/, /\bblog\b/],
  },

  // Documents — before the generic name rules ("resume name").
  { question: 'resume', patterns: [/\bresume\b/, /\bcv\b/, /\bcurriculum vitae\b/] },
  { question: 'cover_letter', patterns: [/\bcover ?letter\b/] },
  { question: 'transcript', patterns: [/\btranscript\b/] },
  {
    question: 'portfolio_document',
    patterns: [/\bportfolio\b.*\b(upload|attach|file|document)\b/],
  },

  // Identity
  {
    question: 'first_name',
    patterns: [/\b(first|given|fore)\s?name\b/, /\bname first\b/],
  },
  { question: 'middle_name', patterns: [/\bmiddle (name|initial)\b/] },
  {
    question: 'last_name',
    patterns: [/\b(last|family|sur)\s?name\b/, /\bsurname\b/, /\bname last\b/],
  },
  { question: 'preferred_name', patterns: [/\b(preferred|nick|chosen|goes by)\s?name\b/] },
  { question: 'pronouns', patterns: [/\bpronouns?\b/] },
  { question: 'full_name', patterns: [/\b(full|legal|your) name\b/, /^name$/] },

  // Contact
  { question: 'email', patterns: [/\be ?mail\b/] },
  // Before both `phone` and `country`: a "Phone country code" control is neither
  // the phone number nor the address country, and matching it as either fills
  // the wrong box.
  {
    question: 'phone_country_code',
    patterns: [/\bcountry code\b/, /\bdial(l)?ing code\b/, /\bphone code\b/, /\bcalling code\b/],
  },
  { question: 'phone', patterns: [/\b(phone|mobile|cell|telephone)\b/] },
  {
    question: 'address_line2',
    patterns: [/\baddress (line )?2\b/, /\b(apt|apartment|suite|unit)\b/],
  },
  {
    question: 'address_line1',
    patterns: [/\baddress (line )?1\b/, /\bstreet address\b/, /^address$/, /\bmailing address\b/],
  },
  // A single combined location control ("Location (City)", "Current location")
  // wants "Clifton, New Jersey, United States", not the bare city. It must beat
  // the `city` rule, whose pattern it also contains.
  {
    question: 'current_location',
    patterns: [
      /^location( city)?$/,
      /\bcurrent location\b/,
      /\blocation\b.*\bcity\b/,
      /\bcity\b.*\bstate\b.*\bcountry\b/,
      /\bwhere are you (currently )?(located|based)\b/,
    ],
  },
  { question: 'city', patterns: [/\b(city|town)\b/] },
  { question: 'state', patterns: [/\b(state|province|region)\b/] },
  { question: 'postal_code', patterns: [/\b(zip|postal)\s?code\b/, /\bpostcode\b/, /^zip$/] },
  { question: 'country', patterns: [/\bcountry\b/] },

  // Education
  { question: 'school', patterns: [/\b(school|university|college|institution)\b/] },
  { question: 'degree', patterns: [/\bdegree\b/, /\blevel of education\b/] },
  { question: 'major', patterns: [/\b(major|discipline|field of study|concentration)\b/] },
  { question: 'minor', patterns: [/\bminor\b/] },
  { question: 'gpa', patterns: [/\bgpa\b/, /\bgrade point average\b/] },
  {
    question: 'graduation_date',
    patterns: [/\b(graduation|grad)\b.*\b(date|year|month)\b/, /\bend date\b.*\beducation\b/],
  },
  { question: 'education_start_date', patterns: [/\bstart date\b.*\b(school|education)\b/] },

  // Experience
  { question: 'employer', patterns: [/\b(employer|company name|organization)\b/] },
  { question: 'job_title', patterns: [/\b(job|position|role)\s?title\b/, /^title$/] },
  { question: 'years_of_experience', patterns: [/\byears? of (relevant )?experience\b/] },
  {
    question: 'employment_start_date',
    patterns: [/^(?!.*\b(earliest|available|availability|when can you)\b).*\bstart date\b/],
  },
  { question: 'employment_end_date', patterns: [/\bend date\b/] },

  // Eligibility
  {
    question: 'work_authorization',
    patterns: [
      /\b(legally )?authoriz(ed|ation) to work\b/,
      /\bwork authoriz(ed|ation)\b/,
      /\beligible to work\b/,
      /\bright to work\b/,
    ],
  },
  {
    question: 'sponsorship_required',
    patterns: [/\bsponsor(ship)?\b/, /\bvisa\b.*\b(require|need|support)\b/],
  },
  { question: 'citizenship', patterns: [/\bcitizen(ship)?\b/, /\bnationality\b/] },
  { question: 'willing_to_relocate', patterns: [/\brelocat(e|ion)\b/] },
  { question: 'willing_to_travel', patterns: [/\btravel\b/] },
  { question: 'drivers_license', patterns: [/\bdriver'?s? licen[cs]e\b/] },
  {
    question: 'minimum_age',
    patterns: [/\b(at least|over|older than) \d{2}\b/, /\bage requirement\b/],
  },
  {
    question: 'earliest_start_date',
    patterns: [
      /\b(earliest|available|availability|when can you) start\b/,
      /\bstart date\b.*\bavailab/,
    ],
  },
  {
    question: 'internship_availability',
    patterns: [
      /\bavailable\b.*\binternship\b/,
      /\binternship\b.*\bavailab/,
      /\bfull[- ]time\b.*\b(?:summer|internship)\b/,
    ],
  },
  { question: 'notice_period', patterns: [/\bnotice period\b/] },

  // Demographics
  { question: 'gender', patterns: [/\bgender\b/, /\bsex\b/] },
  {
    question: 'race_ethnicity',
    // "Are you Hispanic/Latino?" is an ethnicity question that names neither
    // "race" nor "ethnicity", so it needs its own patterns to be caught.
    patterns: [/\brace\b/, /\bethnic(ity)?\b/, /\bhispanic\b/, /\blatin[aox]\b/],
  },
  { question: 'veteran_status', patterns: [/\bveteran\b/, /\bmilitary service\b/] },
  { question: 'disability_status', patterns: [/\bdisabilit(y|ies)\b/] },
  { question: 'sexual_orientation', patterns: [/\bsexual orientation\b/] },
  { question: 'criminal_history', patterns: [/\b(criminal|felony|convicted|conviction)\b/] },
  { question: 'security_clearance', patterns: [/\b(security )?clearance\b/] },
  {
    question: 'salary_expectation',
    patterns: [
      /\b(salary|compensation|pay)\b.*\b(expect|requirement|desired|range)\b/,
      /\bdesired salary\b/,
      /\bexpected (salary|compensation)\b/,
    ],
  },

  // Open-ended
  {
    question: 'why_this_company',
    patterns: [
      /\bwhy\b.*\b(work (at|for)|join|interested in)\b.*\b(us|company|our)\b/,
      /\bwhy (do you want to work|our company)\b/,
    ],
  },
  {
    question: 'why_this_role',
    patterns: [
      /\bwhy\b.*\b(this|the) (role|position|job)\b/,
      /\binterest(ed)? in (this|the) (role|position)\b/,
    ],
  },
  {
    question: 'how_did_you_hear',
    patterns: [/\bhow did you (hear|find)\b/, /\bwhere did you hear\b/],
  },
  { question: 'referral', patterns: [/\brefer(red|ral)\b/] },
  {
    question: 'additional_information',
    patterns: [
      /\badditional (information|comments|details)\b/,
      /\banything else\b/,
      /\bother comments\b/,
    ],
  },
];

export interface QuestionMatch {
  question: CanonicalQuestion;
  /**
   * How much to trust the mapping: 1 for a rule hit, 0 when nothing matched.
   * The scanner combines this with its own signals.
   */
  confidence: number;
}

/**
 * Maps a human label to a canonical question. Returns `unknown` with zero
 * confidence rather than guessing when nothing matches — an unrecognized
 * question is reported as unrecognized.
 */
export function matchCanonicalQuestion(rawLabel: string): QuestionMatch {
  const normalized = normalizeLabel(rawLabel);
  if (normalized.length === 0) return { question: 'unknown', confidence: 0 };

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalized)) {
        return { question: rule.question, confidence: 1 };
      }
    }
  }

  return { question: 'unknown', confidence: 0 };
}

/** Default section for a canonical question. */
export function sectionForQuestion(question: CanonicalQuestion): FieldSection {
  return CANONICAL_QUESTION_SECTIONS[question];
}

const SECTION_HEADING_RULES: ReadonlyArray<{ section: FieldSection; pattern: RegExp }> = [
  {
    section: 'personal_information',
    pattern: /\b(personal|about you|your (details|information)|basic info)\b/,
  },
  { section: 'contact_information', pattern: /\b(contact|address|reach you)\b/ },
  { section: 'education', pattern: /\b(education|academic|school)\b/ },
  { section: 'experience', pattern: /\b(experience|employment|work history|career)\b/ },
  { section: 'projects', pattern: /\bprojects?\b/ },
  { section: 'skills', pattern: /\bskills?\b/ },
  { section: 'documents', pattern: /\b(documents?|attachments?|resume|cv|upload)\b/ },
  {
    section: 'eligibility',
    pattern: /\b(eligibility|authorization|work status|legal|availability)\b/,
  },
  {
    section: 'demographics',
    pattern:
      /\b(demographic|diversity|equal (employment )?opportunity|eeo|voluntary (self.?identification|disclosure)|self.?identif)\b/,
  },
  {
    section: 'additional_questions',
    pattern: /\b(additional|other|custom|application) questions?\b/,
  },
];

/** Maps a heading or fieldset legend to a section, or null when unrecognized. */
export function sectionFromHeading(heading: string): FieldSection | null {
  const normalized = normalizeLabel(heading);
  if (normalized.length === 0) return null;

  for (const rule of SECTION_HEADING_RULES) {
    if (rule.pattern.test(normalized)) return rule.section;
  }
  return null;
}
