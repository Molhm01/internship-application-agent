import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applicationScanResultSchema,
  describeSchemaFailure,
  looksLikeVersionSkew,
  schemaFailureContext,
} from '@internship-agent/shared';

/**
 * What a person sees when a schema rejects something.
 *
 * The popup used to print `ZodError.message`, which is a JSON dump of the issue
 * array. On a login page that meant several hundred characters of
 * `{"code":"invalid_enum_value","options":["text","textarea",…]}` in front of
 * somebody who wanted to apply for a job — and the `options` list it showed was
 * the *validator's* list, so it read as "this field type is unsupported" when
 * the truth was "two halves of this extension were built at different times".
 */

/** A real rejection, produced by the real schema rather than hand-made. */
function realFailure(): z.ZodError {
  const parsed = applicationScanResultSchema.safeParse({
    id: 'scan-1',
    createdAt: '2026-08-02T09:00:00.000Z',
    url: 'https://careers.example.com/login',
    domain: 'careers.example.com',
    ats: {
      id: 'generic',
      displayName: 'Generic',
      confidence: 0.5,
      detectionReason: 'test',
      supported: true,
    },
    jobContext: {},
    fields: [
      {
        id: 'pass',
        pageId: 'page-1',
        label: 'Password',
        normalizedLabel: 'password',
        question: 'Password',
        // A member no build has ever had: the shape of a version-skew failure.
        fieldType: 'quantum_flux',
        selector: '#password',
        required: true,
        visible: true,
        disabled: false,
        confidence: 1,
        sourceSignals: ['label'],
        warnings: [],
        metadata: {},
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
    durationMs: 3,
    status: 'completed',
    readOnly: true,
  });
  if (parsed.success) throw new Error('expected the schema to reject this fixture');
  return parsed.error;
}

describe('what the popup shows when a scan fails validation', () => {
  it('is a sentence, not a JSON dump', () => {
    const message = describeSchemaFailure(realFailure(), 'The scan of this page');
    expect(message).not.toContain('{');
    expect(message).not.toContain('"code"');
    expect(message).not.toContain('[');
    expect(message.length).toBeLessThan(400);
  });

  it('never shows the validator’s own option list, which reads as a false verdict', () => {
    const message = describeSchemaFailure(realFailure());
    // Printing the accepted enum tells the user their page is unsupported. It
    // is not; the build is stale.
    expect(message).not.toContain('contenteditable');
    expect(message).not.toContain('multi_select');
    expect(message).not.toMatch(/textarea.*tel/);
  });

  it('names where the problem is', () => {
    expect(describeSchemaFailure(realFailure())).toContain('fields.0.fieldType');
  });

  it('tells the user to rebuild, because that is what this failure means', () => {
    const message = describeSchemaFailure(realFailure());
    expect(message).toMatch(/out of date|rebuild/i);
    expect(message).toContain('chrome://extensions');
  });

  it('recognizes an unknown enum member as version skew', () => {
    expect(looksLikeVersionSkew(realFailure())).toBe(true);
  });

  it('does not blame the build for a plain shape error', () => {
    const parsed = z.object({ count: z.number() }).safeParse({ count: 'lots' });
    if (parsed.success) throw new Error('expected a failure');
    expect(looksLikeVersionSkew(parsed.error)).toBe(false);
    expect(describeSchemaFailure(parsed.error)).not.toMatch(/rebuild/i);
  });

  it('passes a non-Zod error through unchanged', () => {
    expect(describeSchemaFailure(new Error('Receiving end does not exist'))).toBe(
      'Receiving end does not exist',
    );
  });

  it('caps the number of fields it lists rather than growing without bound', () => {
    const schema = z.object({
      a: z.number(),
      b: z.number(),
      c: z.number(),
      d: z.number(),
      e: z.number(),
    });
    const parsed = schema.safeParse({});
    if (parsed.success) throw new Error('expected a failure');
    expect(describeSchemaFailure(parsed.error)).toContain('and 2 more');
  });
});

describe('the structured context that goes to diagnostics', () => {
  it('carries the issue codes and paths for the diagnostics page', () => {
    const context = schemaFailureContext(realFailure());
    expect(context.issueCount).toBeGreaterThan(0);
    expect(context.versionSkew).toBe(true);
    expect(Array.isArray(context.issues)).toBe(true);
  });

  it('never carries the rejected value itself', () => {
    // A scan carries whatever the user typed into the page, so a rejected value
    // could be the contents of a password box. It must not reach a log.
    const serialized = JSON.stringify(schemaFailureContext(realFailure()));
    expect(serialized).not.toContain('quantum_flux');
    expect(serialized).not.toContain('received');
  });

  it('is empty for a non-Zod error rather than inventing structure', () => {
    expect(schemaFailureContext(new Error('boom'))).toEqual({});
  });
});
