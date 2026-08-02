import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationScanResultSchema,
  fillRunReportSchema,
  profileSchema,
  type HealthResponse,
} from '@internship-agent/shared';
import { App } from '../../extension/src/popup/App.js';
import {
  approveSafeActions,
  buildDeterministicPlan,
} from '../../extension/src/planner/deterministicPlanner.js';
import { installChromeMock } from './setup.js';

afterEach(cleanup);

const NOW = '2026-07-31T12:00:00.000Z';
const URL = 'https://boards.greenhouse.io/acme/jobs/123';
const scan = applicationScanResultSchema.parse({
  id: 'scan-standalone',
  createdAt: NOW,
  url: URL,
  domain: 'boards.greenhouse.io',
  ats: {
    id: 'greenhouse',
    displayName: 'Greenhouse',
    confidence: 1,
    detectionReason: 'fixture',
    supported: true,
  },
  jobContext: { sourceUrl: URL },
  fields: [
    {
      id: 'first-name',
      pageId: 'page-1',
      label: 'First name',
      normalizedLabel: 'first name',
      canonicalKey: 'first_name',
      fieldType: 'text',
      question: 'First name',
      selector: '#first-name',
      required: true,
      visible: true,
      disabled: false,
      confidence: 1,
      sourceSignals: ['label_for'],
    },
  ],
  warnings: [],
  statistics: {
    total: 1,
    supported: 1,
    unknown: 0,
    required: 1,
    optional: 0,
    text: 1,
    textarea: 0,
    select: 0,
    combobox: 0,
    radio: 0,
    checkbox: 0,
    file: 0,
  },
  durationMs: 5,
  status: 'completed',
  readOnly: true,
});
const plan = buildDeterministicPlan(
  scan,
  profileSchema.parse({
    updatedAt: NOW,
    personal: { legalFirstName: 'Jordan', address: {} },
  }),
  [],
);
const approvedPlan = approveSafeActions(plan);
const report = fillRunReportSchema.parse({
  id: 'fill-standalone',
  planId: plan.id,
  scanId: scan.id,
  startedAt: NOW,
  completedAt: NOW,
  url: URL,
  ats: 'greenhouse',
  totalActions: 1,
  approvedActions: 1,
  verifiedActions: 1,
  failedActions: 0,
  reviewActions: 0,
  skippedActions: 0,
  unsupportedActions: 0,
  status: 'completed',
  results: [
    {
      actionId: approvedPlan.actions[0]!.id,
      fieldId: 'first-name',
      status: 'verified',
      expectedValue: 'Jordan',
      actualValue: 'Jordan',
      attempts: 1,
      durationMs: 2,
    },
  ],
  warnings: [],
  submitted: false,
});

function health(): HealthResponse {
  return {
    status: 'ok',
    service: 'internship-application-agent',
    version: '1.0.0',
    uptimeSeconds: 1,
    checkedAt: NOW,
    ollama: {
      state: 'connected',
      baseUrl: 'http://127.0.0.1:11434',
      modelCount: 1,
      selectedModel: 'local-model',
      selectedModelInstalled: true,
      checkedAt: NOW,
      latencyMs: 1,
    },
    database: { state: 'ready', path: ':memory:', schemaVersion: 1 },
    profileLoaded: true,
    authenticated: true,
  };
}

describe('standalone popup autofill', () => {
  it('detects and fills the current page without requesting an ApplicationSession', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: URL }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ present: true, url: URL });
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      switch (message.type) {
        case 'AGENT_STATUS_REQUEST':
          return Promise.resolve({
            health: health(),
            latencyMs: 1,
            serverUrl: 'http://127.0.0.1:4317',
            tokenConfigured: true,
            selectedResume: {
              documentId: 'resume-local',
              name: 'Locally saved resume',
              reason: 'user_selected',
            },
          });
        case 'GET_LAST_SCAN':
          return Promise.resolve({ scan: null });
        case 'GET_FILL_PLAN':
          return Promise.resolve({ plan: null, report: null });
        case 'SCAN_APPLICATION':
          return Promise.resolve({ type: 'SCAN_COMPLETE', result: scan });
        case 'BUILD_DETERMINISTIC_PLAN':
          return Promise.resolve({ plan });
        case 'APPROVE_SAFE_ACTIONS':
          return Promise.resolve({ plan: approvedPlan });
        case 'EXECUTE_APPROVED_ACTIONS':
          return Promise.resolve({ type: 'FILL_COMPLETE', report });
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    render(<App />);
    const autofill = await screen.findByRole('button', { name: 'Autofill Application' });
    fireEvent.click(autofill);

    await waitFor(() => expect(screen.getByText(/1 verified, 0 failed/)).toBeDefined());
    const messageTypes = chromeMock.runtime.sendMessage.mock.calls.map(
      ([message]) => (message as { type: string }).type,
    );
    expect(messageTypes).toEqual(
      expect.arrayContaining([
        'SCAN_APPLICATION',
        'BUILD_DETERMINISTIC_PLAN',
        'APPROVE_SAFE_ACTIONS',
        'EXECUTE_APPROVED_ACTIONS',
      ]),
    );
    expect(messageTypes).not.toContain('GET_APPLICATION_SESSION');
    expect(report.submitted).toBe(false);
  });

  it('shows the required message when the scan finds no fields', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: URL }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ present: true, url: URL });
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'AGENT_STATUS_REQUEST') {
        return Promise.resolve({
          health: health(),
          latencyMs: 1,
          serverUrl: 'http://127.0.0.1:4317',
          tokenConfigured: true,
        });
      }
      if (message.type === 'GET_LAST_SCAN') return Promise.resolve({ scan: null });
      if (message.type === 'GET_FILL_PLAN') return Promise.resolve({ plan: null, report: null });
      if (message.type === 'SCAN_APPLICATION') {
        return Promise.resolve({
          type: 'SCAN_COMPLETE',
          result: applicationScanResultSchema.parse({
            ...scan,
            id: 'scan-empty',
            fields: [],
            statistics: {
              ...scan.statistics,
              total: 0,
              supported: 0,
              required: 0,
              text: 0,
            },
          }),
        });
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });

    render(<App />);

    expect(
      await screen.findByText('No supported application form detected on this page'),
    ).toBeDefined();
  });
});
