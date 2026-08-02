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
  {
    question: 'cover_letter',
    patterns: [/\bcover(ing)? ?letter\b/, /\bmotivation letter\b/],
  },
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
  {
    question: 'preferred_name',
    patterns: [
      /\b(preferred|nick|chosen|goes by)\s?name\b/,
      /\bwhat (should|do) we call you\b/,
      /\bwhat name do you go by\b/,
    ],
  },
  { question: 'pronouns', patterns: [/\bpronouns?\b/] },
  { question: 'full_name', patterns: [/\b(full|legal|your) name\b/, /^name$/] },

  // Right to work. Before Contact: "permission to work in the country of
  // employment" names a country and is not the address-country question.
  {
    question: 'work_authorization',
    patterns: [
      /\b(legally )?authoriz(ed|ation) to work\b/,
      /\bwork authoriz(ed|ation)\b/,
      /\beligible to work\b/,
      /\bwork eligibility\b/,
      /\bright to work\b/,
      // Equivalent wordings employers actually use. Each asks the same thing as
      // "Are you legally authorized to work?" and must reach the same saved
      // fact rather than falling through as an unrecognized question.
      /\bpermission to work\b/,
      /\b(legally )?permitted to work\b/,
      /\bemployment eligibilit(y|ies)\b/,
      /\beligibility to work\b/,
      /\bwork (lawfully|legally)\b/,
      /\blegal(ly)? (able|entitled) to work\b/,
      /\bwork permit\b(?!.*\bsponsor)/,
    ],
  },
  {
    question: 'sponsorship_required',
    patterns: [
      /\bsponsor(ship|ing|ed)?\b/,
      /\bvisa\b.*\b(require|need|support|status)\b/,
      /\b(require|need)\b.*\bvisa\b/,
      /\bimmigration (support|status|sponsorship)\b/,
      /\bh1 ?b\b/,
      /\bemployment authorization\b.*\b(sponsor|support)\b/,
    ],
  },
  { question: 'citizenship', patterns: [/\bcitizen(ship)?\b/, /\bnationality\b/] },

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
  // Split graduation controls, before the combined rule they would otherwise hit.
  {
    question: 'graduation_month',
    patterns: [/\b(graduation|grad|completion)\b.*\bmonth\b/, /\bmonth of graduation\b/],
  },
  {
    question: 'graduation_year',
    patterns: [/\b(graduation|grad|completion)\b.*\byear\b/, /\byear of graduation\b/],
  },
  {
    question: 'graduation_date',
    patterns: [
      /\b(graduation|grad)\b.*\b(date|year|month)\b/,
      /\bend date\b.*\beducation\b/,
      /\b(expected|anticipated) (completion|graduation)\b/,
    ],
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
  {
    question: 'employment_history',
    patterns: [
      /\b(work|employment|professional) (history|experience)\b/,
      /\bprevious (roles?|positions?|employers?)\b/,
      /\bdescribe your (work|professional) experience\b/,
    ],
  },
  {
    question: 'project_experience',
    patterns: [
      /\b(relevant |personal |notable )?projects?\b.*\b(describe|tell us|worked on|built)\b/,
      /\b(describe|tell us about)\b.*\bprojects?\b/,
      /\bproject experience\b/,
    ],
  },

  // Eligibility
  { question: 'willing_to_relocate', patterns: [/\brelocat(e|ion)\b/, /\bwilling to move\b/] },
  { question: 'willing_to_travel', patterns: [/\btravel\b/] },
  {
    question: 'remote_availability',
    patterns: [
      /\b(work|working)\b.*\bremotely\b/,
      /\bremote (work|position|role)\b/,
      /\bwork from home\b/,
    ],
  },
  { question: 'onsite_availability', patterns: [/\b(on ?site|in ?person|in office)\b/] },
  { question: 'hybrid_availability', patterns: [/\bhybrid\b/] },
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
      // "When are you available to start?" — the words are separated, which the
      // adjacent-word patterns above miss.
      /\b(available|availability)\b.*\bto start\b/,
      /\bwhen (are|can|could|would|will) you\b.*\bstart\b/,
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

  // Demographics.
  // Transgender status is its own question and must beat the gender rule: a
  // gender answer never answers it, and vice versa.
  {
    question: 'transgender',
    patterns: [/\btransgender\b/, /\btrans\b/, /\bgender identity\b.*\btrans/],
  },
  // Hispanic/Latino is asked as its own question on US forms, separately from
  // the race list, so it gets its own canonical identifier.
  { question: 'hispanic_latino', patterns: [/\bhispanic\b/, /\blatin[aox]\b/] },
  { question: 'gender', patterns: [/\bgender\b/, /\bsex\b/] },
  {
    question: 'race_ethnicity',
    patterns: [/\brace\b/, /\bethnic(ity)?\b/],
  },
  { question: 'veteran_status', patterns: [/\bveteran\b/, /\bmilitary service\b/] },
  { question: 'disability_status', patterns: [/\bdisabilit(y|ies)\b/] },
  { question: 'sexual_orientation', patterns: [/\bsexual orientation\b/] },
  { question: 'criminal_history', patterns: [/\b(criminal|felony|convicted|conviction)\b/] },
  { question: 'security_clearance', patterns: [/\b(security )?clearance\b/] },
  {
    question: 'salary_expectation',
    patterns: [
      // `expect\w*` so "salary expectations" matches as readily as "expected
      // salary"; a trailing word boundary after "expect" caught neither.
      /\b(salary|compensation|pay)\b.*\b(expect\w*|requirement\w*|desired|range)\b/,
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
  // Written-answer categories, so a generated answer can be grounded in the
  // right evidence rather than in the whole profile.
  {
    question: 'achievements',
    patterns: [
      /\b(greatest|proudest|significant|notable) (achievement|accomplishment)\b/,
      /\bachievements?\b/,
      /\baccomplishments?\b/,
    ],
  },
  {
    question: 'leadership',
    patterns: [/\bleadership\b/, /\bled a (team|project|group)\b/, /\btook the lead\b/],
  },
  {
    question: 'teamwork',
    patterns: [/\bteam ?work\b/, /\bwork(ed|ing)? (in|on|with) a team\b/, /\bcollaborat/],
  },
  {
    question: 'challenge',
    patterns: [
      /\b(difficult|challenging|hardest|toughest)\b.*\b(situation|problem|project|experience)\b/,
      /\bovercame?\b.*\b(obstacle|challenge)\b/,
      /\bchallenge you (have )?faced\b/,
    ],
  },
  {
    question: 'goals',
    patterns: [/\b(career|professional) goals?\b/, /\bwhere do you see yourself\b/],
  },
  {
    question: 'technical_skills',
    patterns: [
      /\btechnical skills\b/,
      /\bprogramming languages\b/,
      /\btechnologies\b.*\b(familiar|experience|proficient)\b/,
    ],
  },
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
 * Reference wordings for questions whose phrasing varies most between
 * employers. The rule table above is exact and cheap; this is the tier that
 * catches a rewording no pattern anticipated, scored rather than asserted.
 *
 * It never invents an answer — it only proposes which saved question a label is
 * probably asking about, at a confidence the caller can act on or ignore.
 */
const INTENT_PHRASES: ReadonlyArray<{ question: CanonicalQuestion; phrases: readonly string[] }> = [
  {
    question: 'work_authorization',
    phrases: [
      'are you legally authorized to work in the united states',
      'do you currently have permission to work in the country of employment',
      'can you provide evidence of employment eligibility',
      'are you able to provide proof of your right to work',
      'do you have the legal right to work in this country',
    ],
  },
  {
    question: 'sponsorship_required',
    phrases: [
      'will you now or in the future require sponsorship',
      'do you require visa sponsorship',
      'would the company need to sponsor your employment authorization',
      'do you need immigration support to work here',
    ],
  },
  {
    question: 'willing_to_relocate',
    phrases: [
      'are you willing to relocate for this position',
      'would you consider moving to the job location',
    ],
  },
  {
    question: 'earliest_start_date',
    phrases: [
      'when are you available to start',
      'what is your earliest possible start date',
      'how soon could you begin working',
    ],
  },
  {
    question: 'how_did_you_hear',
    phrases: [
      'how did you hear about this opportunity',
      'where did you find out about this role',
      'what brought you to this job posting',
    ],
  },
  {
    question: 'why_this_company',
    phrases: [
      'why do you want to work here',
      'what interests you about our company',
      'why are you interested in joining our team',
    ],
  },
  {
    question: 'why_this_role',
    phrases: [
      'why are you interested in this position',
      'what draws you to this particular role',
      'what motivates you to apply for this job',
    ],
  },
  {
    question: 'technical_skills',
    phrases: [
      'which programming languages are you proficient in',
      'describe your technical skills',
      'what technologies have you worked with',
    ],
  },
  {
    question: 'minimum_age',
    phrases: ['are you at least 18 years of age', 'do you meet the minimum age requirement'],
  },
  {
    question: 'drivers_license',
    phrases: ['do you hold a valid driver licence', 'do you have a current driving licence'],
  },
  {
    question: 'remote_availability',
    phrases: ['are you able to work remotely', 'would you be comfortable working from home'],
  },
  {
    question: 'referral',
    phrases: ['were you referred by a current employee', 'who referred you to this position'],
  },
];

/** Words that carry no distinguishing meaning in a question label. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'by',
  'can',
  'currently',
  'do',
  'does',
  'for',
  'from',
  'have',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'our',
  'please',
  'the',
  'this',
  'to',
  'us',
  'we',
  'what',
  'which',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

function contentTokens(value: string): Set<string> {
  return new Set(
    normalizeLabel(value)
      .split(' ')
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

/** Jaccard overlap of the meaningful words in two labels, 0…1. */
function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * The lowest overlap that still means "these ask the same thing". Below this a
 * label is reported as unrecognized rather than mapped to something close-ish.
 */
export const SEMANTIC_MATCH_THRESHOLD = 0.45;

/**
 * Scores a label against the reference wordings. Returns the best question and
 * its overlap, or `unknown` at zero when nothing is close enough.
 */
export function scoreQuestionIntent(rawLabel: string): QuestionMatch {
  const tokens = contentTokens(rawLabel);
  if (tokens.size === 0) return { question: 'unknown', confidence: 0 };

  let best: QuestionMatch = { question: 'unknown', confidence: 0 };
  for (const entry of INTENT_PHRASES) {
    for (const phrase of entry.phrases) {
      const score = overlap(tokens, contentTokens(phrase));
      if (score > best.confidence) best = { question: entry.question, confidence: score };
    }
  }
  return best.confidence >= SEMANTIC_MATCH_THRESHOLD
    ? best
    : { question: 'unknown', confidence: 0 };
}

/**
 * Maps a human label to a canonical question.
 *
 * Two tiers: the exact rule table first, then similarity against reference
 * wordings. Returns `unknown` with zero confidence rather than guessing when
 * neither is convincing — an unrecognized question is reported as unrecognized.
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

  return scoreQuestionIntent(normalized);
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
