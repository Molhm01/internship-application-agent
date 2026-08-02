import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AUTH_HEADER } from '@internship-agent/shared';
import { createLogger } from '../../agent-server/src/logging/logger.js';
import { openDatabase, type AgentDatabase } from '../../agent-server/src/database/db.js';
import { createOllamaClient } from '../../agent-server/src/ollama/client.js';
import { buildServer } from '../../agent-server/src/server.js';
import { createProfileRepository } from '../../agent-server/src/profile/repository.js';
import { createDocumentStorage } from '../../agent-server/src/documents/storage.js';
import { createDocumentRepository } from '../../agent-server/src/documents/repository.js';
import { createAnswerRepository } from '../../agent-server/src/answers/repository.js';
import type { RateLimiter } from '../../agent-server/src/security/rateLimit.js';
import { createExtractionRepository } from '../../agent-server/src/documents/extractionRepository.js';
import { createResumeExtractor } from '../../agent-server/src/documents/extractor.js';
import { createGenerationRepository } from '../../agent-server/src/ai/generationRepository.js';
import { createAiAnswerService } from '../../agent-server/src/ai/service.js';
import { createFormAnalysisService } from '../../agent-server/src/ai/formAnalysis.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

export const silentLogger = createLogger({ level: 'error', console: false });

/** Auth header every authenticated request in the suites uses. */
export const authHeaders = { [AUTH_HEADER]: TEST_TOKEN };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Stands in for a reachable Ollama daemon with two models installed. */
export function healthyOllamaFetch(): typeof fetch {
  return (input) => {
    const url = urlOf(input);
    if (url.endsWith('/api/version')) {
      return Promise.resolve(new Response(JSON.stringify({ version: '0.5.4' }), { status: 200 }));
    }
    if (url.endsWith('/api/tags')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              { name: 'llama3.1:8b', size: 4_700_000_000, details: { parameter_size: '8B' } },
              { name: 'qwen2.5:7b', size: 4_400_000_000 },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

/** Stands in for a daemon that is not running at all. */
export function unreachableOllamaFetch(): typeof fetch {
  return () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
}

export interface TestServer {
  app: FastifyInstance;
  /** Real directory backing document storage, so path checks are meaningful. */
  documentsDir: string;
  /** Exposed so tests can corrupt a row and assert the server reports it. */
  db: AgentDatabase;
  close: () => Promise<void>;
}

export async function createTestServer(
  options: {
    fetchImpl?: typeof fetch;
    rateLimiter?: RateLimiter;
    defaultModel?: string;
  } = {},
): Promise<TestServer> {
  const db = openDatabase(':memory:', silentLogger);
  const documentsDir = mkdtempSync(join(tmpdir(), 'agent-docs-'));
  const documentStorage = createDocumentStorage(documentsDir);

  const ollama = createOllamaClient({
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: options.defaultModel ?? 'llama3.1:8b',
    logger: silentLogger,
    fetchImpl: options.fetchImpl ?? healthyOllamaFetch(),
  });
  const profiles = createProfileRepository(db);
  const documents = createDocumentRepository(db, documentStorage);
  const answers = createAnswerRepository(db);
  const extractions = createExtractionRepository(db);
  const resumeExtractor = createResumeExtractor(extractions);
  const generations = createGenerationRepository(db);
  const aiAnswers = createAiAnswerService({
    ollama,
    profiles,
    documents,
    answers,
    extractions,
    extractor: resumeExtractor,
    generations,
    logger: silentLogger,
  });

  const app = await buildServer({
    context: {
      db,
      ollama,
      logger: silentLogger,
      token: TEST_TOKEN,
      startedAt: new Date().toISOString(),
      profiles,
      documentStorage,
      documents,
      answers,
      extractions,
      resumeExtractor,
      generations,
      aiAnswers,
      formAnalysis: createFormAnalysisService(ollama, silentLogger),
    },
    allowLocalOrigins: true,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
  });

  return {
    app,
    documentsDir,
    db,
    close: async () => {
      await app.close();
      db.close();
      rmSync(documentsDir, { recursive: true, force: true });
    },
  };
}

/** A minimal but genuinely valid PDF, so signature checks are exercised. */
export const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

export const PDF_BASE64 = PDF_BYTES.toString('base64');

export function documentUploadBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Computer Engineering Resume',
    type: 'resume',
    fileName: 'ce-resume.pdf',
    mimeType: 'application/pdf',
    contentBase64: PDF_BASE64,
    tags: ['ce'],
    targetRoles: ['Embedded Software Intern'],
    targetIndustries: ['Semiconductors'],
    isDefault: false,
    ...overrides,
  };
}

export function approvedAnswerBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    canonicalQuestion: 'Are you legally authorized to work in the United States?',
    aliases: ['Do you have US work authorization?'],
    answerType: 'boolean',
    answer: true,
    category: 'eligibility',
    approved: true,
    autoFillAllowed: true,
    sensitive: false,
    tailoringAllowed: false,
    requiresReview: false,
    ...overrides,
  };
}

/** A profile that satisfies every required completeness section. */
export function completeProfileBody(): Record<string, unknown> {
  return {
    personal: {
      legalFirstName: 'Jordan',
      legalLastName: 'Rivera',
      email: 'jordan@example.com',
      phone: '+1-555-0100',
      address: {
        line1: '1 Main Street',
        city: 'Boston',
        state: 'MA',
        postalCode: '02110',
        country: 'United States',
      },
      github: 'https://github.com/example',
    },
    education: [
      {
        id: 'edu-1',
        institution: 'Northeastern University',
        degree: 'BS',
        major: 'Computer Engineering',
        graduationDate: '2027-05',
      },
    ],
    experience: [
      {
        id: 'exp-1',
        employer: 'Example Labs',
        title: 'Hardware Engineering Intern',
        startDate: '2026-06',
      },
    ],
    skills: { technical: ['Verilog'], programmingLanguages: ['C'] },
    eligibility: {
      workAuthorization: 'US citizen',
      requiresFutureSponsorship: false,
      willingToRelocate: true,
      earliestStartDate: '2027-06-01',
    },
    preferences: {
      targetRoles: ['Embedded Software Intern'],
      preferredLocations: ['Boston, MA'],
    },
  };
}
