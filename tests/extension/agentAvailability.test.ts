import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applicationScanResultSchema,
  detectedFieldSchema,
  plannedAnswerSchema,
  type AgentError,
  type ApplicationScanResult,
  type DetectedField,
  type HealthResponse,
} from '@internship-agent/shared';
import {
  agentAvailability,
  availabilityMessage,
  canAnalyze,
  clearAgentAvailabilityCache,
  interpretHealth,
  HEALTH_CACHE_MS,
} from '../../extension/src/background/agentAvailability.js';
import { buildAnalysisRequest } from '../../extension/src/analysis/formAnalysis.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { applyPassword } from '../../extension/src/executor/domExecutor.js';
import { profileFixture } from './popupFixtures.js';

function health(overrides: Partial<HealthResponse['ollama']> = {}): HealthResponse {
  return {
    status: 'ok',
    service: 'internship-application-agent',
    version: '1.0.0',
    uptimeSeconds: 1,
    checkedAt: '2026-08-02T09:00:00.000Z',
    ollama: {
      state: 'connected',
      baseUrl: 'http://127.0.0.1:11434',
      modelCount: 1,
      selectedModel: 'local-model',
      selectedModelInstalled: true,
      checkedAt: '2026-08-02T09:00:00.000Z',
      latencyMs: 1,
      ...overrides,
    },
    database: { state: 'ready', path: ':memory:', schemaVersion: 1 },
    profileLoaded: true,
    authenticated: true,
  };
}

const UNREACHABLE: AgentError = {
  code: 'AGENT_SERVER_UNAVAILABLE',
  message: 'Could not reach the agent server at http://127.0.0.1:4317.',
  recoverable: true,
  suggestedAction: 'Start the local agent server.',
  debugContext: {},
};

beforeEach(() => clearAgentAvailabilityCache());

describe('reading the agent status honestly', () => {
  it('reports a reachable server with a working model as connected', () => {
    const availability = interpretHealth({ health: health() });
    expect(availability.state).toBe('connected');
    expect(canAnalyze(availability)).toBe(true);
    expect(availabilityMessage(availability)).toBe('AI agent connected.');
  });

  it('does not claim connected when the model cannot answer', () => {
    const disconnected = interpretHealth({ health: health({ state: 'disconnected' }) });
    expect(disconnected.state).toBe('model_unavailable');
    expect(canAnalyze(disconnected)).toBe(false);

    const missingModel = interpretHealth({ health: health({ selectedModelInstalled: false }) });
    expect(missingModel.state).toBe('model_unavailable');
    expect(canAnalyze(missingModel)).toBe(false);
  });

  it('separates an unreachable server from a rejected token', () => {
    expect(interpretHealth({ error: UNREACHABLE }).state).toBe('unreachable');
    expect(interpretHealth({ error: { ...UNREACHABLE, code: 'SERVER_AUTH_FAILED' } }).state).toBe(
      'unauthorized',
    );
  });

  it('says what still works rather than surfacing a bare error code', () => {
    const message = availabilityMessage(interpretHealth({ error: UNREACHABLE }));
    expect(message).toContain('AI agent unavailable');
    expect(message).toContain('Deterministic autofill still works');
    expect(message).not.toContain('AGENT_SERVER_UNAVAILABLE');
    expect(message).not.toContain('{');
  });
});

