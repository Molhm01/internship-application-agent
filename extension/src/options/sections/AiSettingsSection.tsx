import { useEffect, useState } from 'react';
import {
  aiGenerationSettingsSchema,
  matchesModelName,
  type AiGenerationSettings,
  type ModelsResponse,
} from '@internship-agent/shared';
import { sendMessage } from '../../messaging/messages.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../../storage/settings.js';
import { Field } from '../components/Field.js';
import { StatusBadge } from '../../components/StatusBadge.js';

/** One rule for "is this the configured model", shared with the server. */
const matchesInstalledModel = matchesModelName;

export function AiSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<AiGenerationSettings>(DEFAULT_SETTINGS.ai);
  const [aiGenerationEnabled, setAiGenerationEnabled] = useState(
    DEFAULT_SETTINGS.aiGenerationEnabled,
  );
  const [status, setStatus] = useState('');
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [working, setWorking] = useState(false);
  const patch = (update: Partial<AiGenerationSettings>): void => {
    setSettings((current) => ({ ...current, ...update }));
    setStatus('');
  };
  const persist = async (): Promise<AiGenerationSettings | null> => {
    const parsed = aiGenerationSettingsSchema.safeParse({
      ...settings,
      generationModel: settings.generationModel.trim(),
    });
    if (!parsed.success) {
      setStatus(parsed.error.issues.map((issue) => issue.message).join('; '));
      return null;
    }
    await saveSettings({
      aiGenerationEnabled,
      ai: parsed.data,
      selectedModel: parsed.data.generationModel,
    });
    setSettings(parsed.data);
    return parsed.data;
  };
  const save = async (): Promise<void> => {
    const saved = await persist();
    if (!saved) return;
    setStatus('AI generation settings saved.');
  };
  const refreshModels = async (configuredModel = settings.generationModel): Promise<void> => {
    setWorking(true);
    setStatus('Checking the local server and installed Ollama models…');
    const [modelResult, agentStatus] = await Promise.all([
      sendMessage({ type: 'OLLAMA_MODELS_LIST' }),
      sendMessage({ type: 'AGENT_STATUS_REQUEST' }),
    ]);
    setWorking(false);
    if (agentStatus.health?.ollama.baseUrl) setOllamaUrl(agentStatus.health.ollama.baseUrl);
    if (modelResult.error) {
      setModels(null);
      setStatus(
        `${modelResult.error.code}: ${modelResult.error.message} ${modelResult.error.suggestedAction}`,
      );
      return;
    }
    setModels(modelResult.data);
    const resolved = modelResult.data.models.find((model) =>
      matchesInstalledModel(model.name, configuredModel),
    );
    if (resolved && resolved.name !== configuredModel) {
      setSettings((current) => ({ ...current, generationModel: resolved.name }));
    }
    setStatus(
      modelResult.data.models.length
        ? `Found ${modelResult.data.models.length} installed Ollama model(s).`
        : 'Ollama is reachable, but no models are installed.',
    );
  };
  const testGeneration = async (): Promise<void> => {
    const saved = await persist();
    if (!saved) return;
    setWorking(true);
    setStatus(`Testing structured generation with ${saved.generationModel}…`);
    const result = await sendMessage({
      type: 'TEST_AI_GENERATION',
      model: saved.generationModel,
      timeoutMs: saved.generationTimeoutMs,
    });
    setWorking(false);
    if (result.error) {
      setStatus(`${result.error.code}: ${result.error.message} ${result.error.suggestedAction}`);
      return;
    }
    setStatus(
      `Connected. ${result.data.model} returned valid structured output in ${result.data.durationMs} ms.`,
    );
  };
  useEffect(() => {
    void loadSettings().then((stored) => {
      setSettings(stored.ai);
      setAiGenerationEnabled(stored.aiGenerationEnabled);
      void refreshModels(stored.ai.generationModel);
    });
  }, []);
  const configuredModelMissing =
    settings.generationModel.length > 0 &&
    models !== null &&
    !models.models.some((model) => matchesInstalledModel(model.name, settings.generationModel));
  return (
    <>
      <h2>Local AI answer generation</h2>
      <p className="section-note">
        <strong>AI answer generation runs locally through your configured Ollama server.</strong>{' '}
        Generated answers use only selected saved evidence, always require review, and are never
        submitted automatically.
      </p>

      {/*
        What the model layer can do right now, before any of the settings that
        change it. Three facts, and each is observed rather than configured:
        whether generation is on, whether Ollama answered, and how many models
        it reported.
      */}
      <section className="connection" aria-label="AI status">
        <header className="connection__head">
          <StatusBadge
            tone={!aiGenerationEnabled ? 'idle' : models === null ? 'danger' : 'verified'}
            label={
              !aiGenerationEnabled
                ? 'AI disabled'
                : models === null
                  ? 'Ollama unreachable'
                  : 'Ollama connected'
            }
            size="lg"
          />
        </header>
        <dl className="diagnostics-grid">
          <div>
            <dt>Ollama URL</dt>
            <dd className="mono">{ollamaUrl || 'Unavailable until the server responds'}</dd>
          </div>
          <div>
            <dt>Installed models</dt>
            <dd className="mono">{models ? models.models.length : '—'}</dd>
          </div>
          <div>
            <dt>Selected model</dt>
            <dd className="mono">{settings.generationModel || 'None'}</dd>
          </div>
        </dl>
      </section>

      {/*
        A configured model the server does not have is stated, not absorbed. It
        is the difference between "the AI is off" and "the AI is on and pointed
        at something that is not there", and silently keeping the stale name
        would let a run fail later for a reason the settings page already knew.
      */}
      {configuredModelMissing ? (
        <div className="callout callout--warning" role="alert">
          <p className="callout__title">Model unavailable</p>
          <p>
            <code>{settings.generationModel}</code> is saved as the generation model and Ollama does
            not report it as installed. Pull it with{' '}
            <code>ollama pull {settings.generationModel}</code>, or choose one of the installed
            models below and save.
          </p>
        </div>
      ) : null}

      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={aiGenerationEnabled}
          onChange={(event) => {
            setAiGenerationEnabled(event.target.checked);
            setStatus('');
          }}
        />
        Enable grounded AI answer generation
      </label>

      <Field id="generationModel" label="Generation model">
        <select
          id="generationModel"
          value={settings.generationModel}
          onChange={(event) => patch({ generationModel: event.target.value })}
          disabled={working || models === null}
        >
          {configuredModelMissing ? (
            <option value={settings.generationModel}>
              {settings.generationModel} (not installed)
            </option>
          ) : null}
          {models?.models.map((model) => (
            <option key={model.name} value={model.name}>
              {model.name}
            </option>
          ))}
          {!models?.models.length && !settings.generationModel ? (
            <option value="">No installed models found</option>
          ) : null}
        </select>
      </Field>

      <div className="button-row">
        <button type="button" disabled={working} onClick={() => void refreshModels()}>
          Refresh available models
        </button>
        <button type="button" disabled={working} onClick={() => void testGeneration()}>
          Test AI generation
        </button>
      </div>

      <h3>Generation</h3>
      <div className="grid grid--2">
        <Field id="validationModel" label="Optional validation model">
          <input
            id="validationModel"
            value={settings.validationModel ?? ''}
            onChange={(event) => patch({ validationModel: event.target.value.trim() || undefined })}
          />
        </Field>
        <Field id="preferredTone" label="Preferred tone">
          <input
            id="preferredTone"
            value={settings.preferredTone}
            onChange={(event) => patch({ preferredTone: event.target.value })}
          />
        </Field>
        <Field id="temperature" label="Temperature">
          <input
            id="temperature"
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={settings.temperature}
            onChange={(event) => patch({ temperature: Number(event.target.value) })}
          />
        </Field>
        <Field id="maximumGenerationTokens" label="Maximum generation tokens">
          <input
            id="maximumGenerationTokens"
            type="number"
            min="64"
            max="8192"
            value={settings.maximumGenerationTokens}
            onChange={(event) => patch({ maximumGenerationTokens: Number(event.target.value) })}
          />
        </Field>
        <Field id="defaultAnswerLength" label="Default answer length">
          <select
            id="defaultAnswerLength"
            value={settings.defaultAnswerLength}
            onChange={(event) =>
              patch({
                defaultAnswerLength: event.target
                  .value as AiGenerationSettings['defaultAnswerLength'],
              })
            }
          >
            <option value="very_short">Very short (25–50 words)</option>
            <option value="short">Short (50–100 words)</option>
            <option value="medium">Medium (100–175 words)</option>
            <option value="detailed">Detailed (175–300 words)</option>
            <option value="field_limit">Use field limit</option>
          </select>
        </Field>
        <Field id="generationTimeout" label="Timeout in seconds">
          <input
            id="generationTimeout"
            type="number"
            min="5"
            max="180"
            value={Math.round(settings.generationTimeoutMs / 1000)}
            onChange={(event) => patch({ generationTimeoutMs: Number(event.target.value) * 1000 })}
          />
        </Field>
        <Field id="maximumRetries" label="Maximum retries">
          <select
            id="maximumRetries"
            value={settings.maximumRetries}
            onChange={(event) => patch({ maximumRetries: Number(event.target.value) })}
          >
            <option value="0">No retry</option>
            <option value="1">One retry</option>
          </select>
        </Field>
        <Field id="maximumConcurrentGenerations" label="Concurrent generations">
          <select
            id="maximumConcurrentGenerations"
            value={settings.maximumConcurrentGenerations}
            onChange={(event) =>
              patch({ maximumConcurrentGenerations: Number(event.target.value) })
            }
          >
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </Field>
      </div>

      <div className="options__buttons">
        <button className="primary" type="button" disabled={working} onClick={() => void save()}>
          Save AI settings
        </button>
      </div>
      {status ? (
        <p className="result" role="status">
          {status}
        </p>
      ) : null}
    </>
  );
}
