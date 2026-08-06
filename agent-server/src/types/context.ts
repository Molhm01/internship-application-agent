import type { AgentDatabase } from '../database/db.js';
import type { Logger } from '../logging/logger.js';
import type { OllamaClient } from '../ollama/client.js';
import type { ProfileRepository } from '../profile/repository.js';
import type { DocumentRepository } from '../documents/repository.js';
import type { LatestDocumentRepository } from '../documents/latestRepository.js';
import type { DocumentStorage } from '../documents/storage.js';
import type { AnswerRepository } from '../answers/repository.js';
import type { ExtractionRepository } from '../documents/extractionRepository.js';
import type { ResumeExtractor } from '../documents/extractor.js';
import type { GenerationRepository } from '../ai/generationRepository.js';
import type { AiAnswerService } from '../ai/service.js';
import type { FormAnalysisService } from '../ai/formAnalysis.js';

export interface ServerContext {
  readonly db: AgentDatabase;
  readonly ollama: OllamaClient;
  readonly logger: Logger;
  readonly startedAt: string;
  readonly token: string;
  readonly profiles: ProfileRepository;
  readonly documents: DocumentRepository;
  /** The newest tailored résumé and cover letter delivered by Internship Pilot. */
  readonly latestDocuments: LatestDocumentRepository;
  readonly documentStorage: DocumentStorage;
  readonly answers: AnswerRepository;
  readonly extractions: ExtractionRepository;
  readonly resumeExtractor: ResumeExtractor;
  readonly generations: GenerationRepository;
  readonly aiAnswers: AiAnswerService;
  /** Batched, page-level question analysis. One request per page, never per field. */
  readonly formAnalysis: FormAnalysisService;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every request, including unauthenticated routes. */
    isAuthenticated: boolean;
  }
}