describe('health is checked once, not once per field', () => {
  it('probes once and serves the cache within the window', async () => {
    const probe = vi.fn().mockResolvedValue({ health: health() });
    let now = 1_000_000;
    for (let index = 0; index < 25; index += 1) {
      await agentAvailability(probe, () => now);
    }
    expect(probe).toHaveBeenCalledTimes(1);

    // Still cached just before the window closes, re-probed after it.
    now += HEALTH_CACHE_MS - 1;
    await agentAvailability(probe, () => now);
    expect(probe).toHaveBeenCalledTimes(1);

    now += 2;
    await agentAvailability(probe, () => now);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    let release: (value: { health: HealthResponse }) => void = () => undefined;
    const probe = vi.fn(
      () =>
        new Promise<{ health: HealthResponse }>((resolve) => {
          release = resolve;
        }),
    );
    const pending = [agentAvailability(probe), agentAvailability(probe), agentAvailability(probe)];
    release({ health: health() });
    const results = await Promise.all(pending);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.state === 'connected')).toBe(true);
  });
});

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  const label = overrides.label ?? 'Question';
  return detectedFieldSchema.parse({
    id: overrides.id ?? 'field-1',
    pageId: 'page-1',
    label,
    normalizedLabel: label.toLowerCase(),
    question: label,
    fieldType: 'text',
    selector: `#${overrides.id ?? 'field-1'}`,
    required: false,
    visible: true,
    disabled: false,
    confidence: 0.9,
    sourceSignals: ['label_for'],
    warnings: [],
    metadata: {},
    ...overrides,
  });
}

function scanOf(fields: DetectedField[]): ApplicationScanResult {
  return applicationScanResultSchema.parse({
    id: 'scan-1',
    createdAt: '2026-08-02T09:00:00.000Z',
    url: 'https://careers.example.com/login',
    domain: 'careers.example.com',
    ats: {
      id: 'taleo',
      displayName: 'Oracle Taleo',
      confidence: 0.9,
      detectionReason: 'test',
      supported: true,
    },
    jobContext: {},
    fields,
    warnings: [],
    statistics: {
      total: fields.length,
      supported: fields.length,
      unknown: 0,
      required: 0,
      optional: fields.length,
      text: fields.length,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      credentialFields: 0,
      navigationActions: 0,
    },
    durationMs: 3,
    status: 'completed',
    readOnly: true,
  });
}

describe('credentials never reach the model', () => {
  it('leaves the username and password out of the analysis request entirely', () => {
    const fields = [
      field({ id: 'user', label: 'User Name', metadata: { name: 'userName' } }),
      field({ id: 'pass', label: 'Password', fieldType: 'password' }),
      field({ id: 'why', label: 'Why do you want to work here?', fieldType: 'textarea' }),
    ];
    const scan = scanOf(fields);
    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    const built = buildAnalysisRequest({ scan, plan, profile: profileFixture(), answers: [] });

    const questionText = built.questions.map((question) => question.questionText);
    expect(questionText).toContain('Why do you want to work here?');
    expect(questionText).not.toContain('User Name');
    expect(questionText).not.toContain('Password');
    expect(JSON.stringify(built.request)).not.toMatch(/password/i);
  });

  it('makes no request at all on a page that only asks for credentials', () => {
    const fields = [
      field({ id: 'user', label: 'User Name', metadata: { name: 'userName' } }),
      field({ id: 'pass', label: 'Password', fieldType: 'password' }),
    ];
    const scan = scanOf(fields);
    const plan = buildDeterministicPlan(scan, profileFixture(), []);
    expect(
      buildAnalysisRequest({ scan, plan, profile: profileFixture(), answers: [] }).request,
    ).toBeNull();
  });

  it('rejects a plan in which the model tried to supply a password', () => {
    expect(() =>
      plannedAnswerSchema.parse({
        questionId: 'question-a',
        action: 'SET_PASSWORD',
        value: 'hunter2',
        confidence: 1,
      }),
    ).toThrow();

    // Naming the field is allowed; supplying the secret is not.
    expect(
      plannedAnswerSchema.parse({ questionId: 'question-a', action: 'SET_PASSWORD', confidence: 1 })
        .value,
    ).toBeUndefined();
  });
});

describe('typing a password', () => {
  it('fills the field and verifies by length rather than by value', () => {
    document.body.innerHTML = '<input id="pw" type="password">';
    const element = document.getElementById('pw') as HTMLInputElement;
    expect(applyPassword(element, 'Tr0ub4dor&3')).toBe(true);
    expect(element.value).toBe('Tr0ub4dor&3');
  });

  it('refuses any control that is not a password field', () => {
    document.body.innerHTML = '<input id="text" type="text">';
    expect(() => applyPassword(document.getElementById('text') as HTMLElement, 'x')).toThrow(
      /UNSUPPORTED_CONTROL/,
    );
  });
});
