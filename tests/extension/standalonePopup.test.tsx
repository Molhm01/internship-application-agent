import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationAutofillReportSchema,
  applicationScanResultSchema,
  RECONNECT_MESSAGE,
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
    credentialFields: 0,
    navigationActions: 0,
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
        case 'ENSURE_CONTENT_SCRIPT':
          return Promise.resolve({ reachable: true, injected: false });
        case 'GET_PORTAL_ROUTE':
          return Promise.resolve({ decision: 'none', reason: 'no routes' });
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

    // The five named counts, shown after the run rather than a field-by-field
    // list to work through before it.
    await waitFor(() => expect(screen.getByText('Automatically filled: 1')).toBeDefined());
    expect(screen.getByText('Fields detected: 2')).toBeDefined();
    expect(screen.getByText('Documents uploaded: 1')).toBeDefined();
    expect(screen.getByText('Needs confirmation: 1')).toBeDefined();
    expect(screen.getByText('Could not fill: 0')).toBeDefined();
    expect(screen.getByText(/final Submit button was never clicked/i)).toBeDefined();
    // The unresolved question is offered as something the user can jump to.
    expect(screen.getByRole('button', { name: 'Gender' })).toBeDefined();

    const messageTypes = chromeMock.runtime.sendMessage.mock.calls.map(
      ([message]) => (message as { type: string }).type,
    );
    // Only the unresolved question is listed. The verified one is not, and
    // neither is a field-by-field walk of everything detected.
    expect(screen.queryByRole('button', { name: 'First name' })).toBeNull();
    // Reviewing every field is a secondary link, not a step before autofill.
    expect(screen.getByRole('button', { name: 'Preview detected fields' })).toBeDefined();
    expect(screen.queryByText('Review every detected field')).toBeNull();

    expect(messageTypes).toContain('RUN_APPLICATION_AUTOFILL');
    // One button, one run: the popup no longer drives a four-step sequence.
    expect(messageTypes).not.toContain('BUILD_DETERMINISTIC_PLAN');
    expect(messageTypes).not.toContain('APPROVE_SAFE_ACTIONS');
    expect(messageTypes.some((type) => type.includes('SESSION'))).toBe(false);
    expect(autofillReport.submissionPrevented).toBe(true);
  });

  it('shows the three choices when the strategy is Ask every time', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: URL }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ present: true, url: URL });
    const loginScan = applicationScanResultSchema.parse({
      ...scan,
      id: 'scan-login',
      navigation: {
        kind: 'login',
        requiresCredentials: true,
        actions: [
          { intent: 'login', label: 'Login', selector: '#loginButton', endsApplication: false },
          {
            intent: 'create_account',
            label: 'New User',
            selector: '#newUserLink',
            endsApplication: false,
          },
          {
            intent: 'apply_as_guest',
            label: 'Apply as Guest',
            selector: '#guestLink',
            endsApplication: false,
          },
        ],
      },
    });
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      switch (message.type) {
        case 'AGENT_STATUS_REQUEST':
          return Promise.resolve({
            health: health(),
            latencyMs: 1,
            serverUrl: 'http://127.0.0.1:4317',
            tokenConfigured: true,
          });
        case 'ENSURE_CONTENT_SCRIPT':
          return Promise.resolve({ reachable: true, injected: false });
        case 'GET_PORTAL_ROUTE':
          // "Ask every time": the three routes, and no decision taken.
          return Promise.resolve({
            decision: 'ask',
            reason: 'You asked to be shown the choice on every employer portal.',
            options: loginScan.navigation?.actions ?? [],
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
          return Promise.resolve({ type: 'SCAN_COMPLETE', result: loginScan });
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    render(<App />);
    expect(await screen.findByText('Page: Sign-in page')).toBeDefined();
    expect(screen.getByText(/This page is asking how you want to apply/)).toBeDefined();
    // Each route is named in the user's words, with the page's own wording kept
    // alongside so they can find the control the ATS actually rendered.
    expect(screen.getByText('Create employer account')).toBeDefined();
    expect(screen.getByText(/the page calls this .New User./)).toBeDefined();
    expect(screen.getByText('Apply as guest')).toBeDefined();
    expect(screen.getByText('I already have an account')).toBeDefined();
    expect(screen.getByText(/shown the choice on every employer portal/)).toBeDefined();
    // Nothing on a sign-in page is fillable, and the button says so.
    expect(screen.getByRole('button', { name: 'Nothing to autofill on this page' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Autofill Application' })).toBeNull();
  });

  it('takes the saved route instead of asking, and rescans where it lands', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: URL }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ present: true, url: URL });
    const followed: string[] = [];
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      followed.push(message.type);
      switch (message.type) {
        case 'AGENT_STATUS_REQUEST':
          return Promise.resolve({
            health: health(),
            latencyMs: 1,
            serverUrl: 'http://127.0.0.1:4317',
            tokenConfigured: true,
          });
        case 'ENSURE_CONTENT_SCRIPT':
          return Promise.resolve({ reachable: true, injected: false });
        case 'GET_PORTAL_ROUTE':
          // What "Create an account when required" resolves to on a portal that
          // offers a New User route.
          return Promise.resolve({
            decision: 'act',
            reason: 'You asked the agent to create an employer account when one is needed.',
            takenIntent: 'create_account',
          });
        case 'FOLLOW_PORTAL_ROUTE':
          return Promise.resolve({
            decision: 'act',
            reason: 'You asked the agent to create an employer account when one is needed.',
            takenIntent: 'create_account',
            url: 'https://boards.greenhouse.io/acme/jobs/123/register',
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
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    render(<App />);
    // The decision is stated before it is taken, naming the route and the reason.
    const proceed = await screen.findByRole('button', { name: 'Continue on this page' });
    expect(
      screen.getByText(/Create employer account: You asked the agent to create/),
    ).toBeDefined();
    // And it is emphatically not the old refusal.
    expect(screen.queryByText(/does not pick between/)).toBeNull();

    fireEvent.click(proceed);
    await waitFor(() => expect(followed).toContain('FOLLOW_PORTAL_ROUTE'));
  });

  it('says to reload the page — not that there is no form — when the content script is gone', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: URL }]);
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      switch (message.type) {
        case 'AGENT_STATUS_REQUEST':
          return Promise.resolve({
            health: health(),
            latencyMs: 1,
            serverUrl: 'http://127.0.0.1:4317',
            tokenConfigured: true,
          });
        case 'ENSURE_CONTENT_SCRIPT':
          // Reinjection was attempted and the page still will not answer.
          return Promise.resolve({
            reachable: false,
            injected: true,
            reason: RECONNECT_MESSAGE,
          });
        case 'GET_LAST_SCAN':
          return Promise.resolve({ scan: null });
        case 'GET_FILL_PLAN':
          return Promise.resolve({ plan: null, report: null });
        case 'GET_ACTIVE_BUNDLE':
          return Promise.resolve({ data: null });
        case 'GET_AUTOFILL_REPORT':
          return Promise.resolve({ report: null });
        case 'GET_PORTAL_ROUTE':
          return Promise.resolve({ decision: 'none', reason: 'no routes' });
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    render(<App />);

    // Said in both places it matters: beside the site row, and where the
    // application panel would otherwise have rendered a verdict about the page.
    await waitFor(() => expect(screen.getAllByText(RECONNECT_MESSAGE)).toHaveLength(2));
    expect(screen.queryByText('No supported application form detected on this page')).toBeNull();
    // Nor is the user told to reinstall anything.
    expect(screen.queryByText(/reinstall/i)).toBeNull();
    // A disconnected page is never scanned: there is nothing there to scan.
    const attempted = chromeMock.runtime.sendMessage.mock.calls.map(
      ([message]) => (message as { type: string }).type,
    );
    expect(attempted).not.toContain('SCAN_APPLICATION');
  });

  it('still names the ATS from the hostname when the page cannot be reached at all', async () => {
    const chromeMock = installChromeMock();
    const icims = 'https://careers2-quanta.icims.com/jobs/12345/login';
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: icims }]);
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      switch (message.type) {
        case 'AGENT_STATUS_REQUEST':
          return Promise.resolve({
            health: health(),
            latencyMs: 1,
            serverUrl: 'http://127.0.0.1:4317',
            tokenConfigured: true,
          });
        case 'ENSURE_CONTENT_SCRIPT':
          return Promise.resolve({ reachable: false, injected: true, reason: RECONNECT_MESSAGE });
        case 'GET_LAST_SCAN':
          return Promise.resolve({ scan: null });
        case 'GET_FILL_PLAN':
          return Promise.resolve({ plan: null, report: null });
        case 'GET_ACTIVE_BUNDLE':
          return Promise.resolve({ data: null });
        case 'GET_AUTOFILL_REPORT':
          return Promise.resolve({ report: null });
        case 'GET_PORTAL_ROUTE':
          return Promise.resolve({ decision: 'none', reason: 'no routes' });
        default:
          throw new Error(`Unexpected message: ${message.type}`);
      }
    });

    render(<App />);

    // No scan, no content script, and the vendor is still named. "Not detected"
    // here would read as "this site is unsupported", which is a different and
    // wrong diagnosis.
    expect(await screen.findByText('iCIMS')).toBeDefined();
    expect(screen.queryByText('Not detected')).toBeNull();
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
        case 'ENSURE_CONTENT_SCRIPT':
          return Promise.resolve({ reachable: true, injected: false });
        case 'GET_PORTAL_ROUTE':
          return Promise.resolve({ decision: 'none', reason: 'no routes' });
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
    expect(
      screen.getByText(/✓ Tailored cover letter \(Cover-Letter-Northwind\.pdf\)/),
    ).toBeDefined();
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
      if (message.type === 'ENSURE_CONTENT_SCRIPT')
        return Promise.resolve({ reachable: true, injected: false });
      if (message.type === 'GET_PORTAL_ROUTE')
        return Promise.resolve({ decision: 'none', reason: 'no routes' });
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
  it('still scans a page deterministically when the agent server is offline', async () => {
    // Deterministic autofill reads the DOM and the saved profile; it needs no
    // model and no local server. Gating the scan on server health would make a
    // stopped background process look like an unsupported page.
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: URL }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ present: true, url: URL });
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'AGENT_STATUS_REQUEST') {
        // Exactly what an unreachable server looks like: no health at all.
        return Promise.resolve({
          error: {
            code: 'SERVER_UNREACHABLE',
            message: 'The local agent server is not running.',
            recoverable: true,
            suggestedAction: 'Start it with npm run start:server.',
            debugContext: {},
          },
          serverUrl: 'http://127.0.0.1:4317',
          tokenConfigured: true,
        });
      }
      if (message.type === 'ENSURE_CONTENT_SCRIPT')
        return Promise.resolve({ reachable: true, injected: false });
      if (message.type === 'GET_PORTAL_ROUTE')
        return Promise.resolve({ decision: 'none', reason: 'no routes' });
      if (message.type === 'GET_LAST_SCAN') return Promise.resolve({ scan: null });
      if (message.type === 'GET_FILL_PLAN') return Promise.resolve({ plan: null, report: null });
      if (message.type === 'GET_ACTIVE_BUNDLE') return Promise.resolve({ bundle: null });
      if (message.type === 'GET_AUTOFILL_REPORT') return Promise.resolve({ report: null });
      if (message.type === 'SCAN_APPLICATION') {
        return Promise.resolve({ type: 'SCAN_COMPLETE', result: scan });
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });

    render(<App />);

    // The page is still analyzed and its questions still counted.
    expect(await screen.findByText(/Page analysis:/)).toBeDefined();
    // And the popup says plainly that deterministic filling still works.
    expect(screen.getByText(/Deterministic autofill still works/)).toBeDefined();
  });
  it('names the ATS from the page itself, even when the scan fails', async () => {
    // "ATS: Not detected" used to be a side effect of any scan failure, because
    // the popup read the vendor off the scan result alone. On a page the
    // detector recognizes that reads as "this site is unsupported", which sent
    // the last investigation towards the detector instead of the validator.
    const chromeMock = installChromeMock();
    const icimsUrl = 'https://careers2-quanta.icims.com/jobs/12345/login';
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: icimsUrl }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({
      present: true,
      url: icimsUrl,
      fieldsDetected: null,
      ats: {
        id: 'icims',
        displayName: 'iCIMS',
        confidence: 0.98,
        reason: 'hostname careers2-quanta.icims.com matches iCIMS',
      },
    });
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'AGENT_STATUS_REQUEST') {
        return Promise.resolve({
          health: health(),
          latencyMs: 1,
          serverUrl: 'http://127.0.0.1:4317',
          tokenConfigured: true,
        });
      }
      if (message.type === 'ENSURE_CONTENT_SCRIPT')
        return Promise.resolve({ reachable: true, injected: false });
      if (message.type === 'GET_PORTAL_ROUTE')
        return Promise.resolve({ decision: 'none', reason: 'no routes' });
      if (message.type === 'GET_LAST_SCAN') return Promise.resolve({ scan: null });
      if (message.type === 'GET_FILL_PLAN') return Promise.resolve({ plan: null, report: null });
      if (message.type === 'GET_ACTIVE_BUNDLE') return Promise.resolve({ data: null });
      if (message.type === 'GET_AUTOFILL_REPORT') return Promise.resolve({ report: null });
      if (message.type === 'SCAN_APPLICATION') {
        return Promise.resolve({
          type: 'SCAN_FAILED',
          error: {
            code: 'INVALID_SCAN_RESULT',
            // The shape of the real failure: a schema rejection whose message is
            // a JSON dump naming every accepted value.
            message:
              'The scan of this page did not match what this build expects (fields.0.fieldType). ' +
              JSON.stringify([
                { code: 'invalid_enum_value', options: ['text', 'textarea', 'email'] },
              ]),
            recoverable: true,
            suggestedAction: 'Rebuild and reload the extension.',
            debugContext: {},
          },
        });
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });

    render(<App />);

    expect(await screen.findByText('iCIMS')).toBeDefined();
  });

  it('shows one sentence for a failed scan, never the raw validation JSON', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: URL }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ present: true, url: URL });
    const rawZodDump = JSON.stringify([
      {
        code: 'invalid_enum_value',
        options: ['text', 'textarea', 'email', 'tel', 'number', 'contenteditable', 'unknown'],
        received: 'password',
        path: ['fields', 0, 'fieldType'],
      },
    ]);
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'AGENT_STATUS_REQUEST') {
        return Promise.resolve({
          health: health(),
          latencyMs: 1,
          serverUrl: 'http://127.0.0.1:4317',
          tokenConfigured: true,
        });
      }
      if (message.type === 'ENSURE_CONTENT_SCRIPT')
        return Promise.resolve({ reachable: true, injected: false });
      if (message.type === 'GET_PORTAL_ROUTE')
        return Promise.resolve({ decision: 'none', reason: 'no routes' });
      if (message.type === 'GET_LAST_SCAN') return Promise.resolve({ scan: null });
      if (message.type === 'GET_FILL_PLAN') return Promise.resolve({ plan: null, report: null });
      if (message.type === 'GET_ACTIVE_BUNDLE') return Promise.resolve({ data: null });
      if (message.type === 'GET_AUTOFILL_REPORT') return Promise.resolve({ report: null });
      if (message.type === 'SCAN_APPLICATION') {
        return Promise.resolve({
          type: 'SCAN_FAILED',
          error: {
            code: 'INVALID_SCAN_RESULT',
            message: rawZodDump,
            recoverable: true,
            suggestedAction: 'Rebuild and reload the extension.',
            debugContext: { issues: [{ code: 'invalid_enum_value', path: 'fields.0.fieldType' }] },
          },
        });
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });

    render(<App />);

    expect(
      await screen.findByText(
        'Application analysis failed. Reload the extension and page, then try again.',
      ),
    ).toBeDefined();

    const rendered = document.body.textContent ?? '';
    // None of the dump reaches the screen — not the JSON, not the code, and
    // above all not the accepted-value list that reads as a false verdict.
    expect(rendered).not.toContain('invalid_enum_value');
    expect(rendered).not.toContain('contenteditable');
    expect(rendered).not.toContain('INVALID_SCAN_RESULT');
    expect(rendered).not.toContain('{');
    expect(rendered).not.toContain('password');
  });
});
