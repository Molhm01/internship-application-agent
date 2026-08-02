import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationAutofillReportSchema,
  applicationScanResultSchema,
  type HealthResponse,
} from '@internship-agent/shared';
import { App } from '../../extension/src/popup/App.js';
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

const autofillReport = applicationAutofillReportSchema.parse({
  id: 'autofill-standalone',
  scanIds: [scan.id],
  startedAt: NOW,
  completedAt: NOW,
  url: URL,
  ats: 'greenhouse',
  iterations: 1,
  fieldsFound: 2,
  fieldsCompleted: 2,
  fieldsVerified: 1,
  documentsAttached: 1,
  manualBlockers: 1,
  status: 'completed_with_review',
  results: [
    {
      fieldId: 'first-name',
      question: 'First name',
      action: 'fill_text',
      source: 'profile',
      confidence: 1,
      verification: 'verified',
      reason: 'Exact saved profile value.',
    },
    {
      fieldId: 'gender',
      question: 'Gender',
      action: 'manual_review',
      source: 'none',
      confidence: 0,
      sensitive: true,
      verification: 'not_attempted',
      reviewReason: 'manual_required',
      reason: 'This question is only ever answered from an explicit saved answer.',
    },
  ],
});

describe('standalone popup autofill', () => {
  it('runs the whole autofill from one button, with no ApplicationSession anywhere', async () => {
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
        case 'GET_ACTIVE_BUNDLE':
          return Promise.resolve({ data: null });
        case 'GET_AUTOFILL_REPORT':
          return Promise.resolve({ report: null });
        case 'SCAN_APPLICATION':
          return Promise.resolve({ type: 'SCAN_COMPLETE', result: scan });
        case 'RUN_APPLICATION_AUTOFILL':
          return Promise.resolve({ report: autofillReport });
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    render(<App />);
    const autofill = await screen.findByRole('button', { name: 'Autofill Application' });
    fireEvent.click(autofill);

    await waitFor(() => expect(screen.getByText(/Filled: 1/)).toBeDefined());
    expect(screen.getByText(/Uploaded: 1/)).toBeDefined();
    expect(screen.getByText(/Needs review: 1/)).toBeDefined();
    expect(screen.getByText(/final Submit button was never clicked/i)).toBeDefined();
    // The unresolved question is offered as something the user can jump to.
    expect(screen.getByRole('button', { name: 'Gender' })).toBeDefined();

    const messageTypes = chromeMock.runtime.sendMessage.mock.calls.map(
      ([message]) => (message as { type: string }).type,
    );
    expect(messageTypes).toContain('RUN_APPLICATION_AUTOFILL');
    // One button, one run: the popup no longer drives a four-step sequence.
    expect(messageTypes).not.toContain('BUILD_DETERMINISTIC_PLAN');
    expect(messageTypes).not.toContain('APPROVE_SAFE_ACTIONS');
    expect(messageTypes.some((type) => type.includes('SESSION'))).toBe(false);
    expect(autofillReport.submissionPrevented).toBe(true);
  });

  it('names the loaded application and its tailored documents', async () => {
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
          });
        case 'GET_LAST_SCAN':
          return Promise.resolve({ scan: null });
        case 'GET_FILL_PLAN':
          return Promise.resolve({ plan: null, report: null });
        case 'GET_AUTOFILL_REPORT':
          return Promise.resolve({ report: null });
        case 'GET_ACTIVE_BUNDLE':
          return Promise.resolve({
            data: {
              id: 'bundle-1',
              websiteJobId: 'job-42',
              company: 'Northwind Robotics',
              jobTitle: 'Software Engineering Intern',
              jobDescription: '',
              officialApplicationUrl: URL,
              resume: {
                kind: 'resume',
                filename: 'Resume-Northwind.pdf',
                mimeType: 'application/pdf',
                bytesReference: 'bundle-1:resume',
                byteLength: 10,
                generatedAt: NOW,
              },
              coverLetter: {
                kind: 'cover_letter',
                filename: 'Cover-Letter-Northwind.pdf',
                mimeType: 'application/pdf',
                bytesReference: 'bundle-1:cover_letter',
                byteLength: 10,
                generatedAt: NOW,
              },
              createdAt: NOW,
            },
          });
        case 'SCAN_APPLICATION':
          return Promise.resolve({ type: 'SCAN_COMPLETE', result: scan });
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    render(<App />);
    expect(
      await screen.findByText('Ready for Northwind Robotics — Software Engineering Intern'),
    ).toBeDefined();
    expect(screen.getByText(/✓ Tailored résumé \(Resume-Northwind\.pdf\)/)).toBeDefined();
    expect(screen.getByText(/✓ Cover letter \(Cover-Letter-Northwind\.pdf\)/)).toBeDefined();
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
