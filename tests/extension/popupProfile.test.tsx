import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeProfileCompleteness,
  profileSchema,
  type HealthResponse,
  type ProfileCompleteness,
} from '@internship-agent/shared';
import { App } from '../../extension/src/popup/App.js';
import type { AgentStatusResult, ResumeSelection } from '../../extension/src/messaging/messages.js';
import { installChromeMock } from './setup.js';

afterEach(cleanup);

const NOW = '2026-07-26T12:00:00.000Z';

function completenessFor(overrides: Record<string, unknown> = {}): ProfileCompleteness {
  return computeProfileCompleteness(profileSchema.parse({ updatedAt: NOW, ...overrides }));
}

function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: 'ok',
    service: 'internship-application-agent',
    version: '0.1.0',
    uptimeSeconds: 12,
    checkedAt: NOW,
    ollama: {
      state: 'connected',
      baseUrl: 'http://127.0.0.1:11434',
      version: '0.5.4',
      modelCount: 1,
      selectedModel: 'qwen3.5:9b',
      selectedModelInstalled: true,
      checkedAt: NOW,
      latencyMs: 8,
    },
    database: { state: 'ready', path: ':memory:', schemaVersion: 2 },
    profileLoaded: true,
    authenticated: true,
    documentCounts: { total: 0, resumes: 0, hasDefaultResume: false },
    approvedAnswerCount: 0,
    ...overrides,
  };
}

function mountPopup(status: Partial<AgentStatusResult>): void {
  const chromeMock = installChromeMock();
  const result = {
    latencyMs: 7,
    serverUrl: 'http://127.0.0.1:4317',
    tokenConfigured: true,
    ...status,
  } satisfies AgentStatusResult;
  chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) =>
    Promise.resolve(message.type === 'GET_LAST_SCAN' ? { scan: null } : result),
  );
  chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: 'https://boards.example.com/apply/1' }]);
  chromeMock.tabs.sendMessage.mockResolvedValue({
    present: true,
    url: 'https://boards.example.com/apply/1',
    fieldsDetected: null,
  });
  render(<App />);
}

describe('popup profile completeness', () => {
  it('shows the percentage and names the missing sections', async () => {
    mountPopup({
      health: health({ profileCompleteness: completenessFor() }),
      selectedResume: null,
    });

    await waitFor(() => expect(screen.getByText('0% complete')).toBeDefined());
    // The row must say what is missing, not merely that something is.
    expect(screen.getByText(/Still needed:/)).toBeDefined();
    expect(screen.getByText(/Legal and preferred name/)).toBeDefined();
  });

  it('reports 100% and stops nagging when every required section is filled', async () => {
    const complete = computeProfileCompleteness(
      profileSchema.parse({
        updatedAt: NOW,
        personal: {
          legalFirstName: 'Jordan',
          legalLastName: 'Rivera',
          email: 'jordan@example.com',
          phone: '+1-555-0100',
          address: {
            line1: '1 Main Street',
            city: 'Boston',
            state: 'MA',
            postalCode: '02110',
            country: 'United States',
          },
          github: 'https://github.com/example',
        },
        education: [
          { id: 'e1', institution: 'Northeastern University', graduationDate: '2027-05' },
        ],
        experience: [{ id: 'x1', employer: 'Example Labs', title: 'Intern' }],
        skills: { technical: ['Verilog'] },
        eligibility: {
          workAuthorization: 'US citizen',
          requiresFutureSponsorship: false,
          willingToRelocate: true,
          earliestStartDate: '2027-06-01',
        },
        preferences: { targetRoles: ['Embedded Intern'], preferredLocations: ['Boston, MA'] },
      }),
    );

    mountPopup({ health: health({ profileCompleteness: complete }), selectedResume: null });

    await waitFor(() => expect(screen.getByText('100% complete')).toBeDefined());
    expect(screen.getByText(/All 10 required sections are filled in\./)).toBeDefined();
    expect(screen.queryByText(/Still needed:/)).toBeNull();
  });

  it('says the profile has not been created rather than showing 0%', async () => {
    mountPopup({ health: health({ profileLoaded: false }), selectedResume: null });

    await waitFor(() => expect(screen.getByText('Not created')).toBeDefined());
    expect(screen.getByText(/fill in at least your name/)).toBeDefined();
  });

  it('asks for a token instead of implying the profile is empty', async () => {
    mountPopup({ health: health({ authenticated: false }), tokenConfigured: false });

    await waitFor(() => expect(screen.getAllByText('Token required').length).toBeGreaterThan(0));
    expect(screen.getByText(/Paste the agent server token/)).toBeDefined();
  });

  it('distinguishes a saved-but-unreadable profile from a missing one', async () => {
    mountPopup({
      health: health({ profileLoaded: true, profileCompleteness: undefined }),
      selectedResume: null,
    });

    await waitFor(() => expect(screen.getByText('Saved, unreadable')).toBeDefined());
    expect(screen.getByText(/could not be read against the current schema/)).toBeDefined();
  });
});

describe('popup selected resume', () => {
  it('names the explicitly chosen resume', async () => {
    const selection: ResumeSelection = {
      documentId: 'doc-1',
      name: 'Computer Engineering Resume',
      reason: 'user_selected',
    };
    mountPopup({ health: health(), selectedResume: selection });

    await waitFor(() => expect(screen.getByText('Computer Engineering Resume')).toBeDefined());
    expect(screen.getByText('Chosen explicitly for the next application.')).toBeDefined();
  });

  it('names the default resume and says it is the default', async () => {
    mountPopup({
      health: health(),
      selectedResume: { documentId: 'doc-2', name: 'General Resume', reason: 'default' },
    });

    await waitFor(() => expect(screen.getByText('General Resume')).toBeDefined());
    expect(screen.getByText('Your default resume.')).toBeDefined();
  });

  it('says none is registered when the library is empty', async () => {
    mountPopup({ health: health(), selectedResume: null });

    await waitFor(() => expect(screen.getByText('None registered')).toBeDefined());
    expect(screen.getByText(/Add a resume in settings/)).toBeDefined();
  });

  it('does not claim there is no resume when the list could not be read', async () => {
    // `selectedResume` omitted entirely: we could not ask, which is not the same
    // as asking and finding nothing.
    mountPopup({ health: health() });

    await waitFor(() => expect(screen.getByText(/document list could not be read/)).toBeDefined());
    expect(screen.queryByText('None registered')).toBeNull();
  });
});

describe('popup milestone gating', () => {
  it('enables analysis and keeps filling disabled while settings stays reachable', async () => {
    mountPopup({ health: health(), selectedResume: null });

    await waitFor(() => expect(screen.getAllByText('Connected').length).toBeGreaterThan(0));

    expect(screen.getByRole('button', { name: 'Analyze Application' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Review Scan' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Fill Approved Fields' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Open Settings' })).toHaveProperty('disabled', false);
    expect(screen.getByText('Not analyzed yet')).toBeDefined();
  });

  it('opens the real settings page when Open Settings is clicked', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockResolvedValue({
      health: health(),
      latencyMs: 5,
      serverUrl: 'http://127.0.0.1:4317',
      tokenConfigured: true,
      selectedResume: null,
    } satisfies AgentStatusResult);
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com/apply' }]);
    render(<App />);

    await waitFor(() => expect(screen.getAllByText('Connected').length).toBeGreaterThan(0));
    screen.getByRole('button', { name: 'Open Settings' }).click();

    expect(chromeMock.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });
});
