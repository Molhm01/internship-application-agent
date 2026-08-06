import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App as OptionsApp } from '../../extension/src/options/App.js';
import { App as PopupApp } from '../../extension/src/popup/App.js';
import { sendMessage } from '../../extension/src/messaging/messages.js';
import { installChromeMock } from './setup.js';

afterEach(cleanup);

/**
 * Regression suite for the "Loading profile… forever" bug.
 *
 * Chrome resolves `chrome.runtime.sendMessage` with `undefined` when no listener
 * handles a message type, which happens whenever the background worker in the
 * browser is older than the page asking it. The loader dereferenced that
 * `undefined`, the resulting TypeError was swallowed by a floating promise, and
 * the loading flag was never cleared.
 *
 * Each test below drives one way the round trip can fail and asserts the UI
 * always leaves its loading state with something actionable on screen.
 */

const NEVER_SETTLES = new Promise<never>(() => {
  /* deliberately never resolves */
});

describe('sendMessage never hands a caller something it can crash on', () => {
  it('turns an unanswered message into an actionable error', async () => {
    const chromeMock = installChromeMock();
    // Exactly what Chrome does when no listener handles the type.
    chromeMock.runtime.sendMessage.mockResolvedValue(undefined);

    const result = await sendMessage({ type: 'PROFILE_GET' });

    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe('EXTENSION_RELOAD_REQUIRED');
    expect(result.error?.message).toContain('PROFILE_GET');
    expect(result.error?.suggestedAction).toContain('chrome://extensions');
  });

  it('turns a rejected message into an actionable error rather than throwing', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    const result = await sendMessage({ type: 'PROFILE_GET' });

    expect(result.error?.code).toBe('EXTENSION_RELOAD_REQUIRED');
    expect(result.error?.message).toContain('Receiving end does not exist');
  });

  it.each([null, 'a string', 42])('rejects the non-object reply %p', async (reply) => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockResolvedValue(reply);

    const result = await sendMessage({ type: 'DOCUMENTS_LIST' });
    expect(result.error?.code).toBe('EXTENSION_RELOAD_REQUIRED');
  });

  it('gives up on a message that never settles instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const chromeMock = installChromeMock();
      chromeMock.runtime.sendMessage.mockReturnValue(NEVER_SETTLES);

      const pending = sendMessage({ type: 'PROFILE_GET' });
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;

      expect(result.error?.code).toBe('EXTENSION_RELOAD_REQUIRED');
      expect(result.error?.message).toContain('no response within');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('options page never stays on "Loading profile…"', () => {
  it('shows an actionable error and a retry control when the worker does not answer', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockResolvedValue(undefined);

    render(<OptionsApp />);

    await waitFor(() => expect(screen.getByText(/Could not load your profile/)).toBeDefined());
    expect(screen.queryByText('Loading profile…')).toBeNull();
    expect(screen.getByText(/did not answer "PROFILE_GET"/)).toBeDefined();
    expect(screen.getByText(/chrome:\/\/extensions/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  it('clears loading when the message rejects', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockRejectedValue(new Error('port closed'));

    render(<OptionsApp />);

    await waitFor(() => expect(screen.getByText(/Could not load your profile/)).toBeDefined());
    expect(screen.queryByText('Loading profile…')).toBeNull();
  });

  it('clears loading when the reply carries neither data nor an error', async () => {
    const chromeMock = installChromeMock();
    // A well-formed object that is nonetheless meaningless.
    chromeMock.runtime.sendMessage.mockResolvedValue({ somethingElse: true });

    render(<OptionsApp />);

    await waitFor(() => expect(screen.getByText(/Could not load your profile/)).toBeDefined());
    expect(screen.queryByText('Loading profile…')).toBeNull();
  });

  it('recovers on retry once the worker starts answering', async () => {
    const chromeMock = installChromeMock();
    // Keyed on the message type rather than on call order. The settings page
    // asks for a profile sync before it reads the profile, and a test that
    // counts calls would be measuring that ordering instead of the retry.
    let profileReads = 0;
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type !== 'PROFILE_GET') return Promise.resolve(undefined);
      profileReads += 1;
      // The first read is the unanswered one this page used to hang on.
      if (profileReads === 1) return Promise.resolve(undefined);
      return Promise.resolve({
        error: {
          code: 'PROFILE_MISSING',
          message: 'No profile has been created yet.',
          recoverable: true,
          suggestedAction: 'Open the extension settings.',
          debugContext: {},
        },
      });
    });

    render(<OptionsApp />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined());

    screen.getByRole('button', { name: 'Try again' }).click();

    await waitFor(() =>
      expect(screen.getByText(/No profile found\. Create your profile\./)).toBeDefined(),
    );
    expect(screen.queryByText(/Could not load your profile/)).toBeNull();
  });

  it('offers an empty editable profile when none is stored', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockResolvedValue({
      error: {
        code: 'PROFILE_MISSING',
        message: 'No profile has been created yet.',
        recoverable: true,
        suggestedAction: 'Open the extension settings.',
        debugContext: {},
      },
    });

    render(<OptionsApp />);

    await waitFor(() =>
      expect(screen.getByText(/No profile found\. Create your profile\./)).toBeDefined(),
    );
    expect(screen.queryByText('Loading profile…')).toBeNull();
    // The form is present and blank — an empty default, not fabricated content.
    expect(screen.getByLabelText(/Legal first name/)).toHaveProperty('value', '');
    expect(screen.getByLabelText(/^Email/)).toHaveProperty('value', '');
  });
});

