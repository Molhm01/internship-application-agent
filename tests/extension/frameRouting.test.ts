import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachAcrossFrames } from '../../extension/src/background/attachAcrossFrames.js';
import { mergeFrameScans } from '../../extension/src/background/mergeFrameScans.js';
import type { FrameTarget } from '../../extension/src/background/frames.js';

/**
 * Frame identity, from injection through discovery to execution.
 *
 * The shipped defect was not that frames were scanned badly — it was that they
 * did not exist as a concept anywhere in the extension. The manifest injected
 * into the main frame only, and every message was a whole-tab broadcast that
 * resolved with whichever frame answered first. These tests hold both halves in
 * place: a field remembers its frame, and an instruction goes back to that
 * frame and no other.
 */

const MANIFEST = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', '..', 'extension', 'manifest.json'), 'utf8'),
) as {
  content_scripts: Array<{
    matches: string[];
    js: string[];
    all_frames: boolean;
    match_about_blank?: boolean;
  }>;
  permissions: string[];
};

describe('manifest frame injection', () => {
  it('injects the content script into every frame', () => {
    const [entry] = MANIFEST.content_scripts;
    expect(entry).toBeDefined();
    // The single line that made an upload widget in an iframe invisible.
    expect(entry!.all_frames).toBe(true);
    expect(entry!.match_about_blank).toBe(true);
    expect(entry!.js).toContain('content.js');
  });

  it('keeps the scripting permission that frame discovery depends on', () => {
    // Frame enumeration *is* injection: `executeScript({ allFrames: true })`
    // reports one result per frame it reached, each carrying its frame id. No
    // additional permission is introduced for it.
    expect(MANIFEST.permissions).toContain('scripting');
    expect(MANIFEST.permissions).not.toContain('debugger');
    expect(MANIFEST.permissions).not.toContain('webNavigation');
  });
});

function scan(url: string, fieldIds: string[]) {
  return {
    id: 'scan-1',
    createdAt: new Date().toISOString(),
    url,
    domain: new URL(url).hostname,
    ats: {
      id: 'generic',
      displayName: 'Generic',
      confidence: 0.5,
      detectionReason: 'fixture',
      supported: true,
    },
    jobContext: {},
    fields: fieldIds.map((id) => ({
      id,
      pageId: 'page-1',
      label: id,
      normalizedLabel: id,
      question: id,
      fieldType: 'text' as const,
      selector: `#${id}`,
      required: false,
      visible: true,
      disabled: false,
      confidence: 0.9,
      sourceSignals: [],
      warnings: [],
      metadata: {},
    })),
    warnings: [],
    statistics: {
      total: fieldIds.length,
      supported: fieldIds.length,
      unknown: 0,
      required: 0,
      optional: fieldIds.length,
      text: fieldIds.length,
      textarea: 0,
      select: 0,
      combobox: 0,
      radio: 0,
      checkbox: 0,
      file: 0,
      credentialFields: 0,
      navigationActions: 0,
      bySection: {},
    },
    durationMs: 10,
    status: 'completed' as const,
    readOnly: true as const,
  };
}

