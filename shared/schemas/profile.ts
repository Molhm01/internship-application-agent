import { z } from 'zod';
import {
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  partialDateSchema,
  urlSchema,
} from './common.js';
import { SENSITIVE_CATEGORIES, SENSITIVE_POLICIES } from '../constants/ats.js';
import { dayConventionSchema } from './dates.js';
import { portalStrategySchema } from './employerAccounts.js';

/**
 * Everything here is optional on purpose. A missing value means "the user has
 * not told us", and the agent must treat it as unanswerable rather than
 * inventing a plausible substitute.
 */

/**
 * Which *kind* of phone or address a repeating contact block is recording.
 *
 * A closed list, because these are dropdowns on every form that asks: an
 * open string could never be matched against the offered options without
 * guessing. Absent means the user has not said, and the control stays for them.
 */
export const phoneTypeSchema = z.enum(['mobile', 'home', 'work', 'other']);
export const addressTypeSchema = z.enum(['home', 'work', 'other']);

export const addressSchema = z.object({
  line1: z.string().max(200).optional(),
  /**
   * A genuine second line. When the applicant has none this key is absent, and
   * the executor must leave the employer's "Address Line 2" empty rather than
   * repeating line 1 into it.
   */
  line2: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  postalCode: z.string().max(30).optional(),
  country: z.string().max(120).optional(),
  /** Nearest metropolitan area, which ATSs ask for and which is not the city. */
  metroRegion: z.string().max(200).optional(),
  /** Home / work / other, for forms whose address block asks which kind it is. */
  type: addressTypeSchema.optional(),
});

/** Which stored link answers a form offering exactly one "Website" box. */
export const websiteFieldSchema = z.enum(['linkedin', 'github', 'portfolio', 'website']);

export const personalInfoSchema = z.object({
  legalFirstName: z.string().max(120).optional(),
  legalMiddleName: z.string().max(120).optional(),
  /**
   * Present and true only when the applicant said they have no middle name.
   * Absent means unanswered, so a form asking them to confirm it stays a
   * question for the user rather than being answered from a blank field.
   */
  noMiddleName: z.literal(true).optional(),
  legalLastName: z.string().max(120).optional(),
  suffix: z.string().max(40).optional(),
  preferredName: z.string().max(120).optional(),
  pronouns: z.string().max(60).optional(),
  email: z.string().email().optional(),
  alternateEmail: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  /**
   * The dialling code as the applicant stores it, e.g. "+1".
   *
   * A stored answer rather than a derivation of `address.country`, because a
   * profile can state a phone country without stating a residence country —
   * and because deriving it meant a form with a country-code control had
   * nothing to put in it until the address section was filled in.
   */
  phoneCountryCode: z.string().max(10).optional(),
  phoneType: phoneTypeSchema.optional(),
  address: addressSchema.default({}),
  linkedin: urlSchema.optional(),
  github: urlSchema.optional(),
  portfolio: urlSchema.optional(),
  personalWebsite: urlSchema.optional(),
  preferredWebsiteField: websiteFieldSchema.optional(),
});

export const educationEntrySchema = z.object({
  id: idSchema,
  institution: z.string().max(200),
  degree: z.string().max(120).optional(),
  /**
   * The level the degree sits at — "Bachelor's", "Master's" — as distinct from
   * its full name ("Bachelor of Science in Mechanical Engineering"). Forms ask
   * for one or the other and the two are not interchangeable.
   */
  degreeLevel: z.string().max(120).optional(),
  major: z.string().max(200).optional(),
  minor: z.string().max(200).optional(),
  startDate: partialDateSchema.optional(),
  graduationDate: partialDateSchema.optional(),
  gpa: z.number().min(0).max(100).optional(),
  gpaScale: z.number().min(0).max(100).optional(),
  /**
   * Whether this credential has been awarded. Absent means the user has not
   * said, which is different from "not completed" and must stay different: only
   * an entry that positively states completion can answer "highest degree
   * awarded".
   */
  status: z.enum(['completed', 'in_progress']).optional(),
  coursework: z.array(z.string().max(200)).default([]),
  honors: z.array(z.string().max(200)).default([]),
  activities: z.array(z.string().max(200)).default([]),
});

