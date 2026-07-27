import { z } from 'zod';

/** ISO-8601 timestamp, e.g. 2026-07-26T14:03:11.000Z */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe('ISO-8601 timestamp');

/** Calendar date without a time component, e.g. 2026-05-15 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')
  .describe('ISO-8601 calendar date');

/** A partial date, since applications frequently ask for month + year only. */
export const partialDateSchema = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'Expected YYYY, YYYY-MM, or YYYY-MM-DD');

export const idSchema = z.string().min(1).max(128);

export const urlSchema = z.string().url().max(2048);

/** Model-reported confidence, always normalized to 0..1. */
export const confidenceSchema = z.number().min(0).max(1);

/**
 * What the page says about the job itself. Every field is optional because most
 * application pages state only some of it, and an absent value is reported as
 * absent rather than inferred.
 */
export const jobContextSchema = z.object({
  company: z.string().max(200).optional(),
  jobTitle: z.string().max(300).optional(),
  description: z.string().max(50_000).optional(),
  location: z.string().max(200).optional(),
  department: z.string().max(200).optional(),
  employmentType: z.string().max(120).optional(),
  responsibilities: z.array(z.string().max(2000)).max(100).optional(),
  qualifications: z.array(z.string().max(2000)).max(100).optional(),
  salary: z.string().max(200).optional(),
  /** The ATS's own identifier for this posting, when the page exposes one. */
  applicationId: z.string().max(200).optional(),
  requisitionId: z.string().max(200).optional(),
  sourceUrl: urlSchema.optional(),
});

export type JobContext = z.infer<typeof jobContextSchema>;
