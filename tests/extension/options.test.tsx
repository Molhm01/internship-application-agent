import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeProfileCompleteness,
  profileSchema,
  type ApprovedAnswer,
  type Profile,
  type SavedDocument,
} from '@internship-agent/shared';
import type { ExtensionMessage } from '../../extension/src/messaging/messages.js';
import { App } from '../../extension/src/options/App.js';
import { installChromeMock, type ChromeMock } from './setup.js';

afterEach(cleanup);

const NOW = '2026-07-26T12:00:00.000Z';

function profileWith(overrides: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({ updatedAt: NOW, ...overrides });
}

function document(overrides: Partial<SavedDocument> = {}): SavedDocument {
  return {
    id: 'doc-1',
    name: 'Computer Engineering Resume',
    type: 'resume',
    filePath: 'C:/agent/local-data/documents/doc-1-ce.pdf',
    fileName: 'doc-1-ce.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 148_221,
    tags: ['ce'],
    targetRoles: ['Embedded Software Intern'],
    targetIndustries: [],
    isDefault: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function answer(overrides: Partial<ApprovedAnswer> = {}): ApprovedAnswer {
  return {
    id: 'ans-1',
    canonicalQuestion: 'Are you legally authorized to work in the United States?',
    aliases: ['Work authorization?'],
    answerType: 'boolean',
    answer: true,
    category: 'eligibility',
    approved: true,
    autoFillAllowed: true,
    sensitive: false,
    tailoringAllowed: false,
    requiresReview: false,
    lastUpdatedAt: NOW,
    ...overrides,
  };
}

interface Handlers {
  profileGet?: unknown;
  profileSave?: (message: Extract<ExtensionMessage, { type: 'PROFILE_SAVE' }>) => unknown;
  documents?: unknown;
  answers?: unknown;
  documentUpdate?: unknown;
  answerCreate?: unknown;
}

/** Routes each message type to a canned response, recording what was sent. */
function mockMessaging(handlers: Handlers): { chromeMock: ChromeMock; sent: ExtensionMessage[] } {
  const chromeMock = installChromeMock();
  const sent: ExtensionMessage[] = [];

  chromeMock.runtime.sendMessage.mockImplementation((message: ExtensionMessage) => {
    sent.push(message);
    switch (message.type) {
      case 'PROFILE_GET':
        return Promise.resolve(
          handlers.profileGet ?? {
            error: {
              code: 'PROFILE_MISSING',
              message: 'No profile has been created yet.',
              recoverable: true,
              suggestedAction: 'Open the extension settings.',
              debugContext: {},
            },
          },
        );
      case 'PROFILE_SAVE':
        return Promise.resolve(
          handlers.profileSave?.(message) ?? {
            data: {
              profile: profileWith(message.profile as Record<string, unknown>),
              completeness: computeProfileCompleteness(
                profileWith(message.profile as Record<string, unknown>),
              ),
            },
          },
        );
      case 'DOCUMENTS_LIST':
        return Promise.resolve(
          handlers.documents ?? { data: { documents: [], defaultResumeId: null } },
        );
      case 'DOCUMENT_UPDATE':
        return Promise.resolve(handlers.documentUpdate ?? { data: document() });
      case 'ANSWERS_LIST':
        return Promise.resolve(handlers.answers ?? { data: { answers: [] } });
      case 'ANSWER_CREATE':
        return Promise.resolve(handlers.answerCreate ?? { data: answer() });
      case 'OLLAMA_MODELS_LIST':
        return Promise.resolve({
          data: {
            models: [{ name: 'fixture-model:latest' }],
            selectedModel: 'fixture-model:latest',
            selectedModelInstalled: true,
          },
        });
      case 'AGENT_STATUS_REQUEST':
        return Promise.resolve({
          latencyMs: 2,
          serverUrl: 'http://127.0.0.1:4317',
          tokenConfigured: true,
          health: {
            status: 'ok',
            service: 'internship-application-agent',
            version: '0.1.0',
            uptimeSeconds: 1,
            checkedAt: NOW,
            ollama: {
              state: 'connected',
              baseUrl: 'http://127.0.0.1:11434',
              version: 'test',
              modelCount: 1,
              selectedModel: 'fixture-model:latest',
              selectedModelInstalled: true,
              checkedAt: NOW,
            },
            database: { state: 'ready', path: 'test.db', schemaVersion: 1 },
            profileLoaded: false,
            authenticated: true,
          },
        });
      case 'TEST_AI_GENERATION':
        return Promise.resolve({
          data: {
            connected: true,
            model: message.model,
            durationMs: 12,
            structuredOutputValid: true,
          },
        });
      default:
        return Promise.resolve({ data: {} });
    }
  });

  return { chromeMock, sent };
}

function openTab(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('options page profile editing', () => {
  it('starts from a blank draft and says nothing is saved yet', async () => {
    mockMessaging({});
    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/No profile found. Create your profile./)).toBeDefined(),
    );
    expect(screen.getByLabelText(/Legal first name/)).toHaveProperty('value', '');
    // Save is disabled until something actually changes.
    expect(screen.getByRole('button', { name: 'Save profile' })).toHaveProperty('disabled', true);
  });

  it('loads an existing profile into the form', async () => {
    const existing = profileWith({
      personal: { legalFirstName: 'Jordan', legalLastName: 'Rivera', email: 'jordan@example.com' },
    });
    mockMessaging({
      profileGet: {
        data: { profile: existing, completeness: computeProfileCompleteness(existing) },
      },
    });
    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText(/Legal first name/)).toHaveProperty('value', 'Jordan'),
    );
    expect(screen.getByLabelText(/^Email/)).toHaveProperty('value', 'jordan@example.com');
    expect(screen.queryByText(/No profile found. Create your profile./)).toBeNull();
  });

  it('shows the completeness percentage in the header', async () => {
    const existing = profileWith({
      personal: { legalFirstName: 'Jordan', legalLastName: 'Rivera' },
    });
    mockMessaging({
      profileGet: {
        data: { profile: existing, completeness: computeProfileCompleteness(existing) },
      },
    });
    render(<App />);

    await waitFor(() => expect(screen.getByText('10%')).toBeDefined());
    expect(screen.getByText('profile complete')).toBeDefined();
  });

  it('marks the draft dirty and enables saving after an edit', async () => {
    mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Legal first name/), { target: { value: 'Jordan' } });

    expect(screen.getByText('Unsaved changes.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save profile' })).toHaveProperty('disabled', false);
  });

  it('sends the edited profile and reports success', async () => {
    const { sent } = mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Legal first name/), { target: { value: 'Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(screen.getByText(/Profile saved at/)).toBeDefined());

    const save = sent.find((message) => message.type === 'PROFILE_SAVE');
    expect(save).toBeDefined();
    if (save?.type === 'PROFILE_SAVE') {
      expect(save.profile.personal.legalFirstName).toBe('Jordan');
      // Untouched fields must not be invented on the way out.
      expect(save.profile.personal.legalLastName).toBeUndefined();
      expect(save.profile.education).toEqual([]);
    }
  });

  it('blocks the save and names the bad field when validation fails locally', async () => {
    const { sent } = mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/^Email/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(screen.getByText(/1 field needs attention/)).toBeDefined());
    expect(screen.getByText(/personal\.email/)).toBeDefined();
    expect(screen.getByText(/Nothing was saved\./)).toBeDefined();
    // Nothing may reach the server when the draft is invalid.
    expect(sent.some((message) => message.type === 'PROFILE_SAVE')).toBe(false);
  });

  it('surfaces a server-side save failure with its suggested action', async () => {
    mockMessaging({
      profileSave: () => ({
        error: {
          code: 'AGENT_SERVER_UNAVAILABLE',
          message: 'Could not reach the agent server at http://127.0.0.1:4317.',
          recoverable: true,
          suggestedAction: 'Start the local agent server with `npm run dev:server`.',
          debugContext: {},
        },
      }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Legal first name/), { target: { value: 'Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(screen.getByText(/Could not reach the agent server/)).toBeDefined());
    expect(screen.getByText(/npm run dev:server/)).toBeDefined();
  });

  it('shows a retry control when the profile cannot be loaded', async () => {
    mockMessaging({
      profileGet: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The stored profile could not be read.',
          recoverable: false,
          suggestedAction: 'Re-enter the affected sections.',
          debugContext: {},
        },
      },
    });
    render(<App />);

    await waitFor(() => expect(screen.getByText(/stored profile could not be read/)).toBeDefined());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });
});

