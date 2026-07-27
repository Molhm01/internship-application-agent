import { afterEach, describe, expect, it } from 'vitest';
import {
  answerListResponseSchema,
  approvedAnswerSchema,
  errorResponseSchema,
  healthResponseSchema,
} from '@internship-agent/shared';
import { approvedAnswerBody, authHeaders, createTestServer, type TestServer } from './helpers.js';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function create(body: Record<string, unknown>) {
  return server!.app.inject({
    method: 'POST',
    url: '/answers',
    headers: authHeaders,
    payload: body,
  });
}

async function listAnswers() {
  const response = await server!.app.inject({
    method: 'GET',
    url: '/answers',
    headers: authHeaders,
  });
  return answerListResponseSchema.parse(response.json<{ data: unknown }>().data);
}

describe('approved answer creation', () => {
  it('creates an answer and returns it with a server-assigned id', async () => {
    server = await createTestServer();
    const response = await create(approvedAnswerBody());

    expect(response.statusCode).toBe(201);
    const answer = approvedAnswerSchema.parse(response.json<{ data: unknown }>().data);
    expect(answer.id.length).toBeGreaterThan(0);
    expect(answer.answer).toBe(true);
    expect(answer.aliases).toEqual(['Do you have US work authorization?']);
    expect(new Date(answer.lastUpdatedAt).getTime()).toBeGreaterThan(0);
  });

  it('requires a token', async () => {
    server = await createTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/answers',
      payload: approvedAnswerBody(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('round-trips every answer type', async () => {
    server = await createTestServer();

    const cases = [
      { answerType: 'text', answer: 'I am excited about embedded systems.' },
      { answerType: 'boolean', answer: false },
      { answerType: 'single_select', answer: 'Yes' },
      { answerType: 'multi_select', answer: ['Email', 'Phone'] },
      { answerType: 'date', answer: '2027-06-01' },
      { answerType: 'number', answer: 3 },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const response = await create(
        approvedAnswerBody({
          canonicalQuestion: `Question ${index}`,
          answerType: testCase.answerType,
          answer: testCase.answer,
          autoFillAllowed: false,
        }),
      );
      expect(response.statusCode, `${testCase.answerType} should be accepted`).toBe(201);
    }

    const listed = await listAnswers();
    expect(listed.answers).toHaveLength(cases.length);

    const multi = listed.answers.find((answer) => answer.answerType === 'multi_select');
    expect(multi?.answer).toEqual(['Email', 'Phone']);
    const numeric = listed.answers.find((answer) => answer.answerType === 'number');
    expect(numeric?.answer).toBe(3);
    const boolean = listed.answers.find((answer) => answer.answerType === 'boolean');
    expect(boolean?.answer).toBe(false);
  });

  it('rejects an answer value that contradicts its declared type', async () => {
    server = await createTestServer();

    const mismatches = [
      { answerType: 'number', answer: 'three' },
      { answerType: 'boolean', answer: 'yes' },
      { answerType: 'multi_select', answer: 'one' },
      { answerType: 'date', answer: 'June 2027' },
      { answerType: 'text', answer: 42 },
    ];

    for (const mismatch of mismatches) {
      const response = await create(
        approvedAnswerBody({ ...mismatch, canonicalQuestion: `Q ${mismatch.answerType}` }),
      );
      expect(response.statusCode, `${mismatch.answerType} mismatch must be rejected`).toBe(422);
    }
  });

  it('rejects a duplicate canonical question', async () => {
    server = await createTestServer();
    expect((await create(approvedAnswerBody())).statusCode).toBe(201);

    const duplicate = await create(approvedAnswerBody());
    expect(duplicate.statusCode).toBe(422);
    const error = errorResponseSchema.parse(duplicate.json());
    expect(error.error.message).toContain('already exists');
    expect(error.error.suggestedAction).toContain('Edit the existing answer');
  });
});

describe('sensitive answer policy enforcement', () => {
  it('refuses a sensitive answer that would auto-fill without review', async () => {
    server = await createTestServer();
    const response = await create(
      approvedAnswerBody({
        canonicalQuestion: 'What is your race?',
        answerType: 'text',
        answer: 'Prefer not to say',
        category: 'demographics',
        sensitive: true,
        autoFillAllowed: true,
        requiresReview: false,
      }),
    );

    expect(response.statusCode).toBe(422);
    const error = errorResponseSchema.parse(response.json());
    expect(error.error.message).toContain('cannot be auto-filled without review');
  });

  it('accepts a sensitive answer that keeps review on', async () => {
    server = await createTestServer();
    const response = await create(
      approvedAnswerBody({
        canonicalQuestion: 'What is your veteran status?',
        answerType: 'text',
        answer: 'I am not a protected veteran',
        category: 'demographics',
        sensitive: true,
        autoFillAllowed: true,
        requiresReview: true,
      }),
    );

    expect(response.statusCode).toBe(201);
    const answer = approvedAnswerSchema.parse(response.json<{ data: unknown }>().data);
    expect(answer.sensitive).toBe(true);
    expect(answer.requiresReview).toBe(true);
  });

  it('accepts a sensitive answer that is never auto-filled', async () => {
    server = await createTestServer();
    const response = await create(
      approvedAnswerBody({
        canonicalQuestion: 'What are your salary expectations?',
        answerType: 'text',
        answer: 'Negotiable',
        category: 'salary_expectation',
        sensitive: true,
        autoFillAllowed: false,
        requiresReview: true,
      }),
    );
    expect(response.statusCode).toBe(201);
  });

  it('refuses to auto-fill an answer that is not approved', async () => {
    server = await createTestServer();
    const response = await create(approvedAnswerBody({ approved: false, autoFillAllowed: true }));

    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.message).toContain(
      'must be approved before it can be auto-filled',
    );
  });
});

describe('approved answer updates and deletion', () => {
  it('updates an answer in place', async () => {
    server = await createTestServer();
    const created = approvedAnswerSchema.parse(
      (await create(approvedAnswerBody())).json<{ data: unknown }>().data,
    );

    const response = await server.app.inject({
      method: 'PUT',
      url: `/answers/${created.id}`,
      headers: authHeaders,
      payload: approvedAnswerBody({
        answer: false,
        aliases: ['Authorized to work?', 'US work eligibility?'],
      }),
    });

    expect(response.statusCode).toBe(200);
    const updated = approvedAnswerSchema.parse(response.json<{ data: unknown }>().data);
    expect(updated.id).toBe(created.id);
    expect(updated.answer).toBe(false);
    expect(updated.aliases).toHaveLength(2);

    expect((await listAnswers()).answers).toHaveLength(1);
  });

  it('lets an answer keep its own question on update', async () => {
    server = await createTestServer();
    const created = approvedAnswerSchema.parse(
      (await create(approvedAnswerBody())).json<{ data: unknown }>().data,
    );

    const response = await server.app.inject({
      method: 'PUT',
      url: `/answers/${created.id}`,
      headers: authHeaders,
      payload: approvedAnswerBody({ category: 'work-eligibility' }),
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects an update that collides with another answer', async () => {
    server = await createTestServer();
    const first = approvedAnswerSchema.parse(
      (await create(approvedAnswerBody())).json<{ data: unknown }>().data,
    );
    await create(approvedAnswerBody({ canonicalQuestion: 'Do you need sponsorship?' }));

    const response = await server.app.inject({
      method: 'PUT',
      url: `/answers/${first.id}`,
      headers: authHeaders,
      payload: approvedAnswerBody({ canonicalQuestion: 'Do you need sponsorship?' }),
    });

    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.message).toContain('already uses');
  });

  it('validates an update body just as strictly as a create', async () => {
    server = await createTestServer();
    const created = approvedAnswerSchema.parse(
      (await create(approvedAnswerBody())).json<{ data: unknown }>().data,
    );

    const response = await server.app.inject({
      method: 'PUT',
      url: `/answers/${created.id}`,
      headers: authHeaders,
      payload: approvedAnswerBody({ answerType: 'number', answer: 'three' }),
    });
    expect(response.statusCode).toBe(422);
  });

  it('reports NOT_FOUND for an unknown id on update and delete', async () => {
    server = await createTestServer();

    const update = await server.app.inject({
      method: 'PUT',
      url: '/answers/missing',
      headers: authHeaders,
      payload: approvedAnswerBody(),
    });
    expect(update.statusCode).toBe(404);
    expect(errorResponseSchema.parse(update.json()).error.code).toBe('NOT_FOUND');

    const remove = await server.app.inject({
      method: 'DELETE',
      url: '/answers/missing',
      headers: authHeaders,
    });
    expect(remove.statusCode).toBe(404);
  });

  it('deletes an answer', async () => {
    server = await createTestServer();
    const created = approvedAnswerSchema.parse(
      (await create(approvedAnswerBody())).json<{ data: unknown }>().data,
    );

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/answers/${created.id}`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { deleted: boolean } }>().data.deleted).toBe(true);
    expect((await listAnswers()).answers).toHaveLength(0);
  });
});

describe('answer count in /health', () => {
  it('reflects the library size for an authenticated caller', async () => {
    server = await createTestServer();
    await create(approvedAnswerBody());
    await create(approvedAnswerBody({ canonicalQuestion: 'Do you need sponsorship?' }));

    const health = healthResponseSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/health', headers: authHeaders })).json<{
        data: unknown;
      }>().data,
    );
    expect(health.approvedAnswerCount).toBe(2);
  });
});
