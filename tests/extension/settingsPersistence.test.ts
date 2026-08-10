import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTOFILL_SETTINGS } from '@internship-agent/shared';
import { installChromeMock } from './setup.js';
import { loadSettings, saveSettings } from '../../extension/src/storage/settings.js';

/**
 * Settings that survive a round trip.
 *
 * `normalizeStoredSettings` rebuilds the settings object key by key on every
 * read, and two keys were never named in that rebuild: `autofill` and
 * `developerMode`. Both default in the schema, so the omission did not fail — it
 * silently reset. Every autofill switch a user changed went back to its default
 * on the next read, and developer mode could be written and never observed,
 * which is why the Diagnostics page permanently told the user to turn on a
 * setting that could not be turned on.
 *
 * These tests are the shape of that bug: save, load, and assert the value came
 * back.
 */

describe('settings persistence', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it('keeps developerMode on across a reload', async () => {
    await saveSettings({ developerMode: true });
    expect((await loadSettings()).developerMode).toBe(true);
  });

  it('keeps developerMode off when it was never set', async () => {
    expect((await loadSettings()).developerMode).toBe(false);
  });

  it('keeps a changed autofill preference across a reload', async () => {
    await saveSettings({ autofill: { autoAttachApprovedDocuments: false } });
    const loaded = await loadSettings();
    expect(loaded.autofill.autoAttachApprovedDocuments).toBe(false);
  });

  it('leaves the other autofill switches alone when one is changed', async () => {
    await saveSettings({ autofill: { autoAttachApprovedDocuments: false } });
    const loaded = await loadSettings();
    expect(loaded.autofill).toEqual({
      ...DEFAULT_AUTOFILL_SETTINGS,
      autoAttachApprovedDocuments: false,
    });
  });

  it('round-trips a fully custom autofill block unchanged', async () => {
    const custom = {
      applicationAutofillEnabled: true,
      autoFillExactProfileValues: true,
      autoFillSemanticProfileMatches: false,
      autoFillApprovedAnswers: false,
      autoFillValidatedAiAnswers: false,
      allowGroundedNonSensitiveGuesses: false,
      autoFillSensitiveDisclosurePresets: false,
      autoAttachApprovedDocuments: false,
      scrollToFirstReviewField: false,
      neverSubmit: true as const,
    };
    await saveSettings({ autofill: custom });
    expect((await loadSettings()).autofill).toEqual(custom);
  });

  it('survives an installation stored before either key existed', async () => {
    // The exact shape an older build wrote: no `autofill`, no `developerMode`,
    // and the legacy nested enablement key. It must upgrade, not be rejected.
    await chrome.storage.local.set({
      settings: {
        serverUrl: 'http://127.0.0.1:4318',
        authToken: '',
        selectedModel: 'llama3.1:8b',
        selectedDocumentId: null,
        ai: { generationModel: 'llama3.1:8b', enabled: true },
        settingsVersion: 1,
        settingsUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const loaded = await loadSettings();
    expect(loaded.autofill).toEqual(DEFAULT_AUTOFILL_SETTINGS);
    expect(loaded.developerMode).toBe(false);
    expect(loaded.aiGenerationEnabled).toBe(true);
  });

  it('falls back to the safe defaults when the stored blocks are corrupt', async () => {
    await chrome.storage.local.set({
      settings: {
        serverUrl: 'http://127.0.0.1:4318',
        authToken: '',
        selectedModel: 'llama3.1:8b',
        selectedDocumentId: null,
        ai: { generationModel: 'llama3.1:8b' },
        autofill: 'not an object',
        developerMode: 'yes',
        settingsVersion: 1,
        settingsUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const loaded = await loadSettings();
    expect(loaded.autofill).toEqual(DEFAULT_AUTOFILL_SETTINGS);
    // A corrupt value never grants the mode; the failure direction is "off".
    expect(loaded.developerMode).toBe(false);
  });

  it('never lets a stored value defeat the no-submit rule', async () => {
    await chrome.storage.local.set({
      settings: {
        serverUrl: 'http://127.0.0.1:4318',
        authToken: '',
        selectedModel: 'llama3.1:8b',
        selectedDocumentId: null,
        ai: { generationModel: 'llama3.1:8b' },
        autofill: { ...DEFAULT_AUTOFILL_SETTINGS, neverSubmit: false },
        settingsVersion: 1,
        settingsUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect((await loadSettings()).autofill.neverSubmit).toBe(true);
  });
});
