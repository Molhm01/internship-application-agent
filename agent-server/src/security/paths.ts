import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/**
 * Reduces a user-supplied filename to something that cannot escape a directory
 * or collide with a Windows device name.
 *
 * Only the basename survives, so `../../etc/passwd` becomes `passwd` and
 * `C:\Windows\system32\x.dll` becomes `x.dll`. The caller still combines the
 * result with a generated id, so two uploads never overwrite each other.
 */
export function sanitizeFileName(input: string): string {
  // Strip any directory component from both POSIX and Windows separators.
  const base = input.split(/[/\\]/).pop() ?? '';

  const cleaned = base
    // Control characters and the characters Windows forbids in filenames.
    // eslint-disable-next-line no-control-regex -- deliberately matching C0 controls
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently drops trailing dots and spaces; do it explicitly.
    .replace(/[. ]+$/, '');

  const { name, ext } = parse(cleaned);

  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 are reserved device names on Windows.
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const safeName = name.length === 0 || reserved.test(name) ? 'document' : name;

  const safeExt = /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext.toLowerCase() : '';

  return `${safeName.slice(0, 120)}${safeExt}`;
}

export class PathOutsideRootError extends Error {
  constructor(
    readonly attemptedPath: string,
    readonly root: string,
  ) {
    super('Resolved path is outside the permitted directory');
    this.name = 'PathOutsideRootError';
  }
}

/**
 * Resolves `candidate` and proves it lands inside `root`, throwing otherwise.
 *
 * Every filesystem read or write in this server goes through here. The string
 * comparison is done on resolved paths with a trailing separator, so a sibling
 * directory such as `local-data/documents-evil` cannot pass as
 * `local-data/documents`.
 */
export function resolveInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(resolvedRoot, candidate);

  const relation = relative(resolvedRoot, resolved);
  const escapes =
    relation === '' ||
    relation.startsWith('..') ||
    relation.split(sep).includes('..') ||
    isAbsolute(relation);

  if (escapes) {
    throw new PathOutsideRootError(candidate, resolvedRoot);
  }

  return resolved;
}

/** Builds the on-disk name for a stored document: id first, so it is unique. */
export function documentFileName(documentId: string, originalName: string): string {
  return `${documentId}-${sanitizeFileName(originalName)}`;
}

/** Convenience wrapper for the common "join then verify" case. */
export function documentPath(documentsDir: string, fileName: string): string {
  return resolveInsideRoot(documentsDir, join(fileName));
}
