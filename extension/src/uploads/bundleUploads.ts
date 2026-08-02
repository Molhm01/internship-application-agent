import {
  deterministicFillPlanSchema,
  type ApplicationBundle,
  type ApplicationScanResult,
  type DeterministicFillAction,
  type DeterministicFillPlan,
  type DetectedField,
  type StoredBundleDocument,
} from '@internship-agent/shared';
import { calculatePlanStatistics } from '../planner/deterministicPlanner.js';

/**
 * Binding the tailored documents to the right upload fields.
 *
 * Two mistakes are unacceptable here and are ruled out structurally rather than
 * hoped against: a cover letter must never land in a résumé field, and a
 * generic master résumé must never be used when a résumé tailored for this job
 * exists. Everything else — transcripts, portfolios, unclear single-slot
 * uploads — is left for the user to decide.
 */

export type UploadKind =
  | 'resume'
  | 'cover_letter'
  | 'transcript'
  | 'portfolio'
  | 'other'
  | 'unknown';

const RESUME_WORDS = /\b(resume|résumé|cv|curriculum vitae)\b/i;
const COVER_WORDS = /\bcover\s*letter\b|\bcovering\s*letter\b|\bmotivation\s*letter\b/i;
const TRANSCRIPT_WORDS = /\btranscript|\bacademic record\b|\bgrade report\b/i;
const PORTFOLIO_WORDS = /\bportfolio\b|\bwork samples?\b|\bwriting sample\b/i;
const OTHER_WORDS = /\b(other|additional|supporting)\b.*\b(document|file|attachment)\b/i;
/** A single unlabelled slot: "Attach a file", "Upload document". */
const GENERIC_WORDS = /\b(attach|upload|choose|select)\b.*\b(file|document|attachment)\b/i;

/** Everything on the page that says what this upload field is for. */
export function uploadFieldText(field: DetectedField): string {
  const metadata = field.metadata;
  return [
    field.label,
    field.question,
    field.helpText,
    field.placeholder,
    typeof metadata.name === 'string' ? metadata.name : '',
    typeof metadata.elementId === 'string' ? metadata.elementId : '',
    typeof metadata.uploadInstructions === 'string' ? metadata.uploadInstructions : '',
    typeof metadata.nearbyText === 'string' ? metadata.nearbyText : '',
    typeof metadata.sectionHeading === 'string' ? metadata.sectionHeading : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * What document this field wants.
 *
 * Ordered most specific first: "Cover letter" is checked before "resume"
 * because a page that says "Resume and cover letter" beside a second slot would
 * otherwise be read as a résumé field twice.
 */
export function classifyUploadField(field: DetectedField): UploadKind {
  if (field.canonicalKey === 'cover_letter') return 'cover_letter';
  if (field.canonicalKey === 'resume') return 'resume';
  if (field.canonicalKey === 'transcript') return 'transcript';
  if (field.canonicalKey === 'portfolio_document') return 'portfolio';

  const text = uploadFieldText(field);
  if (COVER_WORDS.test(text)) return 'cover_letter';
  if (TRANSCRIPT_WORDS.test(text)) return 'transcript';
  if (PORTFOLIO_WORDS.test(text)) return 'portfolio';
  if (RESUME_WORDS.test(text)) return 'resume';
  if (OTHER_WORDS.test(text)) return 'other';
  if (GENERIC_WORDS.test(text)) return 'unknown';
  return 'unknown';
}

/** Upload fields on the page, in document order, with what each wants. */
export function uploadFields(
  scan: ApplicationScanResult,
): Array<{ field: DetectedField; kind: UploadKind }> {
  return scan.fields
    .filter((field) => field.fieldType === 'file' && field.visible && !field.disabled)
    .map((field) => ({ field, kind: classifyUploadField(field) }));
}

function uploadAction(
  base: DeterministicFillAction,
  document: StoredBundleDocument,
  bundleId: string,
  reason: string,
  extraWarnings: readonly string[] = [],
): DeterministicFillAction {
  return {
    ...base,
    action: 'upload_file',
    source: 'document',
    sourceReference: `bundle.${bundleId}.${document.kind}`,
    // The IndexedDB key. The executor exchanges it for bytes; it is never a
    // path, a URL, or anything the page could resolve.
    documentId: document.bytesReference,
    documentName: document.filename,
    confidence: 1,
    requiresReview: true,
    approved: false,
    reason,
    warnings: [
      ...base.warnings,
      ...extraWarnings,
      'Document uploads never submit the application.',
    ],
  };
}

/**
 * Rebinds every upload field on the page to the tailored document that belongs
 * in it.
 *
 * A field whose purpose cannot be read is left for review with the reason
 * stated, rather than being filled with whichever document happened to be
 * first.
 */
export function attachBundleDocuments(
  plan: DeterministicFillPlan,
  scan: ApplicationScanResult,
  bundle: ApplicationBundle,
): DeterministicFillPlan {
  const slots = uploadFields(scan);
  const byFieldId = new Map(slots.map((slot) => [slot.field.id, slot.kind]));
  // A lone unlabelled slot on a page with no other upload is almost always the
  // résumé — but only when the page never mentions a cover letter, so a form
  // asking for "one combined PDF" is not silently given half of it.
  const singleUnknownSlot =
    slots.length === 1 && slots[0]?.kind === 'unknown'
      ? !COVER_WORDS.test(uploadFieldText(slots[0].field))
      : false;

  const actions = plan.actions.map((action) => {
    const kind = byFieldId.get(action.fieldId);
    if (!kind) return action;

    if (kind === 'resume' || (kind === 'unknown' && singleUnknownSlot)) {
      if (!bundle.resume) return action;
      return uploadAction(
        action,
        bundle.resume,
        bundle.id,
        `Attach the tailored résumé for ${bundle.company}.`,
        kind === 'unknown'
          ? ['This form has one unlabelled upload; confirm the résumé belongs there.']
          : [],
      );
    }

    if (kind === 'cover_letter') {
      if (!bundle.coverLetter) {
        return {
          ...action,
          action: 'missing_information' as const,
          requiresReview: true,
          reason: 'This form asks for a cover letter and none was generated for this job.',
          warnings: [
            ...action.warnings,
            'Generate a tailored cover letter on Internship Pilot, then send the bundle again.',
          ],
        };
      }
      return uploadAction(
        action,
        bundle.coverLetter,
        bundle.id,
        `Attach the tailored cover letter for ${bundle.company}.`,
      );
    }

    // Transcript, portfolio, "other", and an ambiguous slot on a multi-upload
    // form. Nothing in the bundle answers these, and guessing would attach the
    // wrong document to a real application.
    return {
      ...action,
      action: 'missing_information' as const,
      requiresReview: true,
      reason:
        kind === 'unknown'
          ? 'This upload field does not say which document it wants.'
          : `This form asks for a ${kind.replace('_', ' ')}, which is not part of the tailored bundle.`,
      warnings: [...action.warnings, 'Attach this file yourself.'],
    };
  });

  return deterministicFillPlanSchema.parse({
    ...plan,
    updatedAt: new Date().toISOString(),
    actions,
    statistics: calculatePlanStatistics(actions),
  });
}

/** True when an action's document reference points into the bundle store. */
export function isBundleDocumentReference(documentId: string | undefined): boolean {
  return typeof documentId === 'string' && /^bundle-[^:]+:(resume|cover_letter)$/.test(documentId);
}
