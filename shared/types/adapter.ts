import type { AtsId } from '../constants/ats.js';
import type { JobContext } from '../schemas/common.js';
import type { DetectedField } from '../schemas/fields.js';
import type { DocumentContentResponse } from '../schemas/documents.js';
import type {
  DeterministicFillAction,
  FillExecutionResult,
  FillVerificationResult,
} from '../schemas/fill.js';

export interface PageDetectionContext {
  url: string;
  hostname: string;
  title: string;
  bodyText: string;
  /** Kept unknown so the shared package does not depend on browser DOM libraries. */
  document: unknown;
}

export interface ScanContext extends PageDetectionContext {
  pageId: string;
  /** Browser implementation supplies an AbortSignal. */
  signal: unknown;
}

export interface AdapterDetection {
  matched: boolean;
  confidence: number;
  reason: string;
  supported: boolean;
}

export interface ExecutionContext {
  document: unknown;
  signal: unknown;
  documentContents?: readonly DocumentContentResponse[];
}

/** Scanner and deterministic executor contract. */
export interface AtsAdapter {
  readonly id: AtsId;
  readonly displayName: string;
  readonly priority: number;
  detect(context: PageDetectionContext): AdapterDetection;
  scan(context: ScanContext): Promise<DetectedField[]>;
  extractJobContext(context: ScanContext): Promise<JobContext>;
  executeAction(
    context: ExecutionContext,
    field: DetectedField,
    action: DeterministicFillAction,
  ): Promise<FillExecutionResult>;
  verifyAction(
    context: ExecutionContext,
    field: DetectedField,
    action: DeterministicFillAction,
  ): Promise<FillVerificationResult>;
}
