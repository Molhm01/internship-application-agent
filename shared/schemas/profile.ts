import { z } from 'zod';
import {
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  partialDateSchema,
  urlSchema,
} from './common.js';
import { SENSITIVE_CATEGORIES, SENSITIVE_POLICIES } from '../constants/ats.js';

/**
 * Everything here is optional on purpose. A missing value means "the user has
 * not told us", and the agent must treat it as unanswerable rather than
 * inventing a plausible substitute.
 */

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
  phoneCountryCode: z.string().max(10).optional(),
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
  major: z.string().max(200).optional(),
  minor: z.string().max(200).optional(),
  startDate: partialDateSchema.optional(),
  graduationDate: partialDateSchema.optional(),
  gpa: z.number().min(0).max(100).optional(),
  gpaScale: z.number().min(0).max(100).optional(),
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
  /** Explicit, user-configured answer for "How did you hear about us?" controls. */
  discoverySource: z.string().max(300).optional(),
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
export const CURRENT_PROFILE_VERSION = 2;

export const profileSchema = z.object({
  version: z.number().int().positive().default(1),
  id: idSchema.default('primary'),
  personal: personalInfoSchema.default({}),
  education: z.array(educationEntrySchema).default([]),
  experience: z.array(experienceEntrySchema).default([]),
  projects: z.array(projectEntrySchema).default([]),
  certifications: z.array(certificationSchema).default([]),
  volunteering: z.array(volunteeringEntrySchema).default([]),
  skills: skillsSchema.default({}),
  eligibility: eligibilitySchema.default({}),
  preferences: preferencesSchema.default({}),
  sensitivePolicies: z.array(sensitiveAnswerPolicySchema).default([]),
  updatedAt: isoDateTimeSchema,
});

export type Profile = z.infer<typeof profileSchema>;
export type PersonalInfo = z.infer<typeof personalInfoSchema>;
export type EducationEntry = z.infer<typeof educationEntrySchema>;
export type ExperienceEntry = z.infer<typeof experienceEntrySchema>;
export type SensitiveAnswerPolicy = z.infer<typeof sensitiveAnswerPolicySchema>;

/** Body accepted by `PUT /profile`; the server owns `updatedAt`. */
export const profileUpdateSchema = profileSchema.omit({ updatedAt: true });
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
