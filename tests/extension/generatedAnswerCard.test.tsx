import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { answerGenerationRecordSchema } from '@internship-agent/shared';
import { GeneratedAnswerCard } from '../../extension/src/fill-plan/GeneratedAnswerCard.js';
import { installChromeMock } from './setup.js';

afterEach(cleanup);

describe('failed generated answer card', () => {
  it('shows the actionable failure and never represents it as generated or approvable', () => {
    installChromeMock();
    const now = new Date().toISOString();
    const record = answerGenerationRecordSchema.parse({
      id: 'generation-failed',
      scanId: 'scan-1',
      planId: 'plan-1',
      fieldId: 'field-1',
      question: 'Tell me two engineering achievements.',
      classification: 'achievement',
      constraints: { requestedExamples: { minimum: 2, maximum: 3 } },
      state: 'failed',
      contextEvidence: [],
      userEvidence: [],
      source: 'ai_generated',
      approved: false,
      rejected: false,
      leaveBlank: false,
      createdAt: now,
      updatedAt: now,
      warnings: [],
      error: {
        code: 'MODEL_NOT_FOUND',
        message: 'Configured model "missing-model" is not installed.',
        recoverable: true,
        suggestedAction: 'Select an installed model in Settings or pull the model.',
        debugContext: {
          configuredModel: 'missing-model',
          availableModels: ['installed-model:latest'],
        },
      },
    });

    render(
      <GeneratedAnswerCard
        record={record}
        busy={false}
        onChanged={() => Promise.resolve()}
        onError={() => undefined}
      />,
    );

    expect(screen.getByText('Generation failed')).toBeDefined();
    expect(screen.getByText(/MODEL_NOT_FOUND/)).toBeDefined();
    expect(screen.getByText('Not generated')).toBeDefined();
    expect(screen.getByText('No')).toBeDefined();
    expect(screen.getByLabelText('Generated answer / manual edit')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Retry Generation' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save manual edit' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
