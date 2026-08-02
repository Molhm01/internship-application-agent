import { z } from 'zod';
import { idSchema } from './common.js';

/** Application session fields shared between website and extension */
export interface ApplicationSession {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  claimedAt?: number;
  status: 'available' | 'claimed' | 'completed';
  url: string;
  domain: string;
  ats: string;
  jobContext?: {
    company?: string;
    jobTitle?: string;
    description?: string;
    location?: string;
    department?: string;
    employmentType?: string;
    responsibilities?: string[];
    qualifications?: string[];
    salary?: string;
    applicationId?: string;
    requisitionId?: string;
    sourceUrl?: string;
  };
  /** Set when the session was created by the website handoff rather than the extension. */
  company?: string;
  jobTitle?: string;
  officialApplyUrl?: string;
  websiteJobId?: string;
  location?: string;
  eligibilityScore?: number;
  tailoredResumeDocumentId?: string;
  tailoredCoverLetterDocumentId?: string;
  startAutofill?: boolean;
}

/** Zod schema for validating session data as stored/returned by the server. */
export const applicationSessionSchema = z.object({
  sessionId: idSchema.min(16).max(36),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  claimedAt: z.number().int().optional(),
  status: z.enum(['available', 'claimed', 'completed']),
  url: z.string().max(2048),
  domain: z.string().max(255),
  ats: z.string().max(100),
  jobContext: z
    .object({
      company: z.string().max(200).optional(),
      jobTitle: z.string().max(300).optional(),
      description: z.string().max(50_000).optional(),
      location: z.string().max(200).optional(),
      department: z.string().max(200).optional(),
      employmentType: z.string().max(120).optional(),
      responsibilities: z.array(z.string().max(2000)).max(100).optional(),
      qualifications: z.array(z.string().max(2000)).max(100).optional(),
      salary: z.string().max(200).optional(),
      applicationId: z.string().max(200).optional(),
      requisitionId: z.string().max(200).optional(),
      sourceUrl: z.string().url().max(2048).optional(),
    })
    .passthrough() // Allow additional fields
    .optional(),
  // Website-handoff fields (Internship-AI's "apply with agent" flow). Absent
  // when the session was created by the extension itself.
  company: z.string().max(200).optional(),
  jobTitle: z.string().max(300).optional(),
  officialApplyUrl: z.string().url().max(2048).optional(),
  websiteJobId: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  eligibilityScore: z.number().min(0).max(1).optional(),
  tailoredResumeDocumentId: z.string().max(200).optional(),
  tailoredCoverLetterDocumentId: z.string().max(200).optional(),
  startAutofill: z.boolean().optional(),
});

function isSafeApplicationDestination(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return ![
      'jobright.ai',
      'www.jobright.ai',
      'intern-list.com',
      'www.intern-list.com',
      'simplify.jobs',
      'www.simplify.jobs',
    ].some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
  } catch {
    return false;
  }
}

/**
 * Canonical input schema for creating application sessions. The caller must
 * supply the final employer/ATS destination as `url`; discovery aggregators
 * are never valid session targets.
 */
export const applicationSessionInputSchema = applicationSessionSchema
  .omit({
    sessionId: true,
    createdAt: true,
    expiresAt: true,
    claimedAt: true,
    officialApplyUrl: true,
    url: true,
    domain: true,
    ats: true,
  })
  .extend({
    /** Optional caller-supplied id, primarily for tests. */
    id: z.string().min(16).max(36).optional(),
    expiresAt: z.number().int().optional(),
    url: z
      .string()
      .url()
      .max(2048)
      .refine(
        isSafeApplicationDestination,
        'url must be a direct HTTPS employer or ATS destination',
      ),
    domain: z.string().max(255).optional(),
    ats: z.string().max(100).optional(),
    status: z.enum(['available', 'claimed', 'completed']).optional(),
  })
  .strict();

export type ApplicationSessionInput = z.infer<typeof applicationSessionInputSchema>;

export type ApplicationSessionStatus = 'available' | 'claimed' | 'completed';
