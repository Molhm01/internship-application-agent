import {
  CANONICAL_QUESTION_SECTIONS,
  type CanonicalQuestion,
  type FieldSection,
} from '../constants/questions.js';
import { describesThirdPartyDetails } from './thirdPartyDetails.js';

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
  // "I have no middle name" is a checkbox, not the middle-name box, and it has
  // to beat the middle_name rule whose words it contains.
  {
    question: 'no_middle_name',
    patterns: [
      /\b(no|without|dont have|do not have)\b.*\bmiddle (name|initial)\b/,
      /\bmiddle (name|initial)\b.*\b(not applicable|n a|none)\b/,
    ],
  },
  { question: 'middle_name', patterns: [/\bmiddle (name|initial)\b/] },
  // Taleo writes "Name Suffix"; without this the last_name rule claims it.
  { question: 'name_suffix', patterns: [/\bsuffix\b/] },
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
      /\bname you go by\b/,
    ],
  },
  { question: 'pronouns', patterns: [/\bpronouns?\b/] },
  // The whole name in one box. Later steps of a Workday or iCIMS application
  // ask for it again as "Name as it appears on legal documents" or as the name
  // to type beside a signature, and neither wording contains "full name" — so
  // both fell through as unrecognized and the control stayed blank.
  {
    question: 'full_name',
    patterns: [
      /\b(full|legal|your) name\b/,
      /^name$/,
      /\bname as it appears\b/,
      /\bsignature name\b/,
      /\bname (of )?applicant\b/,
      /\bapplicant name\b/,
    ],
  },

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
  // A referral's email is the referral's, not the applicant's, and filling the
  // applicant's address into it would misidentify the person vouching for them.
  // It has to beat the generic email rule, so it sits above it rather than with
  // the other referral rules further down.
  {
    question: 'referral_email',
    patterns: [/\brefer(rer|ral|rals)?\b.*\be ?mail\b/, /\be ?mail\b.*\brefer(rer|ral)\b/],
  },
  // The portal account identifier. Before `email`, because plenty of sites
  // label it "Login / Email" and the account name is the more specific reading.
  {
    question: 'account_username',
    patterns: [
      /^login$/,
      /\buser ?name\b/,
      /\buser id\b/,
      /\blogin (id|name)\b/,
      /\baccount name\b/,
    ],
  },
  { question: 'email', patterns: [/\be ?mail\b/] },
  // Before both `phone` and `country`: a "Phone country code" control is neither
  // the phone number nor the address country, and matching it as either fills
  // the wrong box.
  {
    question: 'phone_country_code',
    patterns: [
      /\bcountry code\b/,
      /\bdial(l)?ing code\b/,
      /\bphone code\b/,
      /\bcalling code\b/,
      /\bcountry\/region code\b/,
      /\bintl?\.? code\b/,
      /\binternational code\b/,
      // Widget labels that name a country *beside* a phone control rather than
      // an address one: intl-tel-input and its imitators label the flag button
      // "Phone country", "Country for phone number", or just "Phone code".
      /\bphone country\b/,
      /\bcountry for (the )?phone\b/,
      // A bare "Code" is only this question when the surrounding text has
      // already established it is about a phone — the caller passes the label
      // plus its section heading, so "Phone Number / Code" resolves here while
      // an unrelated "Code" field stays unknown.
      /\b(phone|mobile|cell|telephone)\b[^a-z]{0,12}\bcode\b/,
      /\bcode\b[^a-z]{0,12}\b(phone|mobile|cell|telephone)\b/,
    ],
  },
  // Which kind of phone this is, not the number. Before `phone`, whose words it
  // contains: classifying it as `phone` offered the phone *number* to a dropdown
  // of Mobile / Home / Work, which never matched and left the field unanswered.
  {
    question: 'phone_type',
    patterns: [/\bphone (type|kind)\b/, /\btype of phone\b/, /\bphone number type\b/],
  },
  { question: 'phone', patterns: [/\b(phone|mobile|cell|telephone)\b/] },
  // Likewise for the address block's own "Type" control.
  {
    question: 'address_type',
    patterns: [/\baddress type\b/, /\btype of address\b/],
  },
  {
    question: 'address_line2',
    patterns: [
      /\baddress (line )?2\b/,
      // The secondary-address vocabulary in full. A floor or a building is the
      // same kind of fact as an apartment number, and a form that asks for one
      // was previously unrecognized — which made an optional second line look
      // like an unanswered required question.
      /\b(apt|apartment|suite|unit|floor|building)\b/,
    ],
  },
  {
    question: 'address_line1',
    patterns: [
      /\baddress (line )?1\b/,
      /\bstreet address\b/,
      /^address$/,
      /\bmailing address\b/,
      /\bprimary address\b/,
    ],
  },
  // Where a past job was. Before every personal-location rule, because those
  // contain the same word and one of them won: on the live page a work-history
  // "Location" matched `current_location` and was filled with the applicant's
  // home address — the single field an entire twenty-seven-field run managed to
  // write, and wrongly.
  {
    question: 'experience_location',
    patterns: [
      // Anchored to the employer, not to the word "job". "Job Location" on
      // Taleo is a multi-select of the locations the applicant *wants*, and
      // "Would you consider moving to the job location?" is a relocation
      // question — both must keep reaching their own rules, so neither
      // "job" nor a relocation phrasing may trigger this one.
      /^(?!.*\b(relocat|willing|prefer|desired|interested|consider|moving)\b).*\b(employer|company|workplace|office)\b.*\blocation\b/,
      /^(?!.*\b(relocat|willing|prefer|desired|interested|consider|moving)\b).*\blocation\b.*\b(employer|company)\b/,
      /\b(employment|work) (city|location)\b/,
    ],
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
  // The nearest metropolitan area is not the city of residence. Reading it as
  // one is how an unrelated location got chosen on Taleo.
  {
    question: 'metro_region',
    patterns: [
      /\bmetro(politan)?\b.*\b(area|region|market)\b/,
      /\b(closest|nearest|primary)\b.*\b(metro(politan)?|major city)\b/,
      /\bmetro(politan)?\b/,
    ],
  },
  // Country before state, and this ordering is the whole of the reported
  // "Country/Region of Residence stays blank" failure.
  //
  // The state rule accepts "region", and every Workday-shaped form spells the
  // country control "Country/Region" or "Country/Region of Residence". Tested
  // in the old order, the residence *country* matched `state` — so the planner
  // offered the saved "New Jersey" to a list of countries, found nothing,
  // deferred the field, and the state list it gates was never populated. One
  // misclassification, two blank controls.
  //
  // A genuine "State/Province/Region" control names no country, so it still
  // reaches the rule below.
  { question: 'country', patterns: [/\bcountry\b/] },
  { question: 'city', patterns: [/\b(city|town)\b/] },
  { question: 'state', patterns: [/\b(state|province|region)\b/] },
  { question: 'postal_code', patterns: [/\b(zip|postal)\s?code\b/, /\bpostcode\b/, /^zip$/] },

  // Education
  //
  // Enrolment first, and both enrolment questions before every degree rule.
  // "Are you pursuing a degree?" is a Yes/No about enrolment that contains the
  // word "degree"; classified as `degree` it was offered a degree *name*, which
  // no Yes/No control has ever accepted.
  //
  // "Will you be enrolled during the internship?" is separated from "Are you
  // enrolled now?" because stored dates prove the second and not the first, and
  // one canonical key for both would let a known fact answer an unknown one.
  {
    question: 'enrolled_during_internship',
    patterns: [
      /\b(enrolled|student|studying|in school)\b.*\b(during|throughout|for the duration of)\b.*\b(internship|co ?op|placement|program|term|summer)\b/,
      /\b(during|throughout)\b.*\b(internship|co ?op|placement)\b.*\b(enrolled|student|studying)\b/,
      /\bwill you (still )?be (a )?(enrolled|student)\b/,
      /\bwill you (be )?(remain|continue)\b.*\b(enrolled|student)\b/,
      /\breturn(ing)? to (school|university|college)\b.*\bafter\b/,
    ],
  },
  {
    question: 'education_status',
    patterns: [
      /\b(currently|presently|now)\b.*\b(a )?(university |college |full[- ]time |part[- ]time )?student\b/,
      /\bcurrent(ly)? (enrolled|enrolment|enrollment)\b/,
      /\b(are|am) you (currently )?enrolled\b/,
      /\bare you (currently )?(a )?(university |college )?student\b/,
      /\bare you (currently )?pursuing (a|an|your)\b.*\b(degree|program)\b/,
      /\b(enrolment|enrollment) status\b/,
      /\bstudent status\b/,
      /^current student$/,
    ],
  },
  // The education *dates*, before every rule that matches on the word "degree".
  //
  // Ordering is the whole of the graduation-date failure. "Anticipated Degree
  // Completion Date" contains "degree", so with the degree rules first it was
  // classified `degree`, and a date control was offered the name of a
  // qualification. Wordings that missed both rules fell through to `unknown`,
  // which the model tier is allowed to answer — and a model asked for a date
  // answers with today's.
  //
  // Split controls first, because each of them also satisfies the combined rule.
  {
    question: 'graduation_month',
    patterns: [
      /\b(graduation|grad|completion)\b.*\bmonth\b/,
      /\bmonth of graduation\b/,
      /\bmonth\b.*\b(graduat|complet)/,
    ],
  },
  {
    question: 'graduation_year',
    patterns: [
      /\b(graduation|grad|completion)\b.*\byear\b/,
      /\byear of graduation\b/,
      /\byear\b.*\b(graduat|complet)/,
    ],
  },
  {
    // Ahead of `graduation_date`, whose closing `/\bgraduat/` catch-all claims
    // anything containing the word — including a bare "Graduated?".
    //
    // That is what happened: a Yes/No control matched the graduation *date*
    // question, the planner offered it "May 2027", no option on the list said
    // that, and the run reported a failed autofill for a question the profile
    // answers plainly from the record's own completion status.
    question: 'graduated',
    // Deliberately only the yes/no wordings. "Degree Awarded" is *not* one of
    // them: "Highest Degree Awarded" asks which credential, not whether there
    // is one, and claiming that phrase here turned a degree dropdown into a
    // Yes/No question.
    patterns: [/^graduated\b/, /\bdid you graduate\b/, /\bhave you graduated\b/],
  },
  {
    question: 'graduation_date',
    patterns: [
      /\b(graduation|grad)\b.*\b(date|year|month)\b/,
      /\bend date\b.*\beducation\b/,
      // The two words are routinely *not* adjacent, which the old
      // `(expected|anticipated) (completion|graduation)` rule required.
      /\b(expected|anticipated|projected|planned)\b.*\b(completion|graduation|grad)\b/,
      /\b(degree|program|study|studies)\b.*\bcompletion\b/,
      /\bcompletion date\b/,
      /\bgraduat/,
    ],
  },
  {
    question: 'education_start_date',
    patterns: [
      /\bstart date\b.*\b(school|education|program|degree|university|college)\b/,
      /\b(school|education|program|degree|university|college)\b.*\bstart date\b/,
      /\benrol(l)?ment date\b/,
      /\bdate (of )?enrol/,
    ],
  },
  { question: 'school', patterns: [/\b(school|university|college|institution)\b/] },
  // "Highest degree awarded" and "the degree you are pursuing" are different
  // questions with different answers for anyone still studying.
  //
  // The `current` rule is tested first: "The highest degree you are currently
  // pursuing" wears the word "highest" and is still a question about now, and
  // answering it from the completed credential understates the applicant
  // exactly as answering the other one from the in-progress degree overstates
  // them.
  {
    question: 'degree',
    patterns: [
      /\b(current|currently)\b.*\b(degree|program|academic program|education program|qualification)\b/,
      /\b(degree|program)\b.*\b(current|currently|in progress|you are pursuing|being pursued)\b/,
      /\b(degree|program|qualification)\b.*\b(pursuing|studying|working towards?)\b/,
      /\b(pursuing|studying|working towards?)\b.*\b(degree|program|qualification)\b/,
      /\bdegree in progress\b/,
    ],
  },
  {
    question: 'highest_degree_awarded',
    patterns: [
      /\b(highest|most recent)\b.*\b(degree|education|qualification|level)\b/,
      /\bdegree\b.*\b(awarded|attained|obtained|completed|earned|received|conferred)\b/,
      /\b(awarded|attained|completed|earned|conferred)\b.*\b(degree|education|qualification)\b/,
      // A bare "Level of Education" reaches here rather than the degree rule
      // below, because it is a question about a level *held* and is settled
      // downstream by `educationLevelIntent`, which reads the page's own wording
      // and the control's own list. It is never answered "Bachelor's" by
      // default, which is what the generic degree rule used to do to it.
      /\blevel of education\b/,
      /\beducation level\b/,
    ],
  },
  // Both ahead of `degree`, whose bare `\bdegree\b` would claim either.
  {
    // The *kind of institution*, not the credential. Answered from the education
    // record's institution, and never from its degree level: an "Education Type"
    // control offering High School / College / Trade School was matched against
    // "Bachelor's Degree" and left at No Selection.
    question: 'education_type',
    patterns: [
      /\beducation\s?(type|level type)\b/,
      /\btype of (school|institution|education)\b/,
      /\b(school|institution)\s?type\b/,
    ],
  },
  { question: 'degree', patterns: [/\bdegree\b/, /\bqualification\b/, /^program$/] },
  {
    question: 'major',
    patterns: [/\b(major|discipline|field of study|area of study|concentration|course of study)\b/],
  },
  { question: 'minor', patterns: [/\bminor\b/, /\bsecondary field\b/] },
  { question: 'gpa', patterns: [/\bgpa\b/, /\b(cumulative )?grade point average\b/] },

  // Experience
  // Ahead of `employer`, whose `\bemployer\b` would otherwise claim it.
  //
  // "Are you under any contract or employment restriction with a current or
  // previous employer?" is a legal question about the applicant, and matching it
  // to `employer` offered a saved company *name* to a Yes/No dropdown. The page
  // refused it and the run reported a failed autofill for a question nothing
  // saved could answer in the first place.
  {
    question: 'employment_restriction',
    patterns: [
      /\b(contract|employment|non ?compete|noncompete|non ?solicitation)\b.*\b(restriction|agreement|covenant)\b/,
      /\b(restriction|restricted|bound)\b.*\b(employer|employment|contract)\b/,
    ],
  },
  // Projects. A repeating Projects block labels its columns with the same bare
  // nouns a work-history block uses — Name, Role, Start Date — and a project is
  // not a job. Each pattern therefore names the section explicitly rather than
  // relying on position, so a "Name" outside a Projects block is never claimed.
  {
    question: 'project_name',
    patterns: [/\bproject\s?(name|title)\b/, /\b(name|title) of (the )?project\b/],
  },
  { question: 'project_role', patterns: [/\bproject\s?role\b/, /\byour role\b.*\bproject\b/] },
  {
    question: 'project_description',
    patterns: [/\bproject\s?(description|summary|details)\b/, /\bdescribe (the |this )?project\b/],
  },
  {
    question: 'project_technologies',
    patterns: [/\b(technologies|tech stack|tools used|languages used)\b/],
  },
  { question: 'project_url', patterns: [/\bproject\s?(url|link|website|repository|repo)\b/] },
  { question: 'project_start_date', patterns: [/\bproject\s?start\s?date\b/] },
  { question: 'project_end_date', patterns: [/\bproject\s?(end|completion)\s?date\b/] },
  { question: 'employer', patterns: [/\b(employer|company name|organization)\b/] },
  { question: 'job_title', patterns: [/\b(job|position|role)\s?title\b/, /^title$/, /^position$/] },
  {
    // "I currently work here", beside a job's end date. *Not* "are you currently
    // employed by, or have you ever worked for, this company" — that is a
    // question about the employer, it is `previously_employed`, and it is
    // unanswerable from the profile.
    //
    // The negative lookahead is the repair. The live form's wording opens with
    // "currently employed by", so this rule claimed it, the planner answered it
    // from `experience[0].current === false`, and the application asserted to
    // the employer that the applicant had never worked there. That is a
    // fabrication, not a mis-fill: a blank would have been honest and this was
    // not.
    question: 'currently_employed',
    patterns: [
      /^(?!.*\b(ever|previously|before|our company|this company|subsidiar)\b).*\bcurrently (employed|work(ing)? here)\b/,
      /\bi currently work\b/,
      /\bpresent\b$/,
    ],
  },
  {
    // What kind of engagement a past role was. Never inferred from the company's
    // name: "Freelance" as an employer says nothing the profile has stated about
    // how the work was classified.
    question: 'employment_type',
    patterns: [
      /\b(employment|job|work|position)\s?(type|status|classification)\b/,
      /\btype of (employment|work)\b/,
    ],
  },
  {
    question: 'reason_for_leaving',
    patterns: [/\breason for leaving\b/, /\bwhy did you leave\b/, /\breason for departure\b/],
  },
  {
    question: 'responsibilities',
    patterns: [
      /\b(responsibilities|duties|describe your role|job description)\b/,
      /\bwhat did you do\b/,
    ],
  },
  { question: 'years_of_experience', patterns: [/\byears? of (relevant )?experience\b/] },
  {
    // "From Date" is how the live form labels an employment start, and it
    // matched nothing at all: the control carried no canonical question, so the
    // planner reported it as waiting on an analysis that had no opinion about
    // it, and it stayed blank on every run. "To Date" is its pair.
    question: 'employment_start_date',
    patterns: [
      /^(?!.*\b(earliest|available|availability|when can you)\b).*\bstart date\b/,
      /^from date$/,
      /^date from$/,
    ],
  },
  { question: 'employment_end_date', patterns: [/\bend date\b/, /^to date$/, /^date to$/] },
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
      // "Earliest Internship Start Date" separates the two words. It is an
      // availability question, never a graduation or an enrolment one, and it is
      // answered only from a saved preference.
      /\bearliest\b.*\bstart\b/,
      /\bstart date\b.*\bavailab/,
      // "When are you available to start?" — the words are separated, which the
      // adjacent-word patterns above miss.
      /\b(available|availability)\b.*\bto start\b/,
      /\bwhen (are|can|could|would|will) you\b.*\bstart\b/,
      // Taleo's own wording, which none of the patterns above reaches.
      /^date available$/,
      /\bdate (of )?availab/,
      /\bavailable\b.*\bdate\b/,
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
    question: 'salary_minimum',
    patterns: [
      /\b(minimum|lowest|least)\b.*\b(salary|compensation|pay|rate|wage)\b/,
      /\b(salary|compensation|pay|rate|wage)\b.*\bminimum\b/,
    ],
  },
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
  // Facts about the applicant's relationship with this one employer. Each is
  // its own question because none has an honest profile-wide default, and
  // answering one from another would be a fabrication: having applied before is
  // not the same as having worked there.
  {
    question: 'previously_employed',
    patterns: [
      /\b(previously|ever|before)\b.*\b(employed|worked)\b/,
      /\b(employed|worked)\b.*\b(previously|before)\b/,
      /\bformer employee\b/,
      /\brehire\b/,
    ],
  },
  {
    question: 'previously_interviewed',
    patterns: [/\b(previously|ever|before)\b.*\binterview/, /\binterview(ed)?\b.*\bbefore\b/],
  },
  {
    question: 'previously_applied',
    patterns: [
      /\b(previously|ever|before)\b.*\bapplied\b/,
      /\bapplied\b.*\bbefore\b/,
      /\bprior application\b/,
    ],
  },
  {
    question: 'family_member_employed',
    patterns: [/\b(relative|relatives|family member|spouse|parent|sibling)\b/, /\bnepotism\b/],
  },
  // A referral's details, before the generic referral rule they contain.
  {
    question: 'referral_name',
    patterns: [
      /\brefer(rer|ral|rals)?\b.*\bname\b/,
      /\bname\b.*\brefer(rer|ral)\b/,
      /\bwho referred you\b/,
    ],
  },
  {
    question: 'referral_email',
    patterns: [/\brefer(rer|ral|rals)?\b.*\be ?mail\b/, /\be ?mail\b.*\brefer(rer|ral)\b/],
  },
  {
    question: 'referral_relationship',
    patterns: [/\brefer(rer|ral|rals)?\b.*\brelationship\b/, /\brelationship\b.*\brefer/],
  },
  {
    question: 'employee_referral',
    patterns: [
      /\bemployee referral\b/,
      /\b(were|are) you referred\b/,
      /\bdo you have\b.*\breferral\b/,
    ],
  },
  { question: 'referral', patterns: [/\brefer(red|ral)\b/] },
  // Opt-in only. Recognized so it can be deliberately left unchecked rather
  // than swept up by a generic consent rule.
  {
    question: 'marketing_text_consent',
    patterns: [
      /\b(text|sms)\b.*\b(message|messages|alert|alerts|notification)\b/,
      /\b(promotional|marketing)\b.*\b(text|sms|message|messages|email)\b/,
      /\breceive\b.*\b(promotional|marketing)\b/,
      /\bopt in\b.*\b(text|sms|marketing)\b/,
    ],
  },
  {
    question: 'preferred_locations',
    patterns: [
      /\b(preferred|desired|interested in)\b.*\blocation/,
      /\blocation\b.*\b(preference|preferences|interest)/,
      /\bwhich locations?\b/,
      /\blocations?\b.*\binterest/,
      // Anchored: Taleo's multi-select is labelled exactly "Job Location", but
      // "Would you consider moving to the job location?" is a relocation
      // question and must keep reaching the willing_to_relocate rule.
      /^job locations?$/,
    ],
  },
  { question: 'industry', patterns: [/\bindustr(y|ies)\b/, /\bwhich sector\b/] },
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

  // Before the rule table, and that order is the whole point.
  //
  // "If you have any relatives currently employed, provide their full name,
  // location and your relationship to them." matched the `full_name` rule at
  // confidence 1.0 — the label does contain "full name" — and a live
  // application was submitted naming the applicant as their own relative. The
  // rules below cannot tell whose name is being asked for; this can, and it
  // runs first so no rule can answer a question about somebody else.
  //
  // `unknown` rather than a new intent: an unrecognised question is one the
  // planner leaves to the applicant, which is exactly the required outcome and
  // needs no new plumbing to obtain it.
  if (describesThirdPartyDetails(normalized)) return { question: 'unknown', confidence: 0 };

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
