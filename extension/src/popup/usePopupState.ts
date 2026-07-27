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
import { traceFailure } from '../utils/trace.js';

export interface TabInfo {
  id: number | null;
  domain: string | null;
  url: string | null;
  contentScriptReachable: boolean;
  fieldsDetected: number | null;
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
  analyze: () => Promise<void>;
  cancel: () => Promise<void>;
  plan: DeterministicFillPlan | null;
  report: FillRunReport | null;
  fillState: FillUiState;
  fillProgress: FillProgress | null;
  fillError: AgentError | null;
  buildPlan: () => Promise<void>;
  execute: () => Promise<void>;
  cancelFill: () => Promise<void>;
}

const EMPTY_TAB: TabInfo = {
  id: null,
  domain: null,
  url: null,
  contentScriptReachable: false,
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
  if (tab.id !== undefined && /^https?:/.test(tab.url)) {
    try {
      const pong: unknown = await chrome.tabs.sendMessage(tab.id, { type: 'CONTENT_PING' });
      contentScriptReachable = Boolean(pong);
    } catch {
      contentScriptReachable = false;
    }
  }
  return {
    id: tab.id ?? null,
    domain,
    url: tab.url,
    contentScriptReachable,
    fieldsDetected: null,
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
        setTab({
          ...tabResult,
          fieldsDetected:
            lastResult.scan?.url === tabResult.url ? lastResult.scan.statistics.total : null,
        });
        setScan(lastResult.scan ?? null);
        if (lastResult.scan) setScanState('completed');
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

  const analyze = useCallback(async (): Promise<void> => {
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
      } else {
        setScanError(response.error);
        setScanState(response.error.code === 'SCAN_CANCELLED' ? 'cancelled' : 'failed');
      }
    } catch (cause) {
      setScanError(internalError(cause));
      setScanState('failed');
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

  const buildPlan = useCallback(async (): Promise<void> => {
    setFillState('planning');
    setFillError(null);
    const response = await sendMessage({
      type: 'BUILD_DETERMINISTIC_PLAN',
      ...(scan?.id ? { scanId: scan.id } : {}),
    });
    if ('plan' in response) {
      setPlan(response.plan);
      setReport(null);
      setFillState('ready_for_review');
    } else {
      setFillError(response.error);
      setFillState('failed');
    }
  }, [scan?.id]);

  const execute = useCallback(async (): Promise<void> => {
    if (!plan) return;
    setFillState('filling');
    setFillError(null);
    setFillProgress(null);
    const response = await sendMessage({
      type: 'EXECUTE_APPROVED_ACTIONS',
      targetUrl: plan.url,
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
  }, [plan]);

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
    execute,
    cancelFill,
  };
}
