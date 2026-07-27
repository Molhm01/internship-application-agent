/**
 * Confirms the configured Ollama model exists and can satisfy a JSON-schema
 * constrained request — the capability Milestone 4's planner depends on.
 *
 *   node scripts/check-ollama.mjs
 *   OLLAMA_MODEL=some-other-model node scripts/check-ollama.mjs
 *
 * Exits non-zero with a specific reason on any failure.
 */
const baseUrl = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const model = process.env.OLLAMA_MODEL ?? 'qwen3.5:9b';
const timeoutMs = Number(process.env.OLLAMA_PROBE_TIMEOUT_MS ?? 180_000);

function fail(message, hint) {
  console.error(`FAIL: ${message}`);
  if (hint) console.error(`      ${hint}`);
  process.exit(1);
}

async function getJson(path, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

let version;
try {
  version = (await getJson('/api/version', 5000)).version;
} catch (cause) {
  fail(
    `Could not reach Ollama at ${baseUrl}: ${cause.message}`,
    'Start it with `ollama serve` and retry.',
  );
}
console.log(`Ollama ${version} reachable at ${baseUrl}`);

let installed = [];
try {
  installed = (await getJson('/api/tags', 5000)).models.map((entry) => entry.name);
} catch (cause) {
  fail(`Could not list models: ${cause.message}`);
}
console.log(`Installed models: ${installed.join(', ') || '(none)'}`);

if (!installed.includes(model)) {
  fail(
    `Configured model "${model}" is not installed.`,
    `Run \`ollama pull ${model}\`, or set OLLAMA_MODEL to one of: ${installed.join(', ')}`,
  );
}
console.log(`Configured model "${model}" is installed`);

// A miniature version of the Milestone 4 contract: a closed enum, a boolean, a
// bounded number. If a model cannot hold this shape, it cannot plan a form.
const format = {
  type: 'object',
  properties: {
    fieldType: { type: 'string', enum: ['text', 'select', 'radio', 'checkbox', 'date', 'number'] },
    answer: { type: 'boolean' },
    confidence: { type: 'number' },
    requiresReview: { type: 'boolean' },
  },
  required: ['fieldType', 'answer', 'confidence', 'requiresReview'],
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
const startedAt = Date.now();
let content;
try {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: { temperature: 0 },
      format,
      messages: [
        {
          role: 'system',
          content: 'You map job-application questions to structured answers. Reply with JSON only.',
        },
        {
          role: 'user',
          content:
            'Question: "Are you legally authorized to work in the United States?" ' +
            'Known profile fact: workAuthorization = "US citizen". ' +
            'Classify the field type and give the answer.',
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  content = (await response.json()).message?.content;
} catch (cause) {
  const aborted = cause.name === 'AbortError';
  fail(
    aborted
      ? `Model "${model}" did not respond within ${timeoutMs}ms.`
      : `Structured-output request failed: ${cause.message}`,
    aborted ? 'Try a smaller model or raise OLLAMA_PROBE_TIMEOUT_MS.' : undefined,
  );
} finally {
  clearTimeout(timer);
}

const elapsedMs = Date.now() - startedAt;

let parsed;
try {
  parsed = JSON.parse(content);
} catch {
  fail(`Model returned text that is not JSON: ${String(content).slice(0, 300)}`);
}

const problems = [];
if (!format.properties.fieldType.enum.includes(parsed.fieldType)) {
  problems.push(`fieldType "${parsed.fieldType}" is outside the supplied enum`);
}
if (typeof parsed.answer !== 'boolean') problems.push('answer is not a boolean');
if (typeof parsed.confidence !== 'number') problems.push('confidence is not a number');
if (typeof parsed.requiresReview !== 'boolean') problems.push('requiresReview is not a boolean');

if (problems.length > 0) {
  fail(`Response did not satisfy the schema: ${problems.join('; ')}`);
}

console.log(`Structured output honoured the schema in ${elapsedMs}ms:`);
console.log(JSON.stringify(parsed));
console.log('PASS');