describe('merging scans across frames', () => {
  const top: FrameTarget = { frameId: 0, url: 'https://jobs.example.com/apply', topFrame: true };
  const child: FrameTarget = {
    frameId: 7,
    url: 'https://widget.example.net/upload',
    topFrame: false,
  };

  it('keeps every field and stamps it with the frame it came from', () => {
    const merged = mergeFrameScans([
      { frame: top, result: scan(top.url, ['field-1', 'field-2']) as never },
      { frame: child, result: scan(child.url, ['field-1']) as never },
    ]);

    expect(merged).not.toBeNull();
    expect(merged!.fields).toHaveLength(3);
    // Two frames minting `field-1` is not hypothetical — ids are positional —
    // and the executor resolves an action by field id, so a collision fills the
    // wrong control.
    expect(new Set(merged!.fields.map((field) => field.id)).size).toBe(3);
    expect(merged!.fields.filter((field) => field.frameId === 7)).toHaveLength(1);
    expect(merged!.fields.find((field) => field.frameId === 7)!.frameUrl).toBe(child.url);
  });

  it('takes its identity from the main frame, not from a subframe', () => {
    const merged = mergeFrameScans([
      { frame: child, result: scan(child.url, ['a']) as never },
      { frame: top, result: scan(top.url, ['b']) as never },
    ]);

    // A plan is validated against `scan.url`, and a subframe's URL would make
    // the plan unrunnable against the page the user is looking at.
    expect(merged!.url).toBe(top.url);
    expect(merged!.domain).toBe('jobs.example.com');
  });

  /**
   * A field the parent's scan reached into a child document to find.
   *
   * The content script walks into every same-origin iframe it can reach, so the
   * top frame legitimately reports controls belonging to a child. The child's
   * own content script reports the same controls, correctly routed — and keeping
   * both put two questions on the review screen for one `<input>` and sent the
   * first write to a document that does not contain it.
   */
  function borrowed(url: string, ids: string[], sourceUrl: string) {
    const result = scan(url, ids);
    for (const field of result.fields) {
      (field.metadata as Record<string, unknown>).frameUrl = sourceUrl;
    }
    return result;
  }

  it('drops a control the parent reached into a child frame to find', () => {
    const merged = mergeFrameScans([
      {
        frame: top,
        result: {
          ...scan(top.url, ['own']),
          fields: [
            ...scan(top.url, ['own']).fields,
            ...borrowed(top.url, ['shared'], child.url).fields,
          ],
        } as never,
      },
      { frame: child, result: borrowed(child.url, ['shared'], child.url) as never },
    ]);

    // One control, one field, routed to the frame that actually holds it.
    expect(merged!.fields).toHaveLength(2);
    const shared = merged!.fields.filter((field) => field.selector === '#shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]!.frameId).toBe(7);
    // Dropped, and said so: the census is what tells a person the scan saw more
    // controls than the page has questions.
    expect(merged!.statistics.duplicateControlsRemoved).toBe(1);
    expect(merged!.statistics.total).toBe(2);
  });

  it('keeps the parent’s copy when the frame that owns it was never scanned', () => {
    const merged = mergeFrameScans([
      { frame: top, result: borrowed(top.url, ['orphan'], child.url) as never },
    ]);
    // A field routed imperfectly beats a control nobody knows about.
    expect(merged!.fields).toHaveLength(1);
    expect(merged!.fields[0]!.frameId).toBe(0);
    expect(merged!.statistics.duplicateControlsRemoved).toBe(0);
  });

  it('still produces a scan when the form is entirely inside an iframe', () => {
    const merged = mergeFrameScans([
      { frame: child, result: scan(child.url, ['a', 'b']) as never },
    ]);
    expect(merged!.fields).toHaveLength(2);
  });
});

interface SentMessage {
  frameId: number;
  message: Record<string, unknown>;
}

/**
 * A tab whose frames each hold their own upload controls, and which records
 * exactly which frame every message was addressed to.
 */
function fakeTab(surveys: Record<number, unknown>): {
  sent: SentMessage[];
  install: () => void;
} {
  const sent: SentMessage[] = [];
  const install = (): void => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: {
        sendMessage: (
          _tabId: number,
          message: Record<string, unknown>,
          options?: { frameId?: number },
        ) => {
          const frameId = options?.frameId;
          // The assertion that matters most: nothing on this path may broadcast.
          if (frameId === undefined) throw new Error('message sent without a frameId');
          sent.push({ frameId, message });
          if (message.type === 'DISCOVER_UPLOAD_CONTROLS') {
            return Promise.resolve(surveys[frameId] ?? null);
          }
          return Promise.resolve({
            type: 'ATTACH_CONTROL_RESULT',
            runId: String(message.runId),
            attached: true,
            verified: true,
            failureCode: null,
            message: null,
          });
        },
      },
    };
  };
  return { sent, install };
}

function survey(frameId: number, controls: Array<Record<string, unknown>>): unknown {
  return {
    type: 'UPLOAD_CONTROLS',
    runId: 'run-1',
    survey: {
      frameId: 0,
      frameUrl: `https://frame-${frameId}.example.com/`,
      frameOrigin: `https://frame-${frameId}.example.com`,
      topFrame: frameId === 0,
      fileInputs: controls.length,
      hiddenFileInputs: 0,
      uploadLaunchers: controls.length,
      cloudLaunchers: 2,
      controls: controls.map((control) => ({
        controlId: String(control.controlId),
        frameId: 0,
        frameUrl: `https://frame-${frameId}.example.com/`,
        frameOrigin: `https://frame-${frameId}.example.com`,
        kind: control.kind,
        discovery: control.discovery ?? 'existing_input',
        accessible: control.accessible ?? true,
        hidden: false,
      })),
    },
  };
}

const documents = [
  {
    documentType: 'resume' as const,
    filename: 'Resume.pdf',
    mimeType: 'application/pdf' as const,
    byteLength: 4,
    source: 'tailored' as const,
    contentBase64: 'AAAA',
  },
  {
    documentType: 'cover_letter' as const,
    filename: 'Cover.pdf',
    mimeType: 'application/pdf' as const,
    byteLength: 4,
    source: 'tailored' as const,
    contentBase64: 'AAAA',
  },
];

