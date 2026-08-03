import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_ERROR_GUIDANCE,
  fillProgressMessageSchema,
  scanProgressMessageSchema,
  type AgentError,
  type ApplicationScanResult,
  type ScanProgress,
  type ScanState,
  type DeterministicFillPlan,
  type FillProgress,
  type FillRunReport,
  type FillUiState,
} from '@internship-agent/shared';
import type { AgentStatusResult } from '../messaging/messages.js';
import { sendMessage } from '../messaging/messages.js';
import { detectAtsByHostname } from '../scanner/adapters.js';
import { traceFailure } from '../utils/trace.js';

export interface TabInfo {
  id: number | null;
  domain: string | null;
  url: string | null;
  contentScriptReachable: boolean;
  /** True when the script had to be put back for this tab, i.e. it predated this build. */
  reconnected: boolean;
  fieldsDetected: number | null;
  /**
   * The ATS as the page itself reports it, independent of any scan.
   *
   * Kept separate from the scan's own `ats` so a failed scan no longer erases
   * the vendor: showing "Not detected" on a page the detector recognizes reads
   * as "this site is unsupported", which is a different and wrong diagnosis.
   */
  ats: { id: string; displayName: string; confidence: number; reason: string } | null;
}

export interface PopupState {
  status: AgentStatusResult | null;
  tab: TabInfo;
  loading: boolean;
  scanState: ScanState;
  scan: ApplicationScanResult | null;
  progress: ScanProgress | null;
  scanError: AgentError | null;
  refresh: () => void;
  analyze: () => Promise<ApplicationScanResult | null>;
  cancel: () => Promise<void>;
  plan: DeterministicFillPlan | null;
  report: FillRunReport | null;
  fillState: FillUiState;
  fillProgress: FillProgress | null;
  fillError: AgentError | null;
  buildPlan: (scanId?: string) => Promise<DeterministicFillPlan | null>;
  approveSafe: () => Promise<DeterministicFillPlan | null>;
  execute: (plan?: DeterministicFillPlan) => Promise<void>;
  cancelFill: () => Promise<void>;
}

const EMPTY_TAB: TabInfo = {
  id: null,
  domain: null,
  url: null,
  contentScriptReachable: false,
  reconnected: false,
  ats: null,
  fieldsDetected: null,
};

async function readActiveTab(): Promise<TabInfo> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return EMPTY_TAB;
  let domain: string | null = null;
  try {
    domain = new URL(tab.url).hostname;
  } catch {
    domain = null;
  }
  let contentScriptReachable = false;
  let reconnected = false;
  let ats: TabInfo['ats'] = null;
  if (tab.id !== undefined && /^https?:/.test(tab.url)) {
    // Asks the worker to ping and, if needed, put the content script back. Every
    // tab open at the moment the extension reloaded has lost its script, and
    // that used to be reported as "the content script is not reachable" with the
    // only remedy being a reinstall.
    const connection = await sendMessage({
      type: 'ENSURE_CONTENT_SCRIPT',
      tabId: tab.id,
      url: tab.url,
    });
    contentScriptReachable = connection.reachable === true;
    reconnected = connection.injected === true && contentScriptReachable;
    const reported = connection.ats;
    // An older content script answers a ping without this key. Treating that
    // as "no ATS" is correct and keeps a mixed-version install working.
    if (reported && typeof reported.displayName === 'string') ats = reported;
  }
  // The hostname alone identifies every branded ATS, so the vendor stays visible
  // even when the page cannot be reached at all.
  if (!ats && domain) ats = detectAtsByHostname(domain);
  return {
    id: tab.id ?? null,
    domain,
    url: tab.url,
    contentScriptReachable,
    reconnected,
    fieldsDetected: null,
    ats,
  };
}

