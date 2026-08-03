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

/**
 * Vendor-specific knowledge an adapter contributes. Every field is optional and
 * every one is a *hint*: nothing here can prevent a field from being scanned or
 * filled, and nothing here is required for an unknown form to work.
 */
export interface AdapterHints {
  /** Containers this vendor wraps one question in. */
  sectionSelectors?: readonly string[];
  /** Where this vendor puts its file inputs. */
  uploadSelectors?: readonly string[];
  /** Wording on a control that advances to the next step. */
  navigationText?: RegExp;
  /** Wording on a control that ends the application. */
  finalSubmitText?: RegExp;
  /** Same-origin frames this vendor renders its application inside. */
  iframeSelectors?: readonly string[];
  /** True when only the currently rendered step is ever present. */
  multiStep?: boolean;
  /**
   * True when this vendor puts a sign-in, a New User route or a guest route in
   * front of the application, so a page here is often not a form at all.
   */
  hasAccountFlow?: boolean;
}

const GENERIC_HINTS: AdapterHints = {
  sectionSelectors: ['fieldset', '.field', '.form-field'],
  uploadSelectors: ['input[type="file"]'],
  navigationText: /\b(next|continue)\b/i,
  finalSubmitText: /\b(submit|send application|complete application)\b/i,
};

interface AdapterConfig {
  id: AtsId;
  priority: number;
  hosts?: RegExp;
  markers?: readonly string[];
  supported: boolean;
  selectors?: Parameters<typeof extractJobContext>[2];
  hints?: AdapterHints;
}

class BrowserAdapter implements AtsAdapter {
  readonly id: AtsId;
  readonly displayName: string;
  readonly priority: number;
  readonly hints: AdapterHints;
  /**
   * Public because the popup detects the vendor from the hostname alone, with
   * no page to query — the situation where a user most needs to be told the
   * site *is* recognized.
   */
  readonly hosts: RegExp | undefined;