describe('options page repeated sections', () => {
  it('adds and removes an education entry without inventing content', async () => {
    mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Education');
    expect(screen.getByText('No schools added yet.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Add school' }));

    // A new entry is blank; nothing is prefilled.
    expect(screen.getByLabelText(/Institution/)).toHaveProperty('value', '');
    expect(screen.getByLabelText(/^GPA$/)).toHaveProperty('value', '');
    expect(screen.queryByText('No schools added yet.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('No schools added yet.')).toBeDefined();
  });

  it('parses comma-separated skills into a list', async () => {
    const { sent } = mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Skills and activities');
    fireEvent.change(screen.getByLabelText('Technical skills'), {
      target: { value: 'Verilog, FPGA bring-up,  PCB layout ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(sent.some((m) => m.type === 'PROFILE_SAVE')).toBe(true));
    const save = sent.find((message) => message.type === 'PROFILE_SAVE');
    if (save?.type === 'PROFILE_SAVE') {
      expect(save.profile.skills.technical).toEqual(['Verilog', 'FPGA bring-up', 'PCB layout']);
    }
  });
});

describe('options page sensitive answer policies', () => {
  it('defaults every category to no policy and says what that means', async () => {
    mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Sensitive answers');

    expect(screen.getByText(/These questions are never guessed/)).toBeDefined();
    // Every category starts unset, and the UI states the fallback explicitly.
    expect(screen.getAllByText(/No policy — ask me every time/).length).toBeGreaterThan(10);
    expect(screen.getByLabelText('Race')).toHaveProperty('value', 'none');
  });

  it('stores a chosen policy and only asks for a value when auto-filling', async () => {
    const { sent } = mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Sensitive answers');

    fireEvent.change(screen.getByLabelText('Veteran status'), {
      target: { value: 'decline_to_answer' },
    });
    // A declined category needs no stored value.
    expect(screen.queryByLabelText('Exact answer to use')).toBeNull();

    fireEvent.change(screen.getByLabelText('Gender'), { target: { value: 'approved_auto_fill' } });
    const valueInput = screen.getByLabelText('Exact answer to use');
    fireEvent.change(valueInput, { target: { value: 'Prefer not to disclose' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(sent.some((m) => m.type === 'PROFILE_SAVE')).toBe(true));

    const save = sent.find((message) => message.type === 'PROFILE_SAVE');
    if (save?.type === 'PROFILE_SAVE') {
      const policies = save.profile.sensitivePolicies;
      expect(policies).toContainEqual({ category: 'veteran_status', policy: 'decline_to_answer' });
      expect(policies).toContainEqual({
        category: 'gender',
        policy: 'approved_auto_fill',
        value: 'Prefer not to disclose',
      });
      // Categories the user never touched must not appear at all.
      expect(policies.some((policy) => policy.category === 'race')).toBe(false);
    }
  });

  it('drops the stored value when a category moves off auto-fill', async () => {
    const { sent } = mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Sensitive answers');
    fireEvent.change(screen.getByLabelText('Gender'), { target: { value: 'approved_auto_fill' } });
    fireEvent.change(screen.getByLabelText('Exact answer to use'), { target: { value: 'Woman' } });
    fireEvent.change(screen.getByLabelText('Gender'), { target: { value: 'leave_blank' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(sent.some((m) => m.type === 'PROFILE_SAVE')).toBe(true));

    const save = sent.find((message) => message.type === 'PROFILE_SAVE');
    if (save?.type === 'PROFILE_SAVE') {
      expect(save.profile.sensitivePolicies).toEqual([
        { category: 'gender', policy: 'leave_blank' },
      ]);
    }
  });
});

describe('options page documents', () => {
  it('says the library is empty rather than showing an empty table', async () => {
    mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Documents');
    await waitFor(() => expect(screen.getByText(/No documents registered yet/)).toBeDefined());
  });

  it('lists a registered document with its default state', async () => {
    mockMessaging({
      documents: { data: { documents: [document()], defaultResumeId: 'doc-1' } },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Documents');
    await waitFor(() => expect(screen.getByText('Computer Engineering Resume')).toBeDefined());

    const row = screen.getByText('Computer Engineering Resume').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Default')).toBeDefined();
    expect(within(row!).getByText('doc-1-ce.pdf')).toBeDefined();
    expect(within(row!).getByText('145 KB')).toBeDefined();
  });

  it('refuses a file whose type is not in the allowlist, without calling the server', async () => {
    const { sent } = mockMessaging({
      documents: { data: { documents: [], defaultResumeId: null } },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Documents');
    await waitFor(() => expect(screen.getByLabelText('File')).toBeDefined());

    const input = screen.getByLabelText('File');
    const file = new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    fireEvent.click(screen.getByRole('button', { name: 'Register document' }));

    await waitFor(() => expect(screen.getByText(/not an accepted document format/)).toBeDefined());
    expect(sent.some((message) => message.type === 'DOCUMENT_CREATE')).toBe(false);
  });

  it('sends a default change and reports it', async () => {
    const second = document({ id: 'doc-2', name: 'Software Resume', isDefault: false });
    const { sent } = mockMessaging({
      documents: { data: { documents: [document(), second], defaultResumeId: 'doc-1' } },
      documentUpdate: { data: { ...second, isDefault: true } },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Documents');
    await waitFor(() => expect(screen.getByText('Software Resume')).toBeDefined());

    const row = screen.getByText('Software Resume').closest('tr');
    fireEvent.click(within(row!).getByRole('button', { name: 'Make default' }));

    await waitFor(() => expect(screen.getByText(/is now the default/)).toBeDefined());
    const update = sent.find((message) => message.type === 'DOCUMENT_UPDATE');
    expect(update).toBeDefined();
    if (update?.type === 'DOCUMENT_UPDATE') {
      expect(update.id).toBe('doc-2');
      expect(update.patch.isDefault).toBe(true);
    }
  });

  it('records an explicit resume choice in extension storage', async () => {
    const second = document({ id: 'doc-2', name: 'Software Resume', isDefault: false });
    const { chromeMock } = mockMessaging({
      documents: { data: { documents: [document(), second], defaultResumeId: 'doc-1' } },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Documents');
    await waitFor(() => expect(screen.getByText('Software Resume')).toBeDefined());

    const row = screen.getByText('Software Resume').closest('tr');
    fireEvent.click(within(row!).getByRole('button', { name: 'Use next' }));

    await waitFor(() =>
      expect(screen.getByText(/will be used for the next application/)).toBeDefined(),
    );
    expect(chromeMock.storage.local.set).toHaveBeenCalled();
  });

  it('shows the load failure with its remedy', async () => {
    mockMessaging({
      documents: {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or invalid x-agent-token header.',
          recoverable: true,
          suggestedAction: 'Paste the agent server token into extension settings.',
          debugContext: {},
        },
      },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Documents');
    await waitFor(() => expect(screen.getByText(/Missing or invalid/)).toBeDefined());
    expect(screen.getByText(/Paste the agent server token/)).toBeDefined();
  });
});

describe('options page approved answers', () => {
  it('lists answers with their permission flags', async () => {
    mockMessaging({ answers: { data: { answers: [answer()] } } });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Approved answers');
    await waitFor(() =>
      expect(
        screen.getByText('Are you legally authorized to work in the United States?'),
      ).toBeDefined(),
    );

    const row = screen
      .getByText('Are you legally authorized to work in the United States?')
      .closest('tr');
    expect(within(row!).getByText('Yes')).toBeDefined();
    expect(within(row!).getByText('approved')).toBeDefined();
    expect(within(row!).getByText('auto-fill')).toBeDefined();
  });

  it('creates a boolean answer through the form', async () => {
    const { sent } = mockMessaging({ answers: { data: { answers: [] } } });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Approved answers');
    await waitFor(() => expect(screen.getByLabelText(/Canonical question/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Canonical question/), {
      target: { value: 'Do you require sponsorship?' },
    });
    fireEvent.change(screen.getByLabelText('Answer type'), { target: { value: 'boolean' } });
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'no' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'eligibility' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add answer' }));

    await waitFor(() => expect(sent.some((m) => m.type === 'ANSWER_CREATE')).toBe(true));
    const create = sent.find((message) => message.type === 'ANSWER_CREATE');
    if (create?.type === 'ANSWER_CREATE') {
      expect(create.answer.canonicalQuestion).toBe('Do you require sponsorship?');
      expect(create.answer.answerType).toBe('boolean');
      expect(create.answer.answer).toBe(false);
      // Review stays on by default so nothing is silently auto-filled.
      expect(create.answer.requiresReview).toBe(true);
      expect(create.answer.autoFillAllowed).toBe(false);
    }
  });

  it('forces review on when an answer is marked sensitive', async () => {
    const { sent } = mockMessaging({ answers: { data: { answers: [] } } });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Approved answers');
    await waitFor(() => expect(screen.getByLabelText(/Canonical question/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Canonical question/), {
      target: { value: 'What is your gender?' },
    });
    // Turn review off first, then mark sensitive: review must come back on.
    fireEvent.click(screen.getByLabelText('Always show me before filling'));
    fireEvent.click(screen.getByLabelText('This is a sensitive question'));

    expect(screen.getByLabelText('Always show me before filling')).toHaveProperty('checked', true);
    expect(screen.getByText(/cannot be auto-filled without review/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Add answer' }));
    await waitFor(() => expect(sent.some((m) => m.type === 'ANSWER_CREATE')).toBe(true));

    const create = sent.find((message) => message.type === 'ANSWER_CREATE');
    if (create?.type === 'ANSWER_CREATE') {
      expect(create.answer.sensitive).toBe(true);
      expect(create.answer.requiresReview).toBe(true);
    }
  });

  it('reports a rejected answer with the reason the server gave', async () => {
    mockMessaging({
      answers: { data: { answers: [] } },
      answerCreate: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'An approved answer already exists for that question.',
          recoverable: true,
          suggestedAction: 'Edit the existing answer instead.',
          debugContext: {},
        },
      },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('Approved answers');
    await waitFor(() => expect(screen.getByLabelText(/Canonical question/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Canonical question/), { target: { value: 'Dup?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add answer' }));

    await waitFor(() => expect(screen.getByText(/already exists for that question/)).toBeDefined());
    expect(screen.getByText(/Edit the existing answer instead/)).toBeDefined();
  });
});

describe('options page structure', () => {
  it('offers every settings area the milestone requires', async () => {
    mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    for (const tab of [
      'Name and contact',
      'Education',
      'Work experience',
      'Projects',
      'Skills and activities',
      'Eligibility',
      'Preferences',
      'Sensitive answers',
      'Documents',
      'Approved answers',
      'AI answers',
      'Connection',
    ]) {
      expect(screen.getByRole('button', { name: tab })).toBeDefined();
    }
  });

  it('states local-only AI behavior and persists validated generation settings', async () => {
    const { chromeMock, sent } = mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    openTab('AI answers');
    expect(screen.getByText(/AI answer generation runs locally/)).toBeDefined();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'fixture-model:latest' })).toBeDefined(),
    );
    const enableAi = screen.getByLabelText(/Enable grounded AI answer generation/);
    expect(enableAi).toHaveProperty('checked', false);
    fireEvent.click(enableAi);
    expect(enableAi).toHaveProperty('checked', true);
    fireEvent.change(screen.getByLabelText(/Generation model/), {
      target: { value: 'fixture-model:latest' },
    });
    fireEvent.change(screen.getByLabelText(/Concurrent generations/), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save AI settings' }));

    await waitFor(() => expect(screen.getByText('AI generation settings saved.')).toBeDefined());
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        selectedModel: 'fixture-model:latest',
        aiGenerationEnabled: true,
        ai: expect.objectContaining({
          generationModel: 'fixture-model:latest',
          maximumConcurrentGenerations: 2,
        }),
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test AI generation' }));
    await waitFor(() =>
      expect(
        screen.getByText(/fixture-model:latest returned valid structured output in 12 ms/),
      ).toBeDefined(),
    );
    expect(sent.some((message) => message.type === 'TEST_AI_GENERATION')).toBe(true);

    cleanup();
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());
    openTab('AI answers');
    await waitFor(() =>
      expect(screen.getByLabelText(/Enable grounded AI answer generation/)).toHaveProperty(
        'checked',
        true,
      ),
    );
  });

  it('hides the profile save bar on non-profile tabs', async () => {
    mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDefined();

    openTab('Documents');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save profile' })).toBeNull());
  });
});

// Guard against an accidental regression: the options page must never contain
// autofill controls before Milestone 3.
describe('milestone scope', () => {
  it('has no fill or analyze controls', async () => {
    mockMessaging({});
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    expect(screen.queryByRole('button', { name: /Fill/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Analyze/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Submit/i })).toBeNull();
  });
});