export const experienceEntrySchema = z.object({
  id: idSchema,
  employer: z.string().max(200),
  title: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  startDate: partialDateSchema.optional(),
  endDate: partialDateSchema.optional(),
  current: z.boolean().default(false),
  /**
   * How this engagement was classified, in the applicant's own words.
   *
   * Optional, and absent means *unknown* rather than "full time". An
   * application asking "Employment Type" is asking a factual question about a
   * past role, and the only honest sources are what the applicant recorded and
   * nothing else — an employer named "Freelance" is not evidence that the work
   * was classified as freelance, and a form that offers Contract, Self-Employed
   * and Internship separately is asking a distinction the company name cannot
   * settle.
   */
  employmentType: z.string().max(100).optional(),
  /** Why the role ended, when the applicant recorded it. Never invented. */
  reasonForLeaving: z.string().max(500).optional(),
  responsibilities: z.array(z.string().max(2000)).default([]),
  achievements: z.array(z.string().max(2000)).default([]),
});

export const projectEntrySchema = z.object({
  id: idSchema,
  name: z.string().max(200),
  description: z.string().max(4000).optional(),
  technologies: z.array(z.string().max(120)).default([]),
  url: urlSchema.optional(),
  startDate: partialDateSchema.optional(),
  endDate: partialDateSchema.optional(),
  accomplishments: z.array(z.string().max(2000)).default([]),
});

export const certificationSchema = z.object({
  id: idSchema,
  name: z.string().max(200),
  issuer: z.string().max(200).optional(),
  issueDate: partialDateSchema.optional(),
  expirationDate: partialDateSchema.optional(),
  credentialId: z.string().max(200).optional(),
});

export const volunteeringEntrySchema = z.object({
  id: idSchema,
  organization: z.string().max(200),
  role: z.string().max(200).optional(),
  startDate: partialDateSchema.optional(),
  endDate: partialDateSchema.optional(),
  description: z.string().max(2000).optional(),
});

export const skillsSchema = z.object({
  technical: z.array(z.string().max(120)).default([]),
  programmingLanguages: z.array(z.string().max(120)).default([]),
  engineeringSoftware: z.array(z.string().max(120)).default([]),
  hardware: z.array(z.string().max(120)).default([]),
  spokenLanguages: z
    .array(
      z.object({
        language: z.string().max(120),
        proficiency: z.enum(['basic', 'conversational', 'professional', 'fluent', 'native']),
      }),
    )
    .default([]),
});

export const eligibilitySchema = z.object({
  workAuthorization: z.string().max(300).optional(),
  /** "Do you require sponsorship now?" — a separate question from the next one. */
  requiresSponsorshipNow: z.boolean().optional(),
  requiresFutureSponsorship: z.boolean().optional(),
  securityClearanceStatus: z.string().max(300).optional(),
  citizenshipResponse: z.string().max(300).optional(),
  willingToRelocate: z.boolean().optional(),
  willingToTravelPercent: z.number().int().min(0).max(100).optional(),
  hasDriversLicense: z.boolean().optional(),
  meetsMinimumAge: z.boolean().optional(),
  earliestStartDate: isoDateSchema.optional(),
  internshipAvailability: z.string().max(300).optional(),
});

export const preferencesSchema = z.object({
  targetRoles: z.array(z.string().max(200)).default([]),
  industries: z.array(z.string().max(200)).default([]),
  preferredLocations: z.array(z.string().max(200)).default([]),
  /**
   * Explicit, user-configured answer for "How did you hear about us?" controls.
   * Named `sourceAttribution` in the profile brief; the key is spelled once,
   * here, and both sides read this one.
   */
  discoverySource: z.string().max(300).optional(),
  /**
   * How the applicant wants an employer portal handled on a run that has no
   * bundle. The same choice arrives inside `accountPreferences` when the run
   * *does* have one; this is the standing preference, so a user who opened the
   * employer page themselves is not asked again.
   */
  employerPortalStrategy: portalStrategySchema.optional(),
  /**
   * What to do when a form demands an exact day and the record holds only a
   * month and a year.
   *
   * Defaults to `ask`, and that default is load-bearing rather than cautious.
   * A start date of `07/01/2021` on an employment record is a statement of
   * fact, and the difference between "the applicant told us July 2021" and
   * "something chose the first of July for them" is the difference between an
   * accurate application and a misstatement — one an employer can act on.
   *
   * The other two values are consent, given once, to a specific substitution.
   * They exist so an applicant who genuinely does not remember exact start days
   * is not stopped on every form; they are never inferred from anything, and a
   * date filled under one records which convention supplied its day.
   */
  monthYearDayConvention: dayConventionSchema.default('ask'),
  remotePreference: z.enum(['remote', 'hybrid', 'onsite', 'no_preference']).optional(),
  salaryPreference: z.string().max(200).optional(),
  salaryStrategy: z.enum(['negotiable', 'specific', 'decline']).optional(),
  salaryMinimum: z.string().max(120).optional(),
  /**
   * Opt-in only. Absence is not consent, and there is deliberately no way to
   * express "the user refused" — a marketing box left unchecked is correct for
   * both the unanswered and the refused case.
   */
  marketingTextConsent: z.literal(true).optional(),
  /** Ordered rules consulted before falling back to the default resume. */
  resumeSelectionRules: z
    .array(
      z.object({
        id: idSchema,
        matchRoleKeywords: z.array(z.string().max(120)).default([]),
        matchIndustryKeywords: z.array(z.string().max(120)).default([]),
        documentId: idSchema,
      }),
    )
    .default([]),
});

