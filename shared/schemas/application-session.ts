

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
}

/** Zod schema for validating session data input on API creation or update endpoints */
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
});

/** Input schema for creating new application sessions */
export const applicationSessionInputSchema = applicationSessionSchema.omit({
  sessionId: true,
  createdAt: true,
  claimedAt: true,
}).extend({
  id?: string, // Optional id for testing purposes
});

/** Assert row from SQLite matches schema before use */
export function validateApplicationSession(row: any): asserts row is ApplicationSession {}

export type ApplicationSessionStatus = 'available' | 'claimed' | 'completed';
