import { useCallback, useEffect, useState } from 'react';
import type { AgentError, DocumentAttachmentReport } from '@internship-agent/shared';
import { sendMessage, type LatestDocumentSyncResult } from '../messaging/messages.js';

/**
 * The popup's view of the document-only path.
 *
 * Opening the popup syncs, so a résumé generated a moment ago on Internship
 * Pilot is already here by the time the user looks. A sync failure never blanks
 * the list — what this browser holds stays visible and stays attachable.
 */

export interface DocumentState {
  documents: LatestDocumentSyncResult['documents'];
  syncedAt: string | null;
  syncError: AgentError | null;
  syncing: boolean;
  attaching: boolean;
  report: DocumentAttachmentReport | null;
  attachError: AgentError | null;
  refresh: () => Promise<void>;
  attach: () => Promise<void>;
}

const EMPTY = { resume: null, coverLetter: null } as const;

export function useDocumentState(targetUrl?: string): DocumentState {
  const [documents, setDocuments] = useState<LatestDocumentSyncResult['documents']>(EMPTY);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<AgentError | null>(null);
  const [syncing, setSyncing] = useState(true);
  const [attaching, setAttaching] = useState(false);
  const [report, setReport] = useState<DocumentAttachmentReport | null>(null);
  const [attachError, setAttachError] = useState<AgentError | null>(null);

  const apply = useCallback((result: LatestDocumentSyncResult) => {
    // A transport failure resolves with an error and no payload — the worker
    // being older than this page is the common case — so the list falls back to
    // empty rather than throwing inside a render.
    setDocuments(result.documents ?? EMPTY);
    setSyncedAt(result.syncedAt ?? null);
    setSyncError(result.error ?? null);
    // Adopted rather than overwritten: an "Autofill Application" run attaches
    // documents too, and its result must be visible when the popup is reopened
    // afterwards. A report from this popup's own run is never replaced by an
    // older stored one.
    setReport((current) => current ?? result.lastReport ?? null);
  }, []);

  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      apply(await sendMessage({ type: 'SYNC_LATEST_DOCUMENTS' }));
    } finally {
      setSyncing(false);
    }
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Read first so the stored documents render immediately, then sync. The
      // list must never be empty for the length of a network round trip when
      // the files are already on this machine.
      const stored = await sendMessage({ type: 'GET_LATEST_DOCUMENTS' });
      if (!cancelled) apply(stored);
      const synced = await sendMessage({ type: 'SYNC_LATEST_DOCUMENTS' });
      if (!cancelled) {
        apply(synced);
        setSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const attach = useCallback(async () => {
    setAttaching(true);
    setReport(null);
    setAttachError(null);
    try {
      const result = await sendMessage({
        type: 'ATTACH_DOCUMENTS',
        ...(targetUrl ? { targetUrl } : {}),
      });
      if ('report' in result && result.report) {
        setReport(result.report);
      } else if ('error' in result && result.error) {
        setAttachError(result.error);
      }
    } finally {
      setAttaching(false);
    }
  }, [targetUrl]);

  return {
    documents,
    syncedAt,
    syncError,
    syncing,
    attaching,
    report,
    attachError,
    refresh,
    attach,
  };
}
