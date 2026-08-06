import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The marker is applied centrally, and this is what keeps it that way.
 *
 * Content scripts are the only extension code that renders into an employer's
 * page, so they are the only place a node can be created without the
 * `data-internship-agent-owned` claim and end up scanned as an application
 * question. "Enable AI Autofill" was reported as something the employer asked
 * for exactly that reason.
 *
 * A future badge, review card, or affordance built with a bare
 * `document.createElement` fails here rather than in a user's scan.
 */

const CONTENT_DIR = resolve(import.meta.dirname, '..', '..', 'extension', 'src', 'content');

/** The one module allowed to call `createElement`, because it marks the result. */
const OWNER_MODULE = 'ownedDom.ts';

describe('extension DOM rendered into an employer page is marked centrally', () => {
  const modules = readdirSync(CONTENT_DIR).filter((name) => name.endsWith('.ts'));

  it('finds the content modules it is meant to guard', () => {
    expect(modules).toContain(OWNER_MODULE);
    expect(modules.length).toBeGreaterThan(1);
  });

  it.each(modules.filter((name) => name !== OWNER_MODULE))(
    '%s creates no unmarked element',
    (name) => {
      const source = readFileSync(resolve(CONTENT_DIR, name), 'utf8');
      const offenders = [...source.matchAll(/\bcreateElement(NS)?\s*\(/g)];
      expect(
        offenders,
        `${name} must build page DOM through createOwnedElement in ${OWNER_MODULE}`,
      ).toEqual([]);
    },
  );

  it('the owner module marks everything it creates', () => {
    const source = readFileSync(resolve(CONTENT_DIR, OWNER_MODULE), 'utf8');
    expect(source).toContain('markExtensionOwned');
    // One creation site, so there is no path through this module that skips it.
    expect([...source.matchAll(/\bcreateElement\s*\(/g)]).toHaveLength(1);
  });
});
