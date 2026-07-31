import { describe, expect, it } from 'vitest';
import {
  readSessionIdFromUrl,
  withoutSessionFragment,
} from '../../extension/src/content/applicationSessionHandoff.js';

describe('application session URL handoff', () => {
  const sessionId = 'd69232c7-1e69-4b6f-a625-4611b32a9c96';

  it('reads the opaque session id and removes it from the URL', () => {
    const url = `https://jobs.lever.co/acme/123?source=pilot#internship-agent-session=${sessionId}`;
    expect(readSessionIdFromUrl(url)).toBe(sessionId);
    expect(withoutSessionFragment(url)).toBe('https://jobs.lever.co/acme/123?source=pilot');
  });

  it('preserves unrelated fragment parameters', () => {
    const url = `https://careers.acme.example/apply#step=profile&internship-agent-session=${sessionId}`;
    expect(withoutSessionFragment(url)).toBe(
      'https://careers.acme.example/apply#step=profile',
    );
  });

  it('rejects malformed or missing session identifiers', () => {
    expect(readSessionIdFromUrl('https://example.com/#internship-agent-session=short')).toBeNull();
    expect(readSessionIdFromUrl('https://example.com/')).toBeNull();
  });
});
