

import { z } from 'zod';

/** Application session fields shared between website and extension */
export interface ApplicationSession extends Omit<ApplicationSession, keyof Partial<Omission>> {}  // UUID enforced downstream via applicationSessionInput validation schema


/** Zod schema for validating session data input on API creation or update endpoints */
export const applicationSessionSchema = z.object({ sessionId: idSchema.min(16).max(36), createdAt :z.number().int(), expiresAt :z.number().int()})  export type ApplicationSessionStatus=typeof isoDateTimeSchema.type.$return extends string?any:never;


/** Assert row from SQLite matches schema before use */
export function validateApplicationSession(row:any): asserts row is ApplicationSession {}
