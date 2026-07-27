import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import {
  DEFAULT_ERROR_GUIDANCE,
  documentExtractionSchema,
  type DocumentExtraction,
  type SavedDocument,
} from '@internship-agent/shared';
import type { ExtractionRepository } from './extractionRepository.js';

const SECTION_NAMES = new Map<string, DocumentExtraction['sections'][number]['name']>([
  ['summary', 'summary'],
  ['profile', 'summary'],
  ['education', 'education'],
  ['experience', 'experience'],
  ['work experience', 'experience'],
  ['employment', 'experience'],
  ['projects', 'projects'],
  ['skills', 'skills'],
  ['technical skills', 'skills'],
  ['activities', 'activities'],
  ['leadership', 'activities'],
  ['volunteering', 'activities'],
]);

function normalizeText(text: string): string {
  return text
    .split(String.fromCharCode(0))
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 200_000);
}

function identifySections(text: string): DocumentExtraction['sections'] {
  const sections: DocumentExtraction['sections'] = [];
  let name: DocumentExtraction['sections'][number]['name'] = 'other';
  let lines: string[] = [];
  const flush = (): void => {
    const sectionText = lines.join('\n').trim();
    if (sectionText) sections.push({ name, text: sectionText.slice(0, 50_000) });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const clean = line.trim().replace(/:$/, '').toLowerCase();
    const next = SECTION_NAMES.get(clean);
    if (next && line.trim().length <= 40) {
      flush();
      name = next;
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections.slice(0, 100);
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
  });
  const document = await task.promise;
  const pages: string[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .filter((item): item is typeof item & { str: string } => 'str' in item)
        .map((item) => item.str)
        .join(' '),
    );
  }
  await task.destroy();
  return pages.join('\n\n');
}

async function extractRaw(document: SavedDocument, buffer: Buffer): Promise<string> {
  if (document.mimeType === 'text/plain') return buffer.toString('utf8');
  if (
    document.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (document.mimeType === 'application/pdf') return extractPdf(buffer);
  throw new Error(`Resume extraction does not support ${document.mimeType}.`);
}

export interface ResumeExtractor {
  extract(document: SavedDocument): Promise<DocumentExtraction>;
}

export function createResumeExtractor(repository: ExtractionRepository): ResumeExtractor {
  return {
    async extract(document) {
      repository.save({
        documentId: document.id,
        status: 'extracting',
        normalizedText: '',
        sections: [],
      });
      try {
        if (
          ![
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
          ].includes(document.mimeType)
        ) {
          return repository.save({
            documentId: document.id,
            status: 'unsupported',
            normalizedText: '',
            sections: [],
            error: {
              code: 'RESUME_EXTRACTION_FAILED',
              message: `Local extraction does not support ${document.mimeType}.`,
              recoverable: true,
              suggestedAction: DEFAULT_ERROR_GUIDANCE.RESUME_EXTRACTION_FAILED,
              debugContext: { mimeType: document.mimeType },
            },
          });
        }
        const buffer = await readFile(document.filePath);
        const normalizedText = normalizeText(await extractRaw(document, buffer));
        if (!normalizedText) throw new Error('No readable resume text was found.');
        return repository.save(
          documentExtractionSchema.parse({
            documentId: document.id,
            status: 'completed',
            normalizedText,
            sections: identifySections(normalizedText),
            contentHash: createHash('sha256').update(buffer).digest('hex'),
            extractedAt: new Date().toISOString(),
          }),
        );
      } catch (cause) {
        return repository.save({
          documentId: document.id,
          status: 'failed',
          normalizedText: '',
          sections: [],
          extractedAt: new Date().toISOString(),
          error: {
            code: 'RESUME_EXTRACTION_FAILED',
            message: `Could not extract resume text: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            recoverable: true,
            suggestedAction: DEFAULT_ERROR_GUIDANCE.RESUME_EXTRACTION_FAILED,
            debugContext: { documentId: document.id, mimeType: document.mimeType },
          },
        });
      }
    },
  };
}