const frames: FrameTarget[] = [
  { frameId: 0, url: 'https://frame-0.example.com/', topFrame: true },
  { frameId: 3, url: 'https://frame-3.example.com/', topFrame: false },
];

describe('attaching across frames', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends each document to the exact frame that offered its control', async () => {
    const tab = fakeTab({
      0: survey(0, [{ controlId: 'c-resume', kind: 'resume', discovery: 'launcher_activated' }]),
      3: survey(3, [{ controlId: 'c-cover', kind: 'cover_letter' }]),
    });
    tab.install();

    const report = await attachAcrossFrames({
      tabId: 1,
      url: 'https://frame-0.example.com/',
      frames,
      documents,
      runId: 'run-1',
    });

    expect(report.resume).toMatchObject({ verified: true, filename: 'Resume.pdf' });
    expect(report.coverLetter).toMatchObject({ verified: true, filename: 'Cover.pdf' });

    const attaches = tab.sent.filter(
      (entry) => entry.message.type === 'ATTACH_DOCUMENT_TO_CONTROL',
    );
    expect(attaches).toHaveLength(2);
    // The résumé control was offered by frame 0 and the cover letter by frame 3.
    // Addressing either to the other frame finds nothing and reports the field
    // as missing — the failure this whole repair is about.
    expect(attaches.find((entry) => entry.message.controlId === 'c-resume')!.frameId).toBe(0);
    expect(attaches.find((entry) => entry.message.controlId === 'c-cover')!.frameId).toBe(3);

    expect(report.trace!.assertionFailed).toBe(false);
    expect(
      report.trace!.documents.find((entry) => entry.documentType === 'cover_letter')!.frameId,
    ).toBe(3);
  });

  it('never sends a document to a Transcript or Work Samples control', async () => {
    const tab = fakeTab({
      0: survey(0, [
        { controlId: 'c-transcript', kind: 'unrelated' },
        { controlId: 'c-samples', kind: 'unrelated' },
        { controlId: 'c-resume', kind: 'resume' },
      ]),
      3: survey(3, []),
    });
    tab.install();

    await attachAcrossFrames({
      tabId: 1,
      url: 'https://frame-0.example.com/',
      frames,
      documents,
      runId: 'run-2',
    });

    const targeted = tab.sent
      .filter((entry) => entry.message.type === 'ATTACH_DOCUMENT_TO_CONTROL')
      .map((entry) => entry.message.controlId);
    expect(targeted).toEqual(['c-resume']);
  });

  it('fails the résumé without taking the cover letter down with it', async () => {
    const tab = fakeTab({
      0: survey(0, [
        {
          controlId: 'c-resume',
          kind: 'resume',
          accessible: false,
          discovery: 'launcher_unresolved',
        },
      ]),
      3: survey(3, [{ controlId: 'c-cover', kind: 'cover_letter' }]),
    });
    tab.install();

    const report = await attachAcrossFrames({
      tabId: 1,
      url: 'https://frame-0.example.com/',
      frames,
      documents,
      runId: 'run-3',
    });

    expect(report.resume.verified).toBe(false);
    expect(report.resume.fieldFound).toBe(true);
    // "Found, not reachable" — not "this page has no upload control".
    expect(
      report.trace!.documents.find((entry) => entry.documentType === 'resume')!.failureCode,
    ).toBe('FILE_INPUT_NOT_ACCESSIBLE');
    expect(report.coverLetter.verified).toBe(true);
  });

  it('flags a run that saw upload controls and matched none of them', async () => {
    const tab = fakeTab({
      0: survey(0, [{ controlId: 'c-transcript', kind: 'unrelated' }]),
      3: survey(3, []),
    });
    tab.install();

    const report = await attachAcrossFrames({
      tabId: 1,
      url: 'https://frame-0.example.com/',
      frames,
      documents,
      runId: 'run-4',
    });

    // The honesty check. A page with visible upload launchers and no matched
    // document is a defect here, and the run says so in its own output rather
    // than reporting an ordinary "nothing found".
    expect(report.trace!.assertionFailed).toBe(true);
    expect(report.trace!.assertionReason).toContain('classification failure');
  });

  it('never reports a zero-length run when it attached something', async () => {
    const tab = fakeTab({
      0: survey(0, [{ controlId: 'c-resume', kind: 'resume' }]),
      3: survey(3, []),
    });
    tab.install();

    let clock = 1_000;
    const report = await attachAcrossFrames({
      tabId: 1,
      url: 'https://frame-0.example.com/',
      frames,
      documents,
      runId: 'run-5',
      now: () => (clock += 7),
    });

    // "Elapsed 0.0s" beside visible upload controls was the shipped symptom.
    expect(report.elapsedMs).toBeGreaterThan(0);
  });
});
