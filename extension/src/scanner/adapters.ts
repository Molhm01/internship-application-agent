import {
  ATS_DISPLAY_NAMES,
  type AdapterDetection,
  type AtsAdapter,
  type AtsId,
  type JobContext,
  type PageDetectionContext,
  type ScanContext,
  type ExecutionContext,
  type DeterministicFillAction,
  type DetectedField,
  type FillExecutionResult,
  type FillVerificationResult,
} from '@internship-agent/shared';
import { scanDom } from './domScanner.js';
import { extractJobContext } from './jobContext.js';
import { executeDomAction } from '../executor/domExecutor.js';
import { verifyDomAction } from '../verifier/domVerifier.js';

export interface BrowserScanContext extends ScanContext {
  document: Document;
  signal: AbortSignal;
  warnings: string[];
}

function browserContext(context: ScanContext): BrowserScanContext {
  if (!(context.document instanceof Document) || !(context.signal instanceof AbortSignal)) {
    throw new Error('Browser adapter received a non-browser scan context.');
  }
  return context as BrowserScanContext;
}

interface AdapterConfig {
  id: AtsId;
  priority: number;
  hosts?: RegExp;
  markers?: readonly string[];
  supported: boolean;
  selectors?: Parameters<typeof extractJobContext>[2];
}

class BrowserAdapter implements AtsAdapter {
  readonly id: AtsId;
  readonly displayName: string;
  readonly priority: number;

  constructor(private readonly config: AdapterConfig) {
    this.id = config.id;
    this.displayName = ATS_DISPLAY_NAMES[config.id];
    this.priority = config.priority;
  }

  detect(context: PageDetectionContext): AdapterDetection {
    const document = context.document instanceof Document ? context.document : null;
    const hostMatched = this.config.hosts?.test(context.hostname) ?? false;
    const markerMatched =
      document !== null &&
      (this.config.markers ?? []).some((selector) => document.querySelector(selector));
    const bodyMatched =
      this.id !== 'generic' &&
      new RegExp(`\\b${this.id.replace('successfactors', 'success factors')}\\b`, 'i').test(
        `${context.title} ${context.bodyText.slice(0, 4000)}`,
      );
    const matched =
      this.id === 'generic'
        ? Boolean(document?.querySelector('form, input, select, textarea, [role="combobox"]'))
        : hostMatched || markerMatched || bodyMatched;
    const confidence = hostMatched
      ? 0.98
      : markerMatched
        ? 0.9
        : bodyMatched
          ? 0.65
          : this.id === 'generic' && matched
            ? 0.25
            : 0;
    const reason = hostMatched
      ? `hostname ${context.hostname} matches ${this.displayName}`
      : markerMatched
        ? `${this.displayName} DOM markers were found`
        : bodyMatched
          ? `${this.displayName} branding was found in visible page text`
          : this.id === 'generic' && matched
            ? 'application-like HTML controls were found'
            : `no ${this.displayName} signals matched`;
    return { matched, confidence, reason, supported: this.config.supported };
  }

  async scan(context: ScanContext) {
    const browser = browserContext(context);
    if (!this.config.supported) {
      browser.warnings.push(
        `${this.displayName} has no dedicated Milestone 2 adapter; read-only generic scanning was used.`,
      );
    }
    const result = await scanDom(browser.document, browser.pageId, browser.signal);
    browser.warnings.push(...result.warnings);
    return result.fields;
  }

  extractJobContext(context: ScanContext): Promise<JobContext> {
    const browser = browserContext(context);
    return Promise.resolve(extractJobContext(browser.document, browser.url, this.config.selectors));
  }

  executeAction(
    context: ExecutionContext,
    field: DetectedField,
    action: DeterministicFillAction,
  ): Promise<FillExecutionResult> {
    if (!(context.document instanceof Document) || !(context.signal instanceof AbortSignal)) {
      throw new Error('Browser adapter received a non-browser execution context.');
    }
    return executeDomAction(context.document, field, action, context.signal);
  }

