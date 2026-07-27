import { useEffect, useState } from 'react';
import {
  aiGenerationSettingsSchema,
  type AiGenerationSettings,
  type ModelsResponse,
} from '@internship-agent/shared';
import { sendMessage } from '../../messaging/messages.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../../storage/settings.js';

function matchesInstalledModel(installed: string, configured: string): boolean {
  const actual = installed.trim().toLowerCase();
  const wanted = configured.trim().toLowerCase();
  return actual === wanted || (!wanted.includes(':') && actual.split(':')[0] === wanted);
}

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
      <label>
        Generation model
        <select
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
      </label>
      <p className="section-note">
        Ollama URL: <code>{ollamaUrl || 'Unavailable until the server responds'}</code>
      </p>
      <div className="button-row">
        <button type="button" disabled={working} onClick={() => void refreshModels()}>
          Refresh available models
        </button>
        <button type="button" disabled={working} onClick={() => void testGeneration()}>
          Test AI generation
        </button>
      </div>
      <label>
        Optional validation model
        <input
          value={settings.validationModel ?? ''}
          onChange={(event) => patch({ validationModel: event.target.value.trim() || undefined })}
        />
      </label>
      <label>
        Temperature
        <input
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={settings.temperature}
          onChange={(event) => patch({ temperature: Number(event.target.value) })}
        />
      </label>
      <label>
        Maximum generation tokens
        <input
          type="number"
          min="64"
          max="8192"
          value={settings.maximumGenerationTokens}
          onChange={(event) => patch({ maximumGenerationTokens: Number(event.target.value) })}
        />
      </label>
      <label>
        Default answer length
        <select
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
      </label>
      <label>
        Timeout in seconds
        <input
          type="number"
          min="5"
          max="180"
          value={Math.round(settings.generationTimeoutMs / 1000)}
          onChange={(event) => patch({ generationTimeoutMs: Number(event.target.value) * 1000 })}
        />
      </label>
      <label>
        Maximum retries
        <select
          value={settings.maximumRetries}
          onChange={(event) => patch({ maximumRetries: Number(event.target.value) })}
        >
          <option value="0">No retry</option>
          <option value="1">One retry</option>
        </select>
      </label>
      <label>
        Concurrent generations
        <select
          value={settings.maximumConcurrentGenerations}
          onChange={(event) => patch({ maximumConcurrentGenerations: Number(event.target.value) })}
        >
          <option value="1">1</option>
          <option value="2">2</option>
        </select>
      </label>
      <label>
        Preferred tone
        <input
          value={settings.preferredTone}
          onChange={(event) => patch({ preferredTone: event.target.value })}
        />
      </label>
      <button className="primary" type="button" disabled={working} onClick={() => void save()}>
        Save AI settings
      </button>
      {status ? <p role="status">{status}</p> : null}
    </>
  );
}
