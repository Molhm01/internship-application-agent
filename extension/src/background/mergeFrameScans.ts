import {
  applicationScanResultSchema,
  countFieldStatistics,
  type ApplicationScanResult,
  type DetectedField,
} from '@internship-agent/shared';
import type { FrameTarget } from './frames.js';

/**
 * One scan out of several frames, with frame identity preserved.
 *
 * An application form split across an outer page and an embedded widget is two
 * documents, and the extension used to see only the first. Scanning every frame
 * is half the repair; the other half is that a field must remember which frame
 * it came from, all the way to the moment it is filled — a fill action sent to
 * the wrong frame finds nothing and silently reports the field as missing.
 *
 * Field ids are namespaced by frame. Two frames minting `field-3` is not
 * hypothetical: ids are derived from position within a document, so an outer
 * page and an iframe of the same form routinely collide, and the executor
 * resolves an action by field id.
 */

export interface FrameScan {
  frame: FrameTarget;
  result: ApplicationScanResult;
}

/** `f0:` is left off the main frame so existing ids and fixtures read unchanged. */
export function namespaceFieldId(frameId: number, fieldId: string): string {
  return frameId === 0 ? fieldId : `f${frameId}-${fieldId}`;
}

/** A URL compared for document identity: everything but the fragment. */
function documentKey(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * The document a field was actually read out of.
 *
 * A content script's scan walks into every same-origin iframe it can reach, so
 * the top frame's scan legitimately contains fields belonging to a child
 * document. The scanner records which one on each field.
 */
function sourceDocument(field: DetectedField, fallback: string): string {
  const url = field.metadata.frameUrl;
  return documentKey(typeof url === 'string' && url.length > 0 ? url : fallback);
}

/**
 * Fields this frame may contribute, with the ones another frame owns removed.
 *
 * The parent's scan reaches into a same-origin child, and the child's own
 * content script scans it too — so one `<input>` arrives twice, once routed to
 * frame 0 and once to the frame it actually lives in. Both were kept, which put
 * two questions on the review screen for one control and sent the first write to
 * a document that does not contain it.
 *
 * A borrowed field is dropped only when the frame that owns it was *also*
 * scanned. When a child could not be injected — a content script that failed to
 * load, a frame that navigated mid-scan — the parent's copy is the only record
 * of that control and is kept, because a field routed imperfectly is worth more
 * than a field nobody knows about.
 */
function ownFields(scan: FrameScan, scannedDocuments: ReadonlySet<string>): DetectedField[] {
  const own = documentKey(scan.frame.url);
  return scan.result.fields.filter((field) => {
    const source = sourceDocument(field, scan.frame.url);
    return source === own || !scannedDocuments.has(source);
  });
}

function stampFields(fields: readonly DetectedField[], scan: FrameScan): DetectedField[] {
  return fields.map((field) => ({
    ...field,
    id: namespaceFieldId(scan.frame.frameId, field.id),
    frameId: scan.frame.frameId,
    frameUrl: scan.frame.url.slice(0, 2048),
  }));
}

/** Adds the numeric halves of two statistics blocks. Sections included. */
function addStatistics(
  left: ApplicationScanResult['statistics'],
  right: ApplicationScanResult['statistics'],
): ApplicationScanResult['statistics'] {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    if (typeof value === 'number' && typeof existing === 'number') {
      merged[key] = existing + value;
    } else if (
      value !== null &&
      typeof value === 'object' &&
      existing !== null &&
      typeof existing === 'object'
    ) {
      const sections: Record<string, number> = { ...(existing as Record<string, number>) };
      for (const [section, count] of Object.entries(value as Record<string, number>)) {
        sections[section] = (sections[section] ?? 0) + count;
      }
      merged[key] = sections;
    }
  }
  return merged as ApplicationScanResult['statistics'];
}

/**
 * The scan the rest of the extension works from.
 *
 * The main frame is the base — its URL, domain, ATS detection and navigation
 * state describe the application, and a subframe's do not. Subframes contribute
 * fields and warnings only. When the main frame did not answer at all, the
 * frame that found the most fields stands in for it, because a form entirely
 * inside an iframe is still a form.
 */
export function mergeFrameScans(scans: readonly FrameScan[]): ApplicationScanResult | null {
  if (scans.length === 0) return null;

  const base =
    scans.find((scan) => scan.frame.topFrame) ??
    [...scans].sort((left, right) => right.result.fields.length - left.result.fields.length)[0]!;
  const others = scans.filter((scan) => scan !== base);
  const scannedDocuments = new Set(scans.map((scan) => documentKey(scan.frame.url)));

  const baseOwn = ownFields(base, scannedDocuments);
  let fields = stampFields(baseOwn, base);
  /**
   * Every control a frame reported that its owner also reported. Counted as
   * duplicates rather than dropped silently — the census is what a person reads
   * to tell "the page has twenty questions" from "the page has twenty questions
   * and the scan saw twenty-three".
   */
  let borrowed = base.result.fields.length - baseOwn.length;
  let statistics = base.result.statistics;
  const warnings = [...base.result.warnings];

  for (const scan of others) {
    if (scan.result.fields.length === 0) continue;
    const own = ownFields(scan, scannedDocuments);
    borrowed += scan.result.fields.length - own.length;
    fields = [...fields, ...stampFields(own, scan)];
    statistics = addStatistics(statistics, scan.result.statistics);
    for (const warning of scan.result.warnings) {
      // Prefixed so a warning about an embedded widget is not read as one about
      // the page the user is looking at.
      const attributed = `Embedded frame: ${warning}`;
      if (!warnings.includes(attributed)) warnings.push(attributed);
    }
  }

  return applicationScanResultSchema.parse({
    ...base.result,
    fields,
    // Every per-field count is re-derived from the merged list rather than
    // summed. Summing them across frames double-counted a control the parent
    // and the child both reported, so the scan claimed more supported fields
    // than it had fields at all.
    statistics: countFieldStatistics(fields, statistics.navigationActions, {
      rawControls: statistics.rawControls ?? 0,
      falseControlsRemoved: statistics.falseControlsRemoved ?? 0,
      duplicateControlsRemoved: (statistics.duplicateControlsRemoved ?? 0) + borrowed,
    }),
    warnings,
    durationMs: Math.max(...scans.map((scan) => scan.result.durationMs)),
    status: warnings.length ? 'completed_with_warnings' : 'completed',
  });
}

/** The frame a field lives in. Absent means the main frame, by definition. */
export function frameIdOf(field: Pick<DetectedField, 'frameId'>): number {
  return field.frameId ?? 0;
}
