import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  DEFAULT_ERROR_GUIDANCE,
  LIMITS,
  documentTypeSchema,
  type AgentError,
  type DocumentType,
  type SavedDocument,
} from '@internship-agent/shared';
import { sendMessage } from '../../messaging/messages.js';
import { loadSettings, saveSettings } from '../../storage/settings.js';
import { SelectField, TextField } from '../components/Field.js';
import { ListInput } from '../components/ListInput.js';

const TYPE_OPTIONS: ReadonlyArray<{ value: DocumentType; label: string }> = [
  { value: 'resume', label: 'Resume' },
  { value: 'cover_letter', label: 'Cover letter' },
  { value: 'transcript', label: 'Transcript' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'other', label: 'Other' },
];

const ACCEPT = Object.entries(ALLOWED_DOCUMENT_MIME_TYPES)
  .flatMap(([mime, extensions]) => [mime, ...extensions.map((extension) => `.${extension}`)])
  .join(',');

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; error: AgentError };

/** Anything thrown that reaches the UI is shown, never swallowed. */
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Reads a picked file into base64 without ever exposing a filesystem path. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected reader result'));
        return;
      }
      // Strip the `data:<mime>;base64,` prefix the server does not accept.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function DocumentsSection(): JSX.Element {
  const [documents, setDocuments] = useState<SavedDocument[]>([]);
  const [defaultResumeId, setDefaultResumeId] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AgentError | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const [name, setName] = useState('');
  const [type, setType] = useState<DocumentType>('resume');
  const [tags, setTags] = useState<string[]>([]);
  const [targetRoles, setTargetRoles] = useState<string[]>([]);
  const [targetIndustries, setTargetIndustries] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  /** `finally` guarantees the list never stays on "Loading documents…". */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [result, settings] = await Promise.all([
        sendMessage({ type: 'DOCUMENTS_LIST' }),
        loadSettings(),
      ]);
      setSelectedDocumentId(settings.selectedDocumentId);

      if (result.data) {
        setDocuments(result.data.documents);
        setDefaultResumeId(result.data.defaultResumeId);
        setLoadError(null);
      } else {
        setLoadError(result.error ?? unexpectedError('listing documents', 'no result returned'));
      }
    } catch (cause) {
      setLoadError(unexpectedError('listing documents', cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onUpload = (): void => {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setStatus({
        kind: 'error',
        error: {
          code: 'DOCUMENT_MISSING',
          message: 'No file selected.',
          recoverable: true,
          suggestedAction: 'Choose a file, then click Register document.',
          debugContext: {},
        },
      });
      return;
    }

    if (file.size > LIMITS.maxDocumentBytes) {
      setStatus({
        kind: 'error',
        error: {
          code: 'REQUEST_TOO_LARGE',
          message: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(
            LIMITS.maxDocumentBytes,
          )} limit.`,
          recoverable: true,
          suggestedAction: 'Compress or re-export the document, then try again.',
          debugContext: {},
        },
      });
      return;
    }

    const mimeType = file.type;
    if (!(mimeType in ALLOWED_DOCUMENT_MIME_TYPES)) {
      setStatus({
        kind: 'error',
        error: {
          code: 'VALIDATION_FAILED',
          message: `${file.name} has type "${mimeType || 'unknown'}", which is not an accepted document format.`,
          recoverable: true,
          suggestedAction: `Use one of: ${Object.values(ALLOWED_DOCUMENT_MIME_TYPES)
            .flat()
            .join(', ')}.`,
          debugContext: {},
        },
      });
      return;
    }

    setStatus({ kind: 'busy', what: `Registering ${file.name}…` });

    void (async () => {
      try {
        const contentBase64 = await readAsBase64(file);
        const result = await sendMessage({
          type: 'DOCUMENT_CREATE',
          document: {
            name: name.trim() || file.name,
            type,
            fileName: file.name,
            mimeType: mimeType as keyof typeof ALLOWED_DOCUMENT_MIME_TYPES,
            contentBase64,
            tags,
            targetRoles,
            targetIndustries,
            isDefault: false,
          },
        });

        if (result.data) {
          setStatus({ kind: 'ok', message: `Registered "${result.data.name}".` });
          setName('');
          setTags([]);
          setTargetRoles([]);
          setTargetIndustries([]);
          if (fileInput.current) fileInput.current.value = '';
          await refresh();
        } else {
          setStatus({
            kind: 'error',
            error: result.error ?? unexpectedError('registering the document', 'no result'),
          });
        }
      } catch (cause) {
        setStatus({
          kind: 'error',
          error: {
            code: 'UPLOAD_FAILED',
            message: cause instanceof Error ? cause.message : String(cause),
            recoverable: true,
            suggestedAction: 'Try a different file.',
            debugContext: {},
          },
        });
      }
    })();
  };

  const makeDefault = (document: SavedDocument): void => {
    setStatus({ kind: 'busy', what: `Setting "${document.name}" as default…` });
    void (async () => {
      const result = await sendMessage({
        type: 'DOCUMENT_UPDATE',
        id: document.id,
        patch: { isDefault: true },
      });
      if (result.data) {
        setStatus({
          kind: 'ok',
          message: `"${result.data.name}" is now the default ${result.data.type.replace('_', ' ')}.`,
        });
        await refresh();
      } else {
        setStatus({
          kind: 'error',
          error: result.error ?? unexpectedError('changing the default', 'no result returned'),
        });
      }
    })().catch((cause: unknown) => {
      setStatus({ kind: 'error', error: unexpectedError('changing the default', cause) });
    });
  };

  const chooseForFilling = (document: SavedDocument | null): void => {
    void (async () => {
      await saveSettings({ selectedDocumentId: document?.id ?? null });
      setSelectedDocumentId(document?.id ?? null);
      setStatus({
        kind: 'ok',
        message: document
          ? `"${document.name}" will be used for the next application.`
          : 'Cleared the explicit choice; the default resume will be used.',
      });
    })().catch((cause: unknown) => {
      setStatus({ kind: 'error', error: unexpectedError('saving your resume choice', cause) });
    });
  };

  const remove = (document: SavedDocument): void => {
    setStatus({ kind: 'busy', what: `Deleting "${document.name}"…` });
    void (async () => {
      const result = await sendMessage({ type: 'DOCUMENT_DELETE', id: document.id });
      if (result.data) {
        if (selectedDocumentId === document.id) {
          await saveSettings({ selectedDocumentId: null });
        }
        setStatus({ kind: 'ok', message: `Deleted "${document.name}" and removed its file.` });
        await refresh();
      } else {
        setStatus({
          kind: 'error',
          error: result.error ?? unexpectedError('deleting the document', 'no result returned'),
        });
      }
    })().catch((cause: unknown) => {
      setStatus({ kind: 'error', error: unexpectedError('deleting the document', cause) });
    });
  };

  const extract = (document: SavedDocument): void => {
    setStatus({ kind: 'busy', what: `Extracting text from "${document.name}"…` });
    void (async () => {
      const result = await sendMessage({ type: 'DOCUMENT_EXTRACT', id: document.id });
      if (result.data) {
        if (result.data.status === 'completed') {
          setStatus({
            kind: 'ok',
            message: `Extracted ${result.data.normalizedText.length} characters across ${result.data.sections.length} sections.`,
          });
        } else {
          setStatus({
            kind: 'error',
            error:
              result.data.error ??
              unexpectedError('extracting resume text', `status ${result.data.status}`),
          });
        }
      } else {
        setStatus({
          kind: 'error',
          error: result.error ?? unexpectedError('extracting resume text', 'no result'),
        });
      }
    })();
  };

  return (
    <>
      <h2>Documents</h2>
      <p className="section-note">
        Files are copied into the agent&apos;s own documents folder and referenced from there. The
        agent never reads from anywhere else on your disk, and the file itself is never sent to the
        model.
      </p>

      {loading ? <p className="muted">Loading documents…</p> : null}

      {loadError ? (
        <p className="result result--bad" role="alert">
          {loadError.message} {loadError.suggestedAction}
        </p>
      ) : null}

      {!loading && !loadError && documents.length === 0 ? (
        <p className="entry-list__empty">
          No documents registered yet. Add a resume below so applications have something to attach.
        </p>
      ) : null}

      {documents.length > 0 ? (
        <table className="doc-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Tags and targets</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => {
              const isSelected = selectedDocumentId === document.id;
              const isDefaultResume = document.id === defaultResumeId;
              return (
                <tr key={document.id}>
                  <td>
                    <strong>{document.name}</strong>
                    <br />
                    <span className="muted">{document.fileName}</span>
                  </td>
                  <td>{document.type.replace('_', ' ')}</td>
                  <td>{formatBytes(document.sizeBytes)}</td>
                  <td className="muted">
                    {[
                      document.tags.length > 0 ? `tags: ${document.tags.join(', ')}` : null,
                      document.targetRoles.length > 0
                        ? `roles: ${document.targetRoles.join(', ')}`
                        : null,
                      document.targetIndustries.length > 0
                        ? `industries: ${document.targetIndustries.join(', ')}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                  <td>
                    {document.isDefault ? <span className="badge badge--ok">Default</span> : null}
                    {isSelected ? <span className="badge badge--ok">Selected</span> : null}
                    {!document.isDefault && !isSelected ? <span className="muted">—</span> : null}
                  </td>
                  <td className="doc-table__actions">
                    {document.type === 'resume' &&
                    [
                      'application/pdf',
                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      'text/plain',
                    ].includes(document.mimeType) ? (
                      <button type="button" onClick={() => extract(document)}>
                        Extract text
                      </button>
                    ) : null}
                    {!document.isDefault ? (
                      <button type="button" onClick={() => makeDefault(document)}>
                        Make default
                      </button>
                    ) : null}
                    {isDefaultResume && isSelected ? null : (
                      <button type="button" onClick={() => chooseForFilling(document)}>
                        Use next
                      </button>
                    )}
                    {isSelected ? (
                      <button type="button" onClick={() => chooseForFilling(null)}>
                        Clear choice
                      </button>
                    ) : null}
                    <button className="danger" type="button" onClick={() => remove(document)}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      <h3>Register a document</h3>
      <div className="grid grid--2">
        <TextField
          id="docName"
          label="Display name"
          value={name}
          onChange={setName}
          hint="Defaults to the filename if you leave this blank."
        />
        <SelectField<DocumentType>
          id="docType"
          label="Type"
          value={type}
          options={TYPE_OPTIONS}
          onChange={(next) => setType(documentTypeSchema.parse(next))}
        />
        <div className="grid__full">
          <ListInput id="docTags" label="Tags" values={tags} onChange={setTags} />
          <ListInput
            id="docRoles"
            label="Target roles"
            values={targetRoles}
            onChange={setTargetRoles}
            hint="Used later to pick the best resume for a posting. Separate entries with commas."
          />
          <ListInput
            id="docIndustries"
            label="Target industries"
            values={targetIndustries}
            onChange={setTargetIndustries}
          />
          <div className="field">
            <label htmlFor="docFile">File</label>
            <input id="docFile" type="file" ref={fileInput} accept={ACCEPT} />
            <p className="hint">
              Up to {formatBytes(LIMITS.maxDocumentBytes)}. Accepted: PDF, DOC, DOCX, RTF, TXT, MD,
              PNG, JPG. The first resume you add automatically becomes the default.
            </p>
          </div>
        </div>
      </div>

      <div className="options__buttons">
        <button
          className="primary"
          type="button"
          onClick={onUpload}
          disabled={status.kind === 'busy'}
        >
          {status.kind === 'busy' ? 'Working…' : 'Register document'}
        </button>
      </div>

      {status.kind === 'busy' ? (
        <p className="result" role="status">
          {status.what}
        </p>
      ) : null}
      {status.kind === 'ok' ? (
        <p className="result result--ok" role="status">
          {status.message}
        </p>
      ) : null}
      {status.kind === 'error' ? (
        <p className="result result--bad" role="alert">
          {status.error.message} {status.error.suggestedAction}
        </p>
      ) : null}
    </>
  );
}
