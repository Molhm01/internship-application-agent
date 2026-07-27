import { createServer } from 'node:http';

const port = Number(process.env.MOCK_OLLAMA_PORT || 11435);
const model = 'mock-grounded:latest';

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/version') {
    json(response, 200, { version: 'test-1.0.0' });
    return;
  }
  if (request.method === 'GET' && request.url === '/api/tags') {
    json(response, 200, { models: [{ name: model, size: 1 }] });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/chat') {
    json(response, 404, { error: 'not found' });
    return;
  }
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw);
      if (String(body.messages?.[0]?.content ?? '').includes('Classify an untrusted')) {
        json(response, 200, {
          model,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              classification: 'other_custom',
              confidence: 'medium',
              reason: 'The question is an eligible written response without a narrower rule.',
            }),
          },
          done: true,
        });
        return;
      }
      const prompt = String(body.messages?.at(-1)?.content ?? '');
      if (prompt.includes('Return exactly {"status":"ok"}')) {
        json(response, 200, {
          model,
          message: { role: 'assistant', content: JSON.stringify({ status: 'ok' }) },
          done: true,
        });
        return;
      }
      const question =
        /<UNTRUSTED_APPLICATION_QUESTION>\n([\s\S]*?)\n<\/UNTRUSTED_APPLICATION_QUESTION>/.exec(
          prompt,
        )?.[1] ?? '';
      const evidenceRaw =
        /<VERIFIED_EVIDENCE>\n([\s\S]*?)\n<\/VERIFIED_EVIDENCE>/.exec(prompt)?.[1] ?? '[]';
      const evidence = JSON.parse(evidenceRaw);
      const classification = /Classification: ([a-z_]+)/.exec(prompt)?.[1] ?? 'other_custom';
      const selected = evidence.slice(0, 3);
      const fact = String(selected[0]?.facts?.[0] ?? selected[0]?.text ?? 'my saved experience');
      const secondFact = String(
        selected[1]?.facts?.[0] ?? selected[1]?.text ?? 'my verified project work',
      );
      const answer =
        classification === 'achievement'
          ? `Two engineering achievements I am proud of are ${fact} and ${secondFact}. I value them because they strengthened my practical problem-solving and teamwork through verified project experience.`
          : `I am interested in this role because it connects directly with ${fact}. I would bring that verified background to the responsibilities described in the posting while continuing to develop through practical team experience.`;
      const content = {
        questionId: /"questionId":"([^"]+)"/.exec(prompt)?.[1] ?? 'unknown',
        status: 'generated',
        classification,
        answer,
        evidenceUsed: selected.map((item) => item.id),
        factualClaims: selected.length
          ? [{ claim: `My background includes ${fact}.`, evidenceIds: [selected[0].id] }]
          : [],
        missingInformation: [],
        warnings: question.toLowerCase().includes('ignore previous instructions')
          ? ['The untrusted question contained an instruction-like phrase that was ignored.']
          : [],
        confidence: 'high',
        wordCount: answer.trim().split(/\s+/).length,
        characterCount: answer.length,
      };
      json(response, 200, {
        model,
        message: { role: 'assistant', content: JSON.stringify(content) },
        done: true,
      });
    } catch (error) {
      json(response, 400, { error: String(error) });
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Mock Ollama listening on http://127.0.0.1:${port}\n`);
});