  verifyAction(
    context: ExecutionContext,
    field: DetectedField,
    action: DeterministicFillAction,
  ): Promise<FillVerificationResult> {
    if (!(context.document instanceof Document)) {
      throw new Error('Browser adapter received a non-browser verification context.');
    }
    return Promise.resolve(verifyDomAction(context.document, field, action));
  }
}

export const ATS_ADAPTERS: readonly AtsAdapter[] = [
  new BrowserAdapter({
    id: 'greenhouse',
    priority: 100,
    hosts: /(^|\.)((boards|job-boards)\.)?greenhouse\.io$/i,
    markers: ['#grnhse_app', '[data-mapped="true"]', '.greenhouse-job-board'],
    supported: true,
    selectors: {
      company: ['.company-name', '[class*="company-name"]'],
      jobTitle: ['h1.app-title', '.job__title h1', 'h1'],
      location: ['.location', '.job__location'],
      description: ['#content', '.job__description'],
    },
  }),
  new BrowserAdapter({
    id: 'lever',
    priority: 95,
    hosts: /(^|\.)jobs\.lever\.co$/i,
    markers: ['.lever-job', '.application-form', '[data-qa="job-location"]'],
    supported: true,
    selectors: {
      company: ['.main-header-logo img', '.company-name'],
      jobTitle: ['.posting-headline h2', 'h1'],
      location: ['.posting-categories .location', '[data-qa="job-location"]'],
      department: ['.posting-categories .department'],
      description: ['.posting-page .content', '.section-wrapper'],
    },
  }),
  new BrowserAdapter({
    id: 'workday',
    priority: 90,
    hosts: /(^|\.)myworkdayjobs\.com$/i,
    markers: ['[data-automation-id]', '[data-uxi-widget-type]'],
    supported: true,
    selectors: {
      company: ['[data-automation-id="company"]'],
      jobTitle: ['[data-automation-id="jobPostingHeader"] h2', 'h1'],
      location: ['[data-automation-id="locations"]'],
      description: ['[data-automation-id="jobPostingDescription"]'],
      requisitionId: ['[data-automation-id="requisitionId"]'],
    },
  }),
  new BrowserAdapter({
    id: 'ashby',
    priority: 80,
    hosts: /(^|\.)jobs\.ashbyhq\.com$/i,
    markers: ['[class*="ashby"]'],
    supported: false,
  }),
  new BrowserAdapter({
    id: 'icims',
    priority: 75,
    hosts: /(^|\.)icims\.com$/i,
    markers: ['[class*="iCIMS"]', '[id*="iCIMS"]'],
    supported: false,
  }),
  new BrowserAdapter({
    id: 'smartrecruiters',
    priority: 70,
    hosts: /(^|\.)smartrecruiters\.com$/i,
    markers: ['[class*="smartrecruiters"]'],
    supported: false,
  }),
  new BrowserAdapter({
    id: 'successfactors',
    priority: 65,
    hosts: /(^|\.)successfactors\.(com|eu)$/i,
    markers: ['[class*="successFactors"]', '[id*="successFactors"]'],
    supported: false,
  }),
  new BrowserAdapter({
    id: 'taleo',
    priority: 60,
    hosts: /(^|\.)taleo\.net$/i,
    markers: ['[id*="taleo"]', '[class*="taleo"]'],
    supported: false,
  }),
  new BrowserAdapter({
    id: 'generic',
    priority: 1,
    supported: true,
  }),
];

export interface SelectedAdapter {
  adapter: AtsAdapter;
  detection: AdapterDetection;
}

export function selectAdapter(context: PageDetectionContext): SelectedAdapter {
  const matches = ATS_ADAPTERS.map((adapter) => ({
    adapter,
    detection: adapter.detect(context),
  })).filter((entry) => entry.detection.matched);
  matches.sort(
    (left, right) =>
      right.detection.confidence - left.detection.confidence ||
      right.adapter.priority - left.adapter.priority,
  );
  const selected = matches[0];
  if (!selected) throw new Error('No ATS adapter recognized an application form.');
  return selected;
}