function internalError(cause: unknown): AgentError {
  return {
    code: 'INTERNAL_ERROR',
    message: `The popup could not read its own state: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE.INTERNAL_ERROR,
    debugContext: {},
  };
}

export function usePopupState(): PopupState {
  const [status, setStatus] = useState<AgentStatusResult | null>(null);
  const [tab, setTab] = useState<TabInfo>(EMPTY_TAB);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scan, setScan] = useState<ApplicationScanResult | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [scanError, setScanError] = useState<AgentError | null>(null);
  const [plan, setPlan] = useState<DeterministicFillPlan | null>(null);
  const [report, setReport] = useState<FillRunReport | null>(null);
  const [fillState, setFillState] = useState<FillUiState>('idle');
  const [fillProgress, setFillProgress] = useState<FillProgress | null>(null);
  const [fillError, setFillError] = useState<AgentError | null>(null);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const listener = (message: unknown): void => {
      const parsed = scanProgressMessageSchema.safeParse(message);
      if (parsed.success) setProgress(parsed.data.progress);
      const fillParsed = fillProgressMessageSchema.safeParse(message);
      if (fillParsed.success) setFillProgress(fillParsed.data.progress);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener?.(listener);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async (): Promise<void> => {
      try {
        const [statusResult, tabResult, lastResult, fillResult] = await Promise.all([
          sendMessage({ type: 'AGENT_STATUS_REQUEST' }),
          readActiveTab(),
          sendMessage({ type: 'GET_LAST_SCAN' }),
          sendMessage({ type: 'GET_FILL_PLAN' }),
        ]);
        if (cancelled) return;
        setStatus(statusResult);
        const currentScan = lastResult.scan?.url === tabResult.url ? lastResult.scan : null;
        setTab({
          ...tabResult,
          fieldsDetected: currentScan?.statistics.total ?? null,
        });
        setScan(currentScan);
        setScanState(currentScan ? 'completed' : 'idle');
        setPlan(fillResult.plan);
        setReport(fillResult.report);
        setFillError(fillResult.error ?? null);
        setFillState(fillResult.plan ? 'ready_for_review' : fillResult.error ? 'failed' : 'idle');
      } catch (cause) {
        if (cancelled) return;
        traceFailure('popup', 'status load threw', { error: String(cause) });
        setStatus({
          error: internalError(cause),
          latencyMs: 0,
          serverUrl: '',
          tokenConfigured: false,
        });
        setTab(EMPTY_TAB);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const analyze = useCallback(async (): Promise<ApplicationScanResult | null> => {
    setScanState('scanning');
    setScanError(null);
    setProgress(null);
    try {
      const response = await sendMessage({
        type: 'SCAN_APPLICATION',
        ...(tab.url ? { targetUrl: tab.url } : {}),
      });
      if (response.type === 'SCAN_COMPLETE') {
        setScan(response.result);
        setPlan(null);
        setReport(null);
        setFillState('idle');
        setTab((current) => ({ ...current, fieldsDetected: response.result.statistics.total }));
        setScanState('completed');
        return response.result;
      } else {
        setScanError(response.error);
        setScanState(response.error.code === 'SCAN_CANCELLED' ? 'cancelled' : 'failed');
        return null;
      }
    } catch (cause) {
      setScanError(internalError(cause));
      setScanState('failed');
      return null;
    }
  }, [tab.url]);

  const cancel = useCallback(async (): Promise<void> => {
    await sendMessage({
      type: 'SCAN_CANCEL',
      ...(progress?.scanId ? { scanId: progress.scanId } : {}),
      ...(tab.url ? { targetUrl: tab.url } : {}),
    });
    setScanState('cancelled');
  }, [progress?.scanId, tab.url]);

  const buildPlan = useCallback(
    async (scanId?: string): Promise<DeterministicFillPlan | null> => {
      setFillState('planning');
      setFillError(null);
      const effectiveScanId = scanId ?? scan?.id;
      const response = await sendMessage({
        type: 'BUILD_DETERMINISTIC_PLAN',
        ...(effectiveScanId ? { scanId: effectiveScanId } : {}),
      });
      if ('plan' in response) {
        setPlan(response.plan);
        setReport(null);
        setFillState('ready_for_review');
        return response.plan;
      } else {
        setFillError(response.error);
        setFillState('failed');
        return null;
      }
    },
    [scan?.id],
  );

  const approveSafe = useCallback(async (): Promise<DeterministicFillPlan | null> => {
    const response = await sendMessage({ type: 'APPROVE_SAFE_ACTIONS' });
    if ('plan' in response) {
      setPlan(response.plan);
      return response.plan;
    }
    setFillError(response.error);
    setFillState('failed');
    return null;
  }, []);

  const execute = useCallback(
    async (planOverride?: DeterministicFillPlan): Promise<void> => {
      const executablePlan = planOverride ?? plan;
      if (!executablePlan) return;
      setFillState('filling');
      setFillError(null);
      setFillProgress(null);
      const response = await sendMessage({
        type: 'EXECUTE_APPROVED_ACTIONS',
        targetUrl: executablePlan.url,
      });
      if (response.type === 'FILL_COMPLETE') {
        setReport(response.report);
        setFillState(
          response.report.status === 'completed_with_errors'
            ? 'completed_with_errors'
            : response.report.status === 'cancelled'
              ? 'cancelled'
              : 'completed',
        );
      } else {
        setFillError(response.error);
        setFillState(response.error.code === 'EXECUTION_CANCELLED' ? 'cancelled' : 'failed');
      }
    },
    [plan],
  );

  useEffect(() => {
    if (
      !loading &&
      tab.contentScriptReachable &&
      Boolean(tab.url?.startsWith('http')) &&
      scanState === 'idle'
    ) {
      void analyze();
    }
  }, [analyze, loading, scanState, tab.contentScriptReachable, tab.url]);

  const cancelFill = useCallback(async (): Promise<void> => {
    await sendMessage({
      type: 'FILL_CANCEL',
      ...(fillProgress?.runId ? { runId: fillProgress.runId } : {}),
      ...(plan?.url ? { targetUrl: plan.url } : {}),
    });
    setFillState('cancelled');
  }, [fillProgress?.runId, plan?.url]);

  return {
    status,
    tab,
    loading,
    scanState,
    scan,
    progress,
    scanError,
    refresh,
    analyze,
    cancel,
    plan,
    report,
    fillState,
    fillProgress,
    fillError,
    buildPlan,
    approveSafe,
    execute,
    cancelFill,
  };
}
