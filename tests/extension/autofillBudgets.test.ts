import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { isPasswordField, isUsernameField, type DetectedField } from '@internship-agent/shared';
import { scanDom } from '../../extension/src/scanner/domScanner.js';
import { buildDeterministicPlan } from '../../extension/src/planner/deterministicPlanner.js';
import { buildAnalysisRequest } from '../../extension/src/analysis/formAnalysis.js';
import { profileFixture } from './popupFixtures.js';
import { icimsScan } from './icimsScanFixture.js';

/**
 * The stage budgets, and what is allowed to reach the model.
 *
 * These exist because "it waits far too long" had a specific cause: the batched
 * model call sat inside the per-pass plan step, so a five-pass run paid for it
 * five times. The budgets below pin the stages that must stay fast, and the
 * request assertions pin the one stage that is allowed to be slow to only the
 * questions that genuinely need it.
 */

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lab',
  'icims-account-creation.html',
);

/** Generous multiples of the observed cost — a budget, not a benchmark. */
const SCAN_BUDGET_MS = 2000;
const RESOLVE_BUDGET_MS = 1000;

function loadFixture(): void {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
}

async function scanFields(): Promise<DetectedField[]> {
  return (await scanDom(document, 'page-icims', new AbortController().signal)).fields;
}

beforeEach(() => {
  loadFixture();
});

describe('stage budgets', () => {
  it('scans the page well inside two seconds', async () => {
    const started = performance.now();
    await scanFields();
    expect(performance.now() - started).toBeLessThan(SCAN_BUDGET_MS);
  });

  it('resolves the deterministic plan well inside one second', async () => {
    const fields = await scanFields();
    const started = performance.now();
    buildDeterministicPlan(icimsScan(fields), profileFixture(), []);
    expect(performance.now() - started).toBeLessThan(RESOLVE_BUDGET_MS);
  });
});

describe('what reaches the model', () => {
  async function request() {
    const fields = await scanFields();
    const scan = icimsScan(fields);
    const profile = profileFixture();
    const plan = buildDeterministicPlan(scan, profile, []);
    return { ...buildAnalysisRequest({ scan, plan, profile, answers: [] }), fields, plan };
  }

  it('never sends a field the profile already answered', async () => {
    const built = await request();
    const sent = built.questions.map((question) => question.likelyIntent);
    for (const deterministic of [
      'first_name',
      'last_name',
      'email',
      'phone',
      'address_line1',
      'city',
      'postal_code',
      'country',
    ]) {
      expect(sent, `${deterministic} was sent to the model`).not.toContain(deterministic);
    }
  });

  it('never sends a credential', async () => {
    const built = await request();
    // The fields actually attached to the questions being sent — not the
    // fields on the page, which of course include both password boxes.
    const sentFields = [...built.fieldsByQuestionId.values()].flat();
    const credentials = sentFields.filter(
      (field) => isPasswordField(field) || isUsernameField(field),
    );
    expect(credentials.map((field) => field.label)).toEqual([]);
    expect(JSON.stringify(built.request ?? {})).not.toMatch(/password/i);
  });

  it('never sends an optional field the planner deliberately left blank', async () => {
    const built = await request();
    const sent = built.questions.map((question) => question.likelyIntent);
    expect(sent).not.toContain('middle_name');
    expect(sent).not.toContain('address_line2');
  });

  it('never sends a section heading or an extension control', async () => {
    const built = await request();
    const text = built.questions.map((question) => question.questionText).join(' ');
    expect(text).not.toMatch(/addresses \(1\)/i);
    expect(text).not.toMatch(/phones \(1\)/i);
    expect(text).not.toMatch(/enable ai autofill/i);
  });

  it('sends no question twice', async () => {
    const built = await request();
    const ids = built.questions.map((question) => question.questionId);
    expect(new Set(ids).size).toBe(ids.length);
    const texts = built.questions.map((question) => question.questionText);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('sends few enough questions that one batch is reasonable', async () => {
    const built = await request();
    // The whole point of the deterministic pass: the model sees the handful
    // nobody could answer from saved data, not all 24 questions.
    expect(built.questions.length).toBeLessThanOrEqual(8);
  });

  it('carries a timeout so a stalled model cannot hold the run open', async () => {
    const built = await request();
    if (!built.request) return;
    expect(built.request.timeoutMs).toBeGreaterThan(0);
    expect(built.request.timeoutMs).toBeLessThanOrEqual(60_000);
  });
});
