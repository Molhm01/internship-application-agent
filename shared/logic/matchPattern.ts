/**
 * Chrome extension match patterns, evaluated the way Chrome evaluates them.
 *
 * The manifest decides where the content script runs and where
 * `chrome.scripting.executeScript` is permitted. Getting that wrong is invisible
 * from the source — the extension simply does nothing on the page — so the
 * coverage is asserted in tests instead, and this is what those assertions run
 * against.
 *
 * Implements the documented subset: `<all_urls>`, a scheme, a host that may
 * carry a single leading `*.`, and a path glob. Deliberately strict about the
 * things that have bitten this project: `*.icims.com` matches
 * `careers2-quanta.icims.com` and `icims.com`, and does not match
 * `icims.com.attacker.example`.
 */

export function parseMatchPattern(pattern: string): {
  scheme: string;
  host: string;
  path: string;
} | null {
  if (pattern === '<all_urls>') return { scheme: '*', host: '*', path: '/*' };
  const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!match) return null;
  const [, scheme, host, path] = match;
  return { scheme: scheme!, host: host!, path: path! };
}

function hostMatches(patternHost: string, host: string): boolean {
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2).toLowerCase();
    const candidate = host.toLowerCase();
    // The dot is part of the comparison on purpose: without it,
    // `*.icims.com` would match `evilicims.com`.
    return candidate === suffix || candidate.endsWith(`.${suffix}`);
  }
  return patternHost.toLowerCase() === host.toLowerCase();
}

function pathMatches(patternPath: string, path: string): boolean {
  const expression = patternPath
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(path);
}

/** True when `url` falls inside `pattern`. */
export function matchesPattern(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const scheme = target.protocol.replace(/:$/, '');
  // Chrome's `*` scheme means http or https only — not file, not chrome.
  if (parsed.scheme === '*' ? scheme !== 'http' && scheme !== 'https' : parsed.scheme !== scheme) {
    return false;
  }
  if (!hostMatches(parsed.host, target.hostname)) return false;
  return pathMatches(parsed.path, `${target.pathname}${target.search}`);
}

/** True when any pattern in the list covers `url`. */
export function anyPatternMatches(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, url));
}

/**
 * Employer portals the extension must be able to reach.
 *
 * Not an allow-list — the content script runs on every http(s) page, because an
 * employer career portal can live on any domain the company owns. This is the
 * set the tests prove is covered, so a future narrowing of `host_permissions`
 * cannot silently drop the vendors that are known to matter.
 */
export const SUPPORTED_ATS_URLS: readonly string[] = [
  'https://careers2-quanta.icims.com/jobs/12345/login',
  'https://jobs-company.icims.com/jobs/1/candidate',
  'https://careers.icims.eu/jobs/2/apply',
  'https://company.wd5.myworkdayjobs.com/en-US/careers/job/Intern',
  'https://boards.greenhouse.io/company/jobs/123',
  'https://jobs.lever.co/company/abc-def',
  'https://jobs.ashbyhq.com/company/role',
  'https://jobs.smartrecruiters.com/Company/123-intern',
  'https://company.taleo.net/careersection/2/jobapply.ftl',
  'https://company.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/job/1',
  'https://career5.successfactors.eu/careers?company=x',
  'https://careers.example.com/apply',
];
