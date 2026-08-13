import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentDecisionSchema, type AgentToolCall } from '@internship-agent/shared';
import { runAgentLoop } from '../../extension/src/agent/agentLoop.js';
import { checkDecision } from '../../extension/src/agent/agentSafety.js';
import { executeAgentTool } from '../../extension/src/agent/agentToolExecutor.js';
import { observePage } from '../../extension/src/agent/pageObserver.js';
import { scanDom } from '../../extension/src/scanner/domScanner.js';

const FIXTURE = resolve(
  process.cwd(),
  'tests',
  'fixtures',
  'lab',
  'successfactors-composite-controls.html',
);

Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    width: 220,
    height: 32,
    top: 0,
    left: 0,
    right: 220,
    bottom: 32,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }),
});

function loadFixture(): void {
  document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8').replace(
    /<!doctype html>/i,
    '',
  );
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }
}

const ANSWERS: ReadonlyArray<[RegExp, string]> = [
  [/^Address/i, '100 Main Street'],
  [/^City/i, 'Newark'],
  [/^Postal Code/i, '07102'],
  [/^Phone/i, '2015550134'],
  [/^Company Name/i, 'Example Company'],
  [/^Position Title/i, 'Engineer'],
  [/^State\/Province/i, 'New Jersey'],
  [/^Education Type/i, 'BS'],
  [/^Education Country/i, 'United States'],
  [/^Area of Study/i, 'Electrical Engineering'],
  [/^Graduated/i, 'No'],
];

async function observeWithAnswers() {
  const observation = await observePage({ classificationDiagnostics: true });
  return {
    ...observation,
    elements: observation.elements.map((element) => {
      const answer = ANSWERS.find(([pattern]) => pattern.test(element.label))?.[1];
      return answer
        ? { ...element, policy: 'KNOWN_FACT' as const, proposedValue: answer }
        : element;
    }),
  };
}

beforeEach(loadFixture);

