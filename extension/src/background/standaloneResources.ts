import type { SavedDocument } from '@internship-agent/shared';

/**
 * Standalone autofill uses the résumé selected in extension settings, falling
 * back to the extension's own default résumé. Website/session document IDs are
 * intentionally not inputs to this decision.
 */
export function selectSavedResume(
  documents: readonly SavedDocument[],
  selectedDocumentId: string | null | undefined,
  defaultResumeId: string | null | undefined,
): SavedDocument | undefined {
  return (
    documents.find((document) => document.id === selectedDocumentId) ??
    documents.find((document) => document.id === defaultResumeId)
  );
}
