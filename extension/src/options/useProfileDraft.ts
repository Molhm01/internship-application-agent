import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_ERROR_GUIDANCE,
  profileUpdateSchema,
  type AgentError,
  type Profile,
  type ProfileCompleteness,
  type ProfileUpdate,
} from '@internship-agent/shared';
import { sendMessage, type ExtensionResponse } from '../messaging/messages.js';
import { trace, traceFailure } from '../utils/trace.js';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'invalid'; fieldErrors: Record<string, string> }
  | { kind: 'error'; error: AgentError };

/** What the last profile import did, at key level only. Never a value. */
export type ProfileSyncResult = ExtensionResponse<'SYNC_PROFILE'>;

export interface ProfileDraftController {
  draft: ProfileUpdate;
  completeness: ProfileCompleteness | null;
  /**
   * The import that ran before this profile was read, or null when none has.
   * Shown so a user looking at a blank section can tell "Internship Pilot has
   * not told us either" from "the import did not run".
   */
  syncReport: ProfileSyncResult | null;
  loading: boolean;
  /** Present when the profile could not be loaded at all. */
  loadError: AgentError | null;
  /** True when the stored profile does not exist yet. */
  isNew: boolean;
  dirty: boolean;
  saveState: SaveState;
  fieldError: (path: string) => string | undefined;
  update: (mutate: (draft: ProfileUpdate) => ProfileUpdate) => void;
  save: () => void;
  reload: () => void;
}

/** A blank draft. Every field is empty — nothing is guessed on the user's behalf. */
export function emptyProfileDraft(): ProfileUpdate {
  return profileUpdateSchema.parse({});
}

function toDraft(profile: Profile): ProfileUpdate {
  const { updatedAt: _updatedAt, ...rest } = profile;
  return rest;
}

