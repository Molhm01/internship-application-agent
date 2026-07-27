import { jobContextSchema, type JobContext } from '@internship-agent/shared';

function clean(value: string | null | undefined): string | undefined {
  const result = (value ?? '').replace(/\s+/g, ' ').trim();
  return result || undefined;
}

function firstText(document: Document, selectors: readonly string[]): string | undefined {
  for (const selector of selectors) {
    const value = clean(document.querySelector(selector)?.textContent);
    if (value) return value;
  }
  return undefined;
}

function meta(document: Document, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = clean(
      document
        .querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)
        ?.getAttribute('content'),
    );
    if (value) return value;
  }
  return undefined;
}

function jobPosting(document: Document): Record<string, unknown> | undefined {
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]',
  )) {
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? '');
      const entries: unknown[] = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        if (record['@type'] === 'JobPosting') return record;
        const graph = record['@graph'];
        if (Array.isArray(graph)) {
          const match: unknown = (graph as unknown[]).find(
            (item) =>
              item &&
              typeof item === 'object' &&
              (item as Record<string, unknown>)['@type'] === 'JobPosting',
          );
          if (match && typeof match === 'object') return match as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed third-party JSON-LD is ignored; DOM extraction continues.
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? clean(value) : undefined;
}

function organizationName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return stringValue((value as Record<string, unknown>)['name']);
}

function locationValue(value: unknown): string | undefined {
  const first: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (!first || typeof first !== 'object') return stringValue(first);
  const address = (first as Record<string, unknown>)['address'];
  if (!address || typeof address !== 'object')
    return stringValue((first as Record<string, unknown>)['name']);
  const record = address as Record<string, unknown>;
  return (
    [
      stringValue(record['addressLocality']),
      stringValue(record['addressRegion']),
      stringValue(record['addressCountry']),
    ]
      .filter(Boolean)
      .join(', ') || undefined
  );
}

export function extractJobContext(
  document: Document,
  sourceUrl: string,
  selectors: Partial<Record<keyof JobContext, readonly string[]>> = {},
): JobContext {
  const structured = jobPosting(document);
  const context: JobContext = {
    sourceUrl,
    company:
      organizationName(structured?.['hiringOrganization']) ??
      firstText(document, selectors.company ?? []) ??
      meta(document, ['og:site_name', 'application-name']),
    jobTitle:
      stringValue(structured?.['title']) ??
      firstText(document, selectors.jobTitle ?? ['h1']) ??
      meta(document, ['og:title']),
    location:
      locationValue(structured?.['jobLocation']) ??
      firstText(
        document,
        selectors.location ?? ['[class*="location"]', '[data-automation-id="locations"]'],
      ),
    department: firstText(document, selectors.department ?? ['[class*="department"]']),
    employmentType:
      stringValue(structured?.['employmentType']) ??
      firstText(document, selectors.employmentType ?? ['[class*="employment-type"]']),
    description:
      stringValue(structured?.['description']) ??
      firstText(
        document,
        selectors.description ?? [
          '[class*="job-description"]',
          '[data-automation-id="jobPostingDescription"]',
        ],
      ) ??
      meta(document, ['description', 'og:description']),
    salary: firstText(
      document,
      selectors.salary ?? ['[class*="salary"]', '[data-automation-id*="salary"]'],
    ),
    applicationId: firstText(document, selectors.applicationId ?? ['[data-application-id]']),
    requisitionId: firstText(
      document,
      selectors.requisitionId ?? ['[data-automation-id="requisitionId"]', '[class*="requisition"]'],
    ),
  };
  return jobContextSchema.parse(
    Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)),
  );
}
