import { mkdirSync } from 'node:fs';
import { AUTH_HEADER } from '@internship-agent/shared';
import { config, SERVER_VERSION } from './config.js';
import { createLogger } from './logging/logger.js';
import { openDatabase } from './database/db.js';
import { createOllamaClient } from './ollama/client.js';
import { createProfileRepository } from './profile/repository.js';
import { createDocumentStorage } from './documents/storage.js';
import { createDocumentRepository } from './documents/repository.js';
import { createLatestDocumentRepository } from './documents/latestRepository.js';
import { createAnswerRepository } from './answers/repository.js';
import { loadOrCreateToken } from './security/token.js';
import { buildServer } from './server.js';
import type { ServerContext } from './types/context.js';
import { createExtractionRepository } from './documents/extractionRepository.js';
import { createResumeExtractor } from './documents/extractor.js';
import { createGenerationRepository } from './ai/generationRepository.js';
import { createAiAnswerService } from './ai/service.js';
import { createFormAnalysisService } from './ai/formAnalysis.js';

async function main(): Promise<void> {
  const logger = createLogger({ level: config.logLevel, logDir: config.logDir });

  for (const dir of [config.dataDir, config.logDir, config.documentsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const token = loadOrCreateToken(config.tokenPath);
  const db = openDatabase(config.databasePath, logger.child('database'));
  const ollama = createOllamaClient({
    baseUrl: config.ollamaUrl,
    defaultModel: config.defaultModel,
    logger: logger.child('ollama'),
  });

  const documentStorage = createDocumentStorage(config.documentsDir);
  const extractions = createExtractionRepository(db);
  const resumeExtractor = createResumeExtractor(extractions);
  const generations = createGenerationRepository(db);
  const profiles = createProfileRepository(db);
  const documents = createDocumentRepository(db, documentStorage);
  const latestDocuments = createLatestDocumentRepository(db, documentStorage);
  const answers = createAnswerRepository(db);
  const aiAnswers = createAiAnswerService({
    ollama,
    profiles,
    documents,
    answers,
    extractions,
    extractor: resumeExtractor,
    generations,
    logger: logger.child('ai'),
  });

  const context: ServerContext = {
    db,
    ollama,
    logger,
    token,
    startedAt: new Date().toISOString(),
    profiles,
    documentStorage,
    documents,
    latestDocuments,
    answers,
    extractions,
    resumeExtractor,
    generations,
    aiAnswers,
    formAnalysis: createFormAnalysisService(ollama, logger.child('form-analysis')),
  };

  const app = await buildServer({
    context,
    allowLocalOrigins: config.allowLocalOrigins,
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    void app.close().then(
      () => {
        db.close();
        process.exit(0);
      },
      (cause: unknown) => {
        logger.error('shutdown failed', { error: cause });
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });

  const status = await ollama.checkStatus();
  logger.info('agent server listening', {
    url: `http://${config.host}:${config.port}`,
    version: SERVER_VERSION,
    ollama: status.state,
    ollamaModels: status.modelCount ?? 0,
  });

  // Never print the token: terminal output is commonly redirected to logs.
  process.stdout.write(
    [
      '',
      '  Internship Application Agent — local server',
      `  URL:    http://${config.host}:${config.port}`,
      `  Ollama: ${status.state}${status.error ? ` (${status.error.message})` : ''}`,
      `  Token header: ${AUTH_HEADER}`,
      `  Token source: INTERNSHIP_AGENT_TOKEN or ${config.tokenPath}`,
      `  Database:  ${config.databasePath}`,
      `  Documents: ${config.documentsDir}`,
      '',
    ].join('\n'),
  );
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      scope: 'agent-server',
      message: 'failed to start',
      error:
        cause instanceof Error ? { message: cause.message, stack: cause.stack } : String(cause),
    })}\n`,
  );
  process.exit(1);
});