/** Wraps a thrown value that reached the UI, which is always a bug worth showing. */
function unexpectedError(stage: string, cause: unknown): AgentError {
  return {
    code: 'INTERNAL_ERROR',
    message: `The settings page hit an unexpected error while ${stage}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE.INTERNAL_ERROR,
    debugContext: { stage },
  };
}

/**
 * A response that carries neither data nor a usable error. Treated as a failure
 * rather than dereferenced, so a malformed reply can never crash the loader.
 */
function malformedResponse(stage: string): AgentError {
  return {
    code: 'EXTENSION_RELOAD_REQUIRED',
    message: `The background worker returned an unrecognized reply while ${stage}.`,
    recoverable: true,
    suggestedAction: DEFAULT_ERROR_GUIDANCE.EXTENSION_RELOAD_REQUIRED,
    debugContext: { stage },
  };
}

export function useProfileDraft(): ProfileDraftController {
  const [draft, setDraft] = useState<ProfileUpdate>(emptyProfileDraft);
  const [saved, setSaved] = useState<string>('');
  const [completeness, setCompleteness] = useState<ProfileCompleteness | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AgentError | null>(null);
  const [isNew, setIsNew] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [syncReport, setSyncReport] = useState<ProfileSyncResult | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    trace('profile', 'load started', { attempt: reloadNonce });
    setLoading(true);
    setLoadError(null);

    /**
     * Every exit from this function runs through the `finally` that clears the
     * loading flag. A thrown value used to escape into the void and leave the
     * page on "Loading profile…" with nothing on screen to explain it.
     */
    const load = async (): Promise<void> => {
      try {
        // Before reading: pull anything Internship Pilot holds that the agent
        // server does not. The two stores were independent, so this page used
        // to show blanks for experience and education the user had already
        // entered on the website — and then ask them to enter it again.
        //
        // Non-destructive and best-effort: the merge cannot overwrite a
        // populated value with an empty one, and a failure here is not a reason
        // to refuse to show the profile that does exist.
        const sync = await sendMessage({ type: 'SYNC_PROFILE' }).catch(() => null);
        if (cancelled) return;
        if (sync?.ok) {
          trace('profile', 'imported the Internship Pilot profile before loading', {
            changed: sync.changed,
            imported: sync.report.filter((entry) => entry.status === 'imported').length,
          });
        }
        setSyncReport(sync ?? null);

        const result = await sendMessage({ type: 'PROFILE_GET' });
        if (cancelled) return;

        if (result.data) {
          trace('profile', 'existing profile loaded');
          const next = toDraft(result.data.profile);
          setDraft(next);
          setSaved(JSON.stringify(next));
          setCompleteness(result.data.completeness);
          setIsNew(false);
          return;
        }

        if (result.error?.code === 'PROFILE_MISSING') {
          // Expected on first run. Start from an empty default profile so the user
          // can fill it in; it is not written to disk until they save.
          trace('profile', 'no stored profile; starting an empty default draft');
          const blank = emptyProfileDraft();
          setDraft(blank);
          setSaved(JSON.stringify(blank));
          setCompleteness(null);
          setIsNew(true);
          return;
        }

        const error = result.error ?? malformedResponse('loading the profile');
        traceFailure('profile', 'load failed', { code: error.code });
        setLoadError(error);
      } catch (cause) {
        if (cancelled) return;
        traceFailure('profile', 'load threw', { error: String(cause) });
        setLoadError(unexpectedError('loading your profile', cause));
      } finally {
        if (!cancelled) {
          setLoading(false);
          trace('profile', 'load finished, loading=false');
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  const update = useCallback((mutate: (current: ProfileUpdate) => ProfileUpdate) => {
    setDraft((current) => mutate(current));
    setSaveState({ kind: 'idle' });
  }, []);

  const save = useCallback(() => {
    setSaveState({ kind: 'saving' });
    trace('profile', 'save started');

    const run = async (): Promise<void> => {
      try {
        // Validate locally first so field-level errors appear inline instead of the
        // user waiting on a round trip to learn a postal code is malformed.
        const parsed = profileUpdateSchema.safeParse(draft);
        if (!parsed.success) {
          const fieldErrors: Record<string, string> = {};
          for (const issue of parsed.error.issues) {
            const key = issue.path.join('.');
            fieldErrors[key] ??= issue.message;
          }
          trace('profile', 'save blocked by local validation', {
            fields: Object.keys(fieldErrors).length,
          });
          setSaveState({ kind: 'invalid', fieldErrors });
          return;
        }

        const result = await sendMessage({ type: 'PROFILE_SAVE', profile: parsed.data });

        if (result.data) {
          trace('profile', 'save succeeded');
          const next = toDraft(result.data.profile);
          setDraft(next);
          setSaved(JSON.stringify(next));
          setCompleteness(result.data.completeness);
          setIsNew(false);
          setSaveState({ kind: 'saved', at: new Date().toLocaleTimeString() });
          return;
        }

        const error = result.error ?? malformedResponse('saving the profile');
        traceFailure('profile', 'save failed', { code: error.code });

        // A server-side validation failure names the offending fields; show them
        // inline rather than only as a sentence.
        const fields = error.debugContext['fields'];
        if (error.code === 'VALIDATION_FAILED' && Array.isArray(fields) && fields.length > 0) {
          const fieldErrors: Record<string, string> = {};
          for (const field of fields) {
            if (typeof field === 'string') fieldErrors[field] = 'Rejected by the agent server.';
          }
          setSaveState({ kind: 'invalid', fieldErrors });
          return;
        }

        setSaveState({ kind: 'error', error });
      } catch (cause) {
        traceFailure('profile', 'save threw', { error: String(cause) });
        setSaveState({ kind: 'error', error: unexpectedError('saving your profile', cause) });
      }
    };

    void run();
  }, [draft]);

  const fieldError = useCallback(
    (path: string): string | undefined =>
      saveState.kind === 'invalid' ? saveState.fieldErrors[path] : undefined,
    [saveState],
  );

  const dirty = useMemo(() => JSON.stringify(draft) !== saved, [draft, saved]);

  return {
    draft,
    completeness,
    syncReport,
    loading,
    loadError,
    isNew,
    dirty,
    saveState,
    fieldError,
    update,
    save,
    reload: () => setReloadNonce((value) => value + 1),
  };
}