  constructor(private readonly config: AdapterConfig) {
    this.id = config.id;
    this.displayName = ATS_DISPLAY_NAMES[config.id];
    this.priority = config.priority;
    this.hints = config.hints ?? GENERIC_HINTS;
    this.hosts = config.hosts;
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
    return executeDomAction(
      context.document,
      field,
      action,
      context.signal,
      context.documentContents ?? [],
    );
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

/**
 * Adapters provide detection and hints. They never replace the generic
 * semantic engine: every one of them scans through the same `scanDom`, fills
 * through the same executor, and an employer form nobody recognizes still gets
 * the full treatment through `generic`.
 *
 * `supported: true` here means "we have vendor-specific knowledge", not "this
 * is the only way it works".
 */
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
    hints: {
      sectionSelectors: ['#application_form fieldset', '.field', '.application-question'],
      uploadSelectors: ['#resume_fieldset', '#cover_letter_fieldset', 'input[type="file"]'],
      navigationText: /\b(next|continue)\b/i,
      finalSubmitText: /\b(submit application|submit your application)\b/i,
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
    hints: {
      sectionSelectors: ['.application-question', '.application-additional', '.card'],
      uploadSelectors: ['input[name="resume"]', 'input[type="file"]'],
      navigationText: /\b(next|continue)\b/i,
      finalSubmitText: /\bsubmit application\b/i,
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
    hints: {
      sectionSelectors: [
        '[data-automation-id*="formField"]',
        '[data-automation-id="section"]',
        '[data-automation-id*="Section"]',
      ],
      uploadSelectors: [
        '[data-automation-id="file-upload-input-ref"]',
        '[data-automation-id*="resume"]',
        'input[type="file"]',
      ],
      navigationText: /\b(next|continue|save and continue)\b/i,
      finalSubmitText: /\b(submit|review and submit)\b/i,
      // Workday reveals one step at a time; only the rendered step is scanned.
      multiStep: true,
    },
  }),
  new BrowserAdapter({
    id: 'ashby',
    priority: 80,
    hosts: /(^|\.)jobs\.ashbyhq\.com$/i,
    markers: ['[class*="ashby"]', '[class*="_fieldEntry"]', '#root [class*="ashby-application"]'],
    supported: true,
    selectors: {
      company: ['[class*="companyName"]', 'header img[alt]'],
      jobTitle: ['h1', '[class*="jobTitle"]'],
      location: ['[class*="location"]'],
      description: ['[class*="jobDescription"]', '#overview'],
    },
    hints: {
      sectionSelectors: ['[class*="_fieldEntry"]', '[class*="fieldGroup"]'],
      uploadSelectors: ['input[type="file"]', '[class*="fileUpload"]'],
      navigationText: /\b(next|continue)\b/i,
      finalSubmitText: /\bsubmit application\b/i,
    },
  }),
  new BrowserAdapter({
    id: 'icims',
    priority: 75,
    // Every employer sits on a tenant subdomain — careers2-quanta.icims.com,
    // jobs-company.icims.com — never on the bare domain, so the leading
    // `(^|\.)` is what makes this work at all. `.eu` is the European tenant
    // domain and was missing entirely.
    hosts: /(^|\.)icims\.(com|eu)$/i,
    markers: ['[class*="iCIMS"]', '[id*="iCIMS"]', '#icims_content_iframe'],
    supported: true,
    selectors: {
      company: ['.iCIMS_Header img[alt]'],
      jobTitle: ['.iCIMS_Header h1', 'h1'],
      location: ['.iCIMS_JobHeaderField'],
      description: ['.iCIMS_JobContent'],
    },
    hints: {
      sectionSelectors: ['.iCIMS_InfoField', '.iCIMS_TableRow'],
      uploadSelectors: ['input[type="file"]', '[id*="resume"]'],
      navigationText: /\b(next|continue)\b/i,
      finalSubmitText: /\bsubmit\b/i,
      // iCIMS renders its application inside a same-origin frame.
      iframeSelectors: ['#icims_content_iframe', 'iframe[src*="icims"]'],
    },
  }),
  new BrowserAdapter({
    id: 'smartrecruiters',
    priority: 70,
    hosts: /(^|\.)smartrecruiters\.com$/i,
    markers: ['[class*="smartrecruiters"]', '[data-test*="application"]', '#st-app'],
    supported: true,
    selectors: {
      company: ['[data-test="company-name"]'],
      jobTitle: ['[data-test="job-title"]', 'h1'],
      location: ['[data-test="job-location"]'],
      description: ['[data-test="job-description"]'],
    },
    hints: {
      sectionSelectors: ['[data-test*="field"]', 'fieldset'],
      uploadSelectors: ['input[type="file"]', '[data-test*="resume"]'],
      navigationText: /\b(next|continue)\b/i,
      finalSubmitText: /\b(submit|i'?m interested)\b/i,
    },
  }),
  new BrowserAdapter({
    id: 'oracle',
    priority: 68,
    hosts: /(^|\.)oraclecloud\.com$/i,
    markers: ['[data-ofa]', '.job-details__apply', '#ORA_JOB_APPLY'],
    supported: true,
    selectors: {
      jobTitle: ['.job-details__title', 'h1'],
      location: ['.job-details__location'],
      description: ['.job-details__description-content'],
      requisitionId: ['.job-details__requisition-id'],
    },
    hints: {
      sectionSelectors: ['.apply-flow__section', '[data-ofa] fieldset'],
      uploadSelectors: ['input[type="file"]'],
      navigationText: /\b(continue|next)\b/i,
      finalSubmitText: /\bsubmit\b/i,
      multiStep: true,
    },
  }),
  new BrowserAdapter({
    id: 'successfactors',
    priority: 65,
    hosts: /(^|\.)(successfactors|sapsf)\.(com|eu)$/i,
    markers: ['[class*="successFactors"]', '[id*="successFactors"]', '#careerSiteApplication'],
    supported: true,
    selectors: {
      jobTitle: ['[data-careersite-propertyid="title"]', 'h1'],
      location: ['[data-careersite-propertyid="location"]'],
      description: ['[data-careersite-propertyid="jobdescription"]'],
    },
    hints: {
      sectionSelectors: ['.jobDetail', 'fieldset', '.formField'],
      uploadSelectors: ['input[type="file"]'],
      navigationText: /\b(next|continue)\b/i,
      finalSubmitText: /\bsubmit\b/i,
      multiStep: true,
    },
  }),
  new BrowserAdapter({
    id: 'taleo',
    priority: 60,
    hosts: /(^|\.)(taleo|taleocloud)\.net$/i,
    markers: [
      '[id*="taleo"]',
      '[class*="taleo"]',
      '#requisitionDescriptionInterface',
      '#careerSection',
      '[id^="careerSection"]',
      'form[name="dynamicForm"]',
    ],
    supported: true,
    selectors: {
      jobTitle: ['.titlepage', 'h1'],
      location: ['#requisitionDescriptionInterface\\.ID1200'],
      description: ['#requisitionDescriptionInterface'],
    },
    hints: {
      sectionSelectors: ['.editable-block', 'fieldset', '.pagination-block', '[id*="Block"]'],
      uploadSelectors: ['input[type="file"]', '[id*="fileUpload"]'],
      navigationText: /\b(next|save and continue|save and go back)\b/i,
      finalSubmitText: /\b(submit|finish)\b/i,
      multiStep: true,
      // Taleo puts a sign-in, a New User route and a guest route in front of
      // the application, so a page here is frequently not a form at all.
      hasAccountFlow: true,
    },
  }),
  new BrowserAdapter({
    id: 'generic',
    priority: 1,
    supported: true,
    hints: {
      sectionSelectors: ['fieldset', '.field', '.form-field'],
      uploadSelectors: ['input[type="file"]'],
      navigationText: /\b(next|continue)\b/i,
      finalSubmitText: /\b(submit|send application|complete application)\b/i,
    },
  }),
];

/** The hints for an adapter, or the generic ones when it has none. */
export function hintsFor(id: AtsId): AdapterHints {
  const found = ATS_ADAPTERS.find((adapter) => adapter.id === id);
  return (found as BrowserAdapter | undefined)?.hints ?? GENERIC_HINTS;
}

/**
 * True when a control ends the application rather than advancing it.
 *
 * Checked against the adapter's own wording first, then a vendor-neutral list,
 * so an unrecognized employer form still refuses to click Submit.
 */
export function isFinalSubmitControl(id: AtsId, text: string): boolean {
  const hints = hintsFor(id);
  const flattened = text.replace(/[-_+/]+/g, ' ').trim();
  if (hints.navigationText?.test(flattened) && !hints.finalSubmitText?.test(flattened)) {
    return false;
  }
  return (
    (hints.finalSubmitText?.test(flattened) ?? false) || UNIVERSAL_FINAL_SUBMIT.test(flattened)
  );
}

/**
 * Wording that ends an application on any form, whoever built it. This is the
 * backstop behind every adapter, not an alternative to them.
 */
const UNIVERSAL_FINAL_SUBMIT =
  /\b(submit application|submit your application|send application|complete application|finish (and )?submit|review and submit)\b/i;

/**
 * The ATS a hostname belongs to, without touching the page.
 *
 * The popup needs an answer even when it cannot reach the content script — the
 * case where the user most needs to know the site is recognized. Every branded
 * adapter is identified by its tenant domain, so the hostname alone is a
 * complete answer for them; `generic` is not returned here, because "some form
 * on some site" is not something a hostname can establish.
 */
export function detectAtsByHostname(hostname: string): {
  id: AtsId;
  displayName: string;
  confidence: number;
  reason: string;
} | null {
  for (const adapter of ATS_ADAPTERS) {
    if (!(adapter as BrowserAdapter).hosts?.test(hostname)) continue;
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      confidence: 0.98,
      reason: `hostname ${hostname} matches ${adapter.displayName}`,
    };
  }
  return null;
}

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