/**
 * A document the profile can point an upload control at.
 *
 * A reference, never bytes. `documentId` is the key of the store that owns the
 * file — the agent server's document table, or an IndexedDB blob key for a
 * bundle document — and this schema is deliberately incapable of carrying file
 * content into a model prompt or into synced storage.
 */
export const documentReferenceSchema = z.object({
  documentId: idSchema,
  filename: z.string().min(1).max(255),
  /** 'agent-server' or 'bundle', so a stale reference names the store to check. */
  origin: z.enum(['agent_server', 'bundle']),
  byteLength: z.number().int().positive().optional(),
  updatedAt: isoDateTimeSchema.optional(),
});

export type DocumentReference = z.infer<typeof documentReferenceSchema>;

/**
 * Which documents this profile can offer an employer's upload control.
 *
 * `tailoredResume` / `tailoredCoverLetter` are set only by an application
 * bundle and are specific to one job. `defaultResume` is the general-purpose
 * file, used only when no tailored document exists — and the difference is
 * reported to the user rather than smoothed over.
 */
export const profileDocumentsSchema = z.object({
  defaultResume: documentReferenceSchema.optional(),
  tailoredResume: documentReferenceSchema.optional(),
  tailoredCoverLetter: documentReferenceSchema.optional(),
});

export const sensitiveAnswerPolicySchema = z.object({
  category: z.enum(SENSITIVE_CATEGORIES),
  policy: z.enum(SENSITIVE_POLICIES),
  /** Only meaningful when policy is `approved_auto_fill`. */
  value: z.string().max(500).optional(),
});

/**
 * The profile contract version Internship Pilot stamped this snapshot with.
 *
 * Defaulted rather than required so a bundle from an older website still loads;
 * `CURRENT_PROFILE_VERSION` is what this extension understands, and the two are
 * compared explicitly at the bridge rather than assumed equal.
 */
export const CURRENT_PROFILE_VERSION = 3;

/**
 * Versions this build knows how to read.
 *
 * v1 — the original contract.
 * v2 — split `highestCompletedDegree` from `currentDegreeInProgress`.
 * v3 — stored `phoneCountryCode`/`phoneType`/`address.type`, education
 *      `degreeLevel`, `organizations`/`activities`, `documents`, and
 *      `preferences.employerPortalStrategy`.
 *
 * Every step is additive, so migration never has to invent a value: a profile
 * from an older version simply lacks the newer keys, and a lacking key is an
 * unanswered question rather than a blank answer.
 */
export const SUPPORTED_PROFILE_VERSIONS = [1, 2, 3] as const;