describe('save never leaves the button stuck on "Saving…"', () => {
  it('reports an unanswered save and re-enables the control', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) =>
      message.type === 'PROFILE_GET'
        ? Promise.resolve({
            error: {
              code: 'PROFILE_MISSING',
              message: 'No profile has been created yet.',
              recoverable: true,
              suggestedAction: 'Open settings.',
              debugContext: {},
            },
          })
        : Promise.resolve(undefined),
    );

    render(<OptionsApp />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    const input = screen.getByLabelText(/Legal first name/);
    // Type a value so the draft is dirty and the save button becomes enabled.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input, { target: { value: 'Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(screen.getByText(/PROFILE_SAVE/)).toBeDefined());
    expect(screen.getByRole('button', { name: 'Save profile' })).toHaveProperty('disabled', false);
  });

  it('surfaces server-side validation errors against the offending fields', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockImplementation((message: { type: string }) =>
      message.type === 'PROFILE_GET'
        ? Promise.resolve({
            error: {
              code: 'PROFILE_MISSING',
              message: 'No profile has been created yet.',
              recoverable: true,
              suggestedAction: 'Open settings.',
              debugContext: {},
            },
          })
        : Promise.resolve({
            error: {
              code: 'VALIDATION_FAILED',
              message: 'The request did not match its schema — personal.phone: too long',
              recoverable: true,
              suggestedAction: 'Correct the highlighted fields and save again.',
              debugContext: { fields: ['personal.phone'] },
            },
          }),
    );

    render(<OptionsApp />);
    await waitFor(() => expect(screen.getByLabelText(/Legal first name/)).toBeDefined());

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(screen.getByLabelText(/Legal first name/), { target: { value: 'Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    // The server named a field, so it is reported as a field problem.
    await waitFor(() => expect(screen.getByText(/personal\.phone/)).toBeDefined());
    expect(screen.getByText(/Nothing was saved\./)).toBeDefined();
  });
});

describe('popup never stays on "Checking…"', () => {
  it('reports an unanswered status request', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockResolvedValue(undefined);
    chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com/apply' }]);

    render(<PopupApp />);

    await waitFor(() => expect(screen.getByText('Disconnected')).toBeDefined());
    expect(screen.queryByText('Checking…')).toBeNull();
    // The Documents section reports the same unreachable worker, so the remedy
    // now appears more than once. Every occurrence is a real one.
    expect(screen.getAllByText(/chrome:\/\/extensions/).length).toBeGreaterThan(0);
  });

  it('reports a thrown tab query instead of hanging', async () => {
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockResolvedValue(undefined);
    chromeMock.tabs.query.mockRejectedValue(new Error('tabs unavailable'));

    render(<PopupApp />);

    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull());
    expect(
      screen.getAllByText(/could not read its own state|chrome:\/\/extensions/).length,
    ).toBeGreaterThan(0);
  });
});
