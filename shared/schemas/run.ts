import { z } from 'zod';
import { idSchema, isoDateTimeSchema, jobContextSchema } from './common.js';
import { fieldStatusSchema } from './fields.js';
import { agentErrorSchema } from './error.js';
import { answerSourceSchema, fillActionKindSchema } from './plan.js';
import { ATS_IDS } from '../constants/ats.js';

export const applicationRunStatusSchema = z.enum([
  'analyzing',
  'ready_for_review',
  'filling',
  'completed',
  'completed_with_errors',
  'failed',
]);

export type ApplicationRunStatus = z.infer<typeof applicationRunStatusSchema>;

export const applicationActionResultSchema = z.object({
  fieldId: idSchema,
  question: z.string().max(2000),
  action: fillActionKindSchema,
  source: answerSourceSchema,
  status: fieldStatusSchema,
  /** Redacted before it reaches any general debug log. */
  attemptedValue: z
    .union([z.string().max(20_000), z.array(z.string().max(2000)), z.boolean()])
    .optional(),
  observedValue: z
    .union([z.string().max(20_000), z.array(z.string().max(2000)), z.boolean()])
    .optional(),
  verified: z.boolean(),
  attempts: z.number().int().nonnegative(),
  error: agentErrorSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
});

export type ApplicationActionResult = z.infer<typeof applicationActionResultSchema>;

export const applicationRunSchema = z.object({
  id: idSchema,
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  url: z.string().url(),
  domain: z.string().max(300),
  ats: z.enum(ATS_IDS),
  jobContext: jobContextSchema.optional(),
  totalFields: z.number().int().nonnegative(),
  filledFields: z.number().int().nonnegative(),
  verifiedFields: z.number().int().nonnegative(),
  skippedFields: z.number().int().nonnegative(),
  reviewFields: z.number().int().nonnegative(),
  failedFields: z.number().int().nonnegative(),
  status: applicationRunStatusSchema,
  actions: z.array(applicationActionResultSchema).default([]),
  warnings: z.array(z.string().max(2000)).default([]),
  errors: z.array(agentErrorSchema).default([]),
  /**
   * Invariant of this product: the agent never clicks a final submit control.
   * Persisted with every run so the report can state it explicitly.
   */
  submitted: z.literal(false).default(false),
});

export type ApplicationRun = z.infer<typeof applicationRunSchema>;

/** Optional handoff payload from the Internship-AI website (Milestone 8). */
export const websiteJobContextSchema = z.object({
  jobId: idSchema,
  company: z.string().max(200),
  title: z.string().max(300),
  description: z.string().max(50_000).optional(),
  location: z.string().max(200).optional(),
  applicationUrl: z.string().url(),
  recommendedResumeId: idSchema.optional(),
  expiresAt: isoDateTimeSchema,
});

export type WebsiteJobContext = z.infer<typeof websiteJobContextSchema>;