describe('SuccessFactors composite input/dropdown ownership', () => {
  it('normalizes the outer trigger as the authoritative field', async () => {
    const { fields } = await scanDom(document, 'sf-composite', new AbortController().signal);
    for (const label of [
      'State/Province',
      'Education Type',
      'Education Country',
      'Area of Study',
      'Graduated?',
    ]) {
      const field = fields.find((candidate) => candidate.label.includes(label));
      expect(field, `${label} was not scanned`).toBeDefined();
      expect(field!.fieldType).toBe('combobox');
      expect(field!.selector).toContain('trigger');
      expect(field!.metadata.tagName).toBe('button');
    }

    const ordinary = ['Address', 'City', 'Postal Code', 'Phone', 'Company Name', 'Position Title'];
    for (const label of ordinary) {
      const field = fields.find((candidate) => candidate.label === label)!;
      expect(field.fieldType).not.toBe('combobox');
    }
  });

  it('reports choice types, preserves ordinary text, and gives dates precedence', async () => {
    const observation = await observeWithAnswers();
    for (const label of [
      'State/Province',
      'Education Type',
      'Education Country',
      'Area of Study',
      'Graduated?',
    ]) {
      const field = observation.elements.find((candidate) => candidate.label.includes(label));
      expect(field?.interactionType).toBe('CUSTOM_SELECT');
      expect(field?.interactionType).not.toBe('TEXT_INPUT');
    }
    for (const label of [
      'Address',
      'City',
      'Postal Code',
      'Phone',
      'Company Name',
      'Position Title',
    ]) {
      expect(
        observation.elements.find((candidate) => candidate.label === label)?.interactionType,
      ).toBe('TEXT_INPUT');
    }
    expect(
      observation.elements.find((candidate) => candidate.label === 'From Date')?.interactionType,
    ).toBe('DATE_INPUT');
    expect(
      observation.elements.find((candidate) => candidate.label === 'Native Country')
        ?.interactionType,
    ).toBe('NATIVE_SELECT');
  });

  it('records the value-free final-authority signature only for live diagnostic targets', async () => {
    const observation = await observeWithAnswers();
    for (const label of ['State/Province', 'Education Type', 'Area of Study']) {
      const trace = observation.elements.find((element) => element.label.includes(label))
        ?.controlClassificationTrace;
      expect(trace).toMatchObject({
        event: 'CONTROL_CLASSIFICATION_TRACE',
        adapterType: 'successfactors',
        finalAgentControlType: 'CUSTOM_SELECT',
      });
      expect(trace?.scannerTypeBeforeNormalization).toBe('combobox');
    }
    expect(
      observation.elements.find((element) => element.label === 'Address')
        ?.controlClassificationTrace,
    ).toBeUndefined();
    expect(JSON.stringify(observation.elements.map((element) => element.controlClassificationTrace)))
      .not.toContain('100 Main Street');
  });

  it('forbids type on each choice parent and permits open_dropdown', async () => {
    const observation = await observeWithAnswers();
    const trusted = new Map(
      observation.elements.flatMap((element) =>
        element.proposedValue ? [[element.elementId, element.proposedValue] as const] : [],
      ),
    );
    for (const label of ['State/Province', 'Education Type', 'Area of Study']) {
      const target = observation.elements.find((candidate) => candidate.label.includes(label))!;
      const typed = checkDecision(
        agentDecisionSchema.parse({
          kind: 'ACTION',
          action: { tool: 'type', elementId: target.elementId, value: target.proposedValue },
        }),
        observation,
        trusted,
      );
      expect(typed.allowed).toBe(false);
      expect(typed.code).toBe('WRONG_TOOL_FOR_CONTROL_TYPE');
      expect(
        checkDecision(
          agentDecisionSchema.parse({
            kind: 'ACTION',
            action: { tool: 'open_dropdown', elementId: target.elementId },
          }),
          observation,
          trusted,
        ).allowed,
      ).toBe(true);
    }
  });

  it('runs the production Agent loop through open, observed options, select, and verify', async () => {
    const executions: AgentToolCall[] = [];
    const outcome = await runAgentLoop({
      runId: '11111111-1111-4111-8111-111111111111',
      buildId: 'fixture',
      observe: observeWithAnswers,
      execute: async (call) => {
        executions.push(call);
        return executeAgentTool(call);
      },
      trustedValues: (observation) =>
        Promise.resolve(
          new Map(
            observation.elements.flatMap((element) =>
              element.proposedValue ? [[element.elementId, element.proposedValue] as const] : [],
            ),
          ),
        ),
    });

    for (const label of ['State/Province', 'Education Type', 'Area of Study']) {
      const steps = outcome.trace.steps.filter((step) => step.targetLabel.includes(label));
      expect(steps.map((step) => step.tool)).toContain('open_dropdown');
      expect(steps.map((step) => step.tool)).toContain('select_option');
      expect(steps.map((step) => step.tool)).not.toContain('type');
      expect(steps.find((step) => step.tool === 'open_dropdown')?.optionsSeen).toBeGreaterThan(0);
      expect(steps.find((step) => step.tool === 'select_option')?.verification).toBe('VERIFIED');
    }
    for (const label of [
      'Address',
      'City',
      'Postal Code',
      'Phone',
      'Company Name',
      'Position Title',
    ]) {
      const typed = outcome.trace.steps.find(
        (step) => step.targetLabel === label && step.tool === 'type',
      );
      expect(typed, `${label} did not stay on the text path`).toBeDefined();
      expect(typed?.action?.targetControlType).toBe('TEXT_INPUT');
      expect(typed?.action?.freshObservation).toBe(true);
      expect(typed?.verification).toBe('VERIFIED');
    }
    expect(
      executions.some((call) => call.tool === 'type' && call.elementId?.includes('::search')),
    ).toBe(false);
  });
});
