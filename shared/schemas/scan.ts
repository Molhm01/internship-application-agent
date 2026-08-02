import { z } from 'zod';
import { ATS_IDS } from '../constants/ats.js';
import { confidenceSchema, idSchema, isoDateTimeSchema, jobContextSchema } from './common.js';
import { detectedFieldSchema, fieldSectionSchema } from './fields.js';
import { NAVIGATION_INTENTS, PAGE_KINDS } from '../logic/navigationState.js';

export const navigationActionSchema = z.object({
  intent: z.enum(NAVIGATION_INTENTS),
  label: z.string().max(200),
  selector: z.string().max(2000),
  endsApplication: z.boolean(),
});

export const navigationStateSchema = z.object({
  kind: z.enum(PAGE_KINDS),
  actions: z.array(navigationActionSchema).max(100).default([]),
  blockedReason: z.string().max(500).optional(),
  requiresCredentials: z.boolean().default(false),
});

export const scanStatisticsSchema = z.object({
  total: z.number().int().nonnegative(),
  supported: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  required: z.number().int().nonnegative(),
  optional: z.number().int().nonnegative(),
  text: z.number().int().nonnegative(),
  textarea: z.number().int().nonnegative(),
  select: z.number().int().nonnegative(),
  combobox: z.number().int().nonnegative(),
  radio: z.number().int().nonnegative(),
  checkbox: z.number().int().nonnegative(),
  file: z.number().int().nonnegative(),
  /**
   * Sign-in controls found. Named for what it counts rather than for the
   * input type, so the export sanitizer — which strips any key that looks like
   * a secret — does not mistake a count for one and drop it.
   */
  credentialFields: z.number().int().nonnegative().default(0),
  /** Buttons and links that navigate. Never counted as questions. */
  navigationActions: z.number().int().nonnegative().default(0),
  bySection: z.record(fieldSectionSchema, z.number().int().nonnegative()).default({}),
});

export type ScanStatistics = z.infer<typeof scanStatisticsSchema>;

export const applicationScanResultSchema = z.object({
  id: idSchema,
  createdAt: isoDateTimeSchema,
  url: z.string().url(),
  domain: z.string().max(300),
  ats: z.object({
    id: z.enum(ATS_IDS),
    displayName: z.string().min(1).max(120),
    confidence: confidenceSchema,
    detectionReason: z.string().min(1).max(500),
    supported: z.boolean(),
  }),
  jobContext: jobContextSchema,
  fields: z.array(detectedFieldSchema),
  warnings: z.array(z.string().min(1).max(2000)).default([]),
  statistics: scanStatisticsSchema,
  /**
   * What kind of page this is and where it leads. An application is not one
   * form: a sign-in page, a create-account page and a review page are all part
   * of applying, and each needs different handling.
   */
  navigation: navigationStateSchema.optional(),
  durationMs: z.number().nonnegative(),
  status: z.enum(['completed', 'completed_with_warnings']),
  readOnly: z.literal(true),
});

export type ApplicationScanResult = z.infer<typeof applicationScanResultSchema>;
export const applicationScanSchema = applicationScanResultSchema;
export type ApplicationScan = ApplicationScanResult;

export const scanStateSchema = z.enum(['idle', 'scanning', 'completed', 'cancelled', 'failed']);

export type ScanState = z.infer<typeof scanStateSchema>;

export const scanProgressSchema = z.object({
  scanId: idSchema,
  stage: z.enum([
    'detecting_ats',
    'extracting_job_context',
    'scanning_fields',
    'normalizing',
    'validating',
    'done',
  ]),
  message: z.string().max(300),
  fieldsSoFar: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
});

export type ScanProgress = z.infer<typeof scanProgressSchema>;