export const profileSchema = z.object({
  version: z.number().int().positive().default(1),
  id: idSchema.default('primary'),
  personal: personalInfoSchema.default({}),
  education: z.array(educationEntrySchema).default([]),
  /**
   * The highest credential actually awarded, and what is being studied now.
   *
   * Two fields rather than one because they are two different answers for
   * anyone mid-degree, and "Highest Level of Education" asks for the first.
   * Answering it with the second overstates the applicant's qualifications,
   * which is a misrepresentation rather than a formatting mistake.
   */
  highestCompletedDegree: z.string().max(120).optional(),
  currentDegreeInProgress: z.string().max(120).optional(),
  experience: z.array(experienceEntrySchema).default([]),
  projects: z.array(projectEntrySchema).default([]),
  certifications: z.array(certificationSchema).default([]),
  volunteering: z.array(volunteeringEntrySchema).default([]),
  /**
   * Clubs, societies, and student chapters, and the things the applicant did
   * outside a job or a course. Kept as plain lists rather than folded into
   * `skills`, because a form asking for "Activities" wants these and a form
   * asking for "Skills" does not.
   */
  organizations: z.array(z.string().max(200)).default([]),
  activities: z.array(z.string().max(200)).default([]),
  skills: skillsSchema.default({}),
  eligibility: eligibilitySchema.default({}),
  preferences: preferencesSchema.default({}),
  /** References to the files this profile can attach. Never file bytes. */
  documents: profileDocumentsSchema.default({}),
  sensitivePolicies: z.array(sensitiveAnswerPolicySchema).default([]),
  updatedAt: isoDateTimeSchema,
});

export type Profile = z.infer<typeof profileSchema>;
export type PersonalInfo = z.infer<typeof personalInfoSchema>;
export type EducationEntry = z.infer<typeof educationEntrySchema>;
export type ExperienceEntry = z.infer<typeof experienceEntrySchema>;
export type SensitiveAnswerPolicy = z.infer<typeof sensitiveAnswerPolicySchema>;

export type ProfileDocuments = z.infer<typeof profileDocumentsSchema>;
export type ExperienceEntryInput = z.input<typeof experienceEntrySchema>;

/**
 * Why a stored or received profile cannot be read, or null when it can.
 *
 * A profile stamped *newer* than this build is refused rather than parsed:
 * Zod would strip the keys this build does not know, and a stripped fact is
 * indistinguishable from a fact the user never entered. Silently downgrading
 * someone's profile is how a complete application becomes a half-filled one.
 */
export function profileVersionProblem(version: number): string | null {
  if (version <= CURRENT_PROFILE_VERSION) return null;
  return `This profile is in format v${version}, but this build reads up to v${CURRENT_PROFILE_VERSION}. Update the extension and the agent server, then try again.`;
}

/**
 * Brings a profile from any supported version up to the current one.
 *
 * Every version step so far has been purely additive, so this adds no value the
 * user did not enter — it only stamps the version, letting `profileSchema`'s own
 * defaults supply the empty containers. It is written as an explicit function
 * rather than left to the schema so that a future non-additive step has one
 * place to live, and so a caller can tell "migrated" from "already current".
 */
export function migrateProfile(raw: unknown): {
  profile: Profile;
  migratedFrom: number | null;
} {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const declared = typeof source.version === 'number' ? source.version : 1;
  const problem = profileVersionProblem(declared);
  if (problem) throw new Error(problem);

  const profile = profileSchema.parse({ ...source, version: CURRENT_PROFILE_VERSION });
  return {
    profile,
    migratedFrom: declared === CURRENT_PROFILE_VERSION ? null : declared,
  };
}

/** Body accepted by `PUT /profile`; the server owns `updatedAt`. */
export const profileUpdateSchema = profileSchema.omit({ updatedAt: true });
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/**
 * The vocabulary of the profile-sync report.
 *
 * Every one of these describes a *key*. There is deliberately no member that
 * could carry a value, so a report can be shown, logged, or copied into a bug
 * without disclosing anything about the applicant.
 */
export const profileFieldStatusSchema = z.enum([
  'present',
  'missing',
  'imported',
  'updated',
  'unmapped',
  'invalid',
]);

export const profileSyncEntrySchema = z.object({
  key: z.string().min(1).max(200),
  status: profileFieldStatusSchema,
});

export const profileSourceLabelSchema = z.enum([
  'internship_pilot',
  'agent_server',
  'legacy_extension',
]);

export const profileSourceSchema = z.object({
  label: profileSourceLabelSchema,
  profile: profileSchema,
});

export type ProfileFieldStatus = z.infer<typeof profileFieldStatusSchema>;
export type ProfileSyncEntry = z.infer<typeof profileSyncEntrySchema>;
export type ProfileSourceLabel = z.infer<typeof profileSourceLabelSchema>;
export type ProfileSource = z.infer<typeof profileSourceSchema>;

/** Body accepted by `POST /profile/import`. */
export const profileImportRequestSchema = z.object({
  sources: z.array(profileSourceSchema).min(1).max(4),
});

export type ProfileImportRequest = z.infer<typeof profileImportRequestSchema>;
