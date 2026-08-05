import { describe, expect, it } from 'vitest';
import {
  BUILD_MISMATCH_MESSAGE,
  DEFAULT_ERROR_GUIDANCE,
  ERROR_CODES,
  RUNTIME_SCHEMA_VERSION,
  compareBuilds,
} from '@internship-agent/shared';
import { BUILD_ID, BUILD_INFO } from '../../extension/src/generated/buildInfo.js';

/**
 * The failure these pin: `extension/dist` was built from `4e16cea` while the
 * source and its green test suite were at `bbe99dc`, two commits later. Chrome
 * ran code that still had every reported bug, and nothing anywhere could say so
 * — `BUILD_INFO` reached only the popup, and the two components that actually
 * scan and fill carried no identity at all.
 */

describe('the build stamp identifies this build', () => {
  it('carries a commit, a schema generation, and a timestamp', () => {
    expect(BUILD_ID).toMatch(/^[0-9a-f]{7,40}(\+dirty)?\.s\d+\.\d{14}$/);
  });

  it('stamps the schema version the source declares', () => {
    expect(BUILD_INFO.schemaVersion).toBe(RUNTIME_SCHEMA_VERSION);
    expect(BUILD_ID).toContain(`.s${RUNTIME_SCHEMA_VERSION}.`);
  });

  it('says so when it was built from a modified tree', () => {
    // Not an assertion about which state we are in — an assertion that the two
    // states are distinguishable, which is the whole point of the marker.
    expect(BUILD_ID.includes('+dirty')).toBe(BUILD_INFO.dirty);
  });
});

describe('components from different builds are refused', () => {
  const build = (id: string) => id;

  it('agrees when all three report the same id', () => {
    const result = compareBuilds([
      { component: 'popup', buildId: build('abc1234.s1.20260101000000') },
      { component: 'worker', buildId: build('abc1234.s1.20260101000000') },
      { component: 'content', buildId: build('abc1234.s1.20260101000000') },
    ]);
    expect(result.agreed).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it('refuses when the content script is from an older build', () => {
    // Exactly the observed failure: the popup and worker were replaced by an
    // extension reload, and the already-open tab kept the previous script.
    const result = compareBuilds([
      { component: 'popup', buildId: 'bbe99dc.s3.20260805000000' },
      { component: 'worker', buildId: 'bbe99dc.s3.20260805000000' },
      { component: 'content', buildId: '4e16cea.s3.20260804000000' },
    ]);
    expect(result.agreed).toBe(false);
    expect(result.message).toBe(BUILD_MISMATCH_MESSAGE);
  });

  it('refuses a component that reports no build id at all', () => {
    // An unstamped bundle necessarily predates stamping, so "missing" is a
    // mismatch rather than an unknown.
    const result = compareBuilds([
      { component: 'worker', buildId: 'bbe99dc.s3.20260805000000' },
      { component: 'content', buildId: undefined },
    ]);
    expect(result.agreed).toBe(false);
    expect(result.message).toBe(BUILD_MISMATCH_MESSAGE);
  });

  it('refuses when nothing is stamped, rather than calling that agreement', () => {
    const result = compareBuilds([
      { component: 'worker', buildId: undefined },
      { component: 'content', buildId: undefined },
    ]);
    expect(result.agreed).toBe(false);
  });

  it('names one remedy, and it is the one that works', () => {
    expect(BUILD_MISMATCH_MESSAGE).toMatch(/reload the extension and this page/i);
  });
});

describe('the mismatch is a first-class error', () => {
  it('has its own code, distinct from a silent worker', () => {
    expect(ERROR_CODES).toContain('BUILD_MISMATCH');
    expect(ERROR_CODES).toContain('EXTENSION_RELOAD_REQUIRED');
  });

  it('has fallback guidance, like every other code', () => {
    expect(DEFAULT_ERROR_GUIDANCE.BUILD_MISMATCH).toMatch(/reload/i);
  });
});
