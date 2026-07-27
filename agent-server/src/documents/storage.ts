import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  LIMITS,
  type AllowedDocumentMimeType,
} from '@internship-agent/shared';
import { documentFileName, resolveInsideRoot } from '../security/paths.js';

export class DocumentTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Document is ${sizeBytes} bytes, over the ${limitBytes} byte limit`);
    this.name = 'DocumentTooLargeError';
  }
}

export class DocumentContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentContentError';
  }
}

export interface StoredFile {
  absolutePath: string;
  fileName: string;
  sizeBytes: number;
}

export interface DocumentStorage {
  readonly root: string;
  write(
    documentId: string,
    originalName: string,
    contentBase64: string,
    mimeType: AllowedDocumentMimeType,
  ): StoredFile;
  /** Returns false when the row existed but the file was already gone. */
  remove(fileName: string): boolean;
  exists(fileName: string): boolean;
  read(fileName: string): Buffer;
}

/** Magic-byte prefixes for the formats where a cheap check is meaningful. */
const SIGNATURES: Partial<Record<AllowedDocumentMimeType, readonly number[][]>> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    [0x50, 0x4b, 0x03, 0x04], // ZIP container
  ],
  'application/msword': [[0xd0, 0xcf, 0x11, 0xe0]], // OLE2
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
};

function matchesSignature(buffer: Buffer, mimeType: AllowedDocumentMimeType): boolean {
  const candidates = SIGNATURES[mimeType];
  if (!candidates) return true; // Text formats have no reliable signature.
  return candidates.some((signature) => signature.every((byte, index) => buffer[index] === byte));
}

/**
 * Every document write in this server happens here, and every path is proven to
 * resolve inside `root` first. Callers never supply a path — only a filename that
 * this module sanitizes and prefixes with the document id.
 */
export function createDocumentStorage(root: string): DocumentStorage {
  mkdirSync(root, { recursive: true });

  return {
    root,

    write(documentId, originalName, contentBase64, mimeType): StoredFile {
      const normalized = contentBase64.replace(/\s/g, '');

      let buffer: Buffer;
      try {
        buffer = Buffer.from(normalized, 'base64');
      } catch (cause) {
        throw new DocumentContentError(
          `Could not decode base64 content: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      if (buffer.byteLength === 0) {
        throw new DocumentContentError('Decoded document is empty.');
      }
      if (buffer.byteLength > LIMITS.maxDocumentBytes) {
        throw new DocumentTooLargeError(buffer.byteLength, LIMITS.maxDocumentBytes);
      }

      // Reject a file whose bytes contradict its declared type, so a renamed
      // executable cannot be filed as a resume.
      if (!matchesSignature(buffer, mimeType)) {
        throw new DocumentContentError(
          `File contents do not look like ${mimeType}. Check that the file is not renamed or corrupt.`,
        );
      }

      const expectedExtensions = ALLOWED_DOCUMENT_MIME_TYPES[mimeType];
      const fileName = documentFileName(documentId, originalName);
      const extension = fileName.includes('.')
        ? fileName.split('.').pop()?.toLowerCase()
        : undefined;
      if (extension && !(expectedExtensions as readonly string[]).includes(extension)) {
        throw new DocumentContentError(
          `Extension ".${extension}" does not match ${mimeType}. Expected one of: ${expectedExtensions.join(', ')}.`,
        );
      }

      const absolutePath = resolveInsideRoot(root, fileName);
      writeFileSync(absolutePath, buffer, { mode: 0o600 });

      return { absolutePath, fileName, sizeBytes: buffer.byteLength };
    },

    remove(fileName): boolean {
      const absolutePath = resolveInsideRoot(root, fileName);
      try {
        unlinkSync(absolutePath);
        return true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw cause;
      }
    },

    exists(fileName): boolean {
      try {
        return statSync(resolveInsideRoot(root, fileName)).isFile();
      } catch {
        return false;
      }
    },

    read(fileName): Buffer {
      return readFileSync(resolveInsideRoot(root, fileName));
    },
  };
}
