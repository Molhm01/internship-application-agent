import {
  applicationScanResultSchema,
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

function stampFields(scan: FrameScan): DetectedField[] {
  return scan.result.fields.map((field) => ({
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

  let fields = stampFields(base);
  let statistics = base.result.statistics;
  const warnings = [...base.result.warnings];

  for (const scan of others) {
    if (scan.result.fields.length === 0) continue;
    fields = [...fields, ...stampFields(scan)];
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
    statistics,
    warnings,
    durationMs: Math.max(...scans.map((scan) => scan.result.durationMs)),
    status: warnings.length ? 'completed_with_warnings' : 'completed',
  });
}

/** The frame a field lives in. Absent means the main frame, by definition. */
export function frameIdOf(field: Pick<DetectedField, 'frameId'>): number {
  return field.frameId ?? 0;
}
