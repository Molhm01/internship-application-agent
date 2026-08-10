import {
  contextualQuestionLabel,
  matchCanonicalQuestion,
  needsSectionContext,
  type CanonicalQuestion,
  type DropdownDescriptor,
} from '@internship-agent/shared';

/**
 * What a dropdown is asking, before anything is done about it.
 *
 * Order matters here and it is the opposite of the order that feels natural.
 * The engine works out the *question* first and only then opens the control —
 * because a control that is opened before its meaning is known has to be matched
 * against its own list by guesswork, and that is the failure mode this whole
 * subsystem replaces. Knowing the question first also means a searchable control
 * can be typed into with a term derived from the answer rather than probed
 * blindly.
 *
 * Nothing new is invented here. `matchCanonicalQuestion` is the single
 * classifier the scanner and planner already use, and this calls it with better
 * input: the label plus the section it sits under. That is the entire
 * contribution, and it is a real one — "Country" under "Education" and
 * "Country" under "Home Address" are the same eight characters, and a form
 * routinely asks both.
 */

export interface ResolvedQuestion {
  canonicalQuestion: CanonicalQuestion;
  /** The wording the classifier actually saw, for the trace to explain itself. */
  interpretedLabel: string;
  /** The classifier's own confidence, so a weak reading can be reported as one. */
  confidence: number;
}

/**
 * The most specific heading a section context carries.
 *
 * `sectionContext` is built innermost-first, so the first entry is the heading
 * closest to the control — "Education" rather than "Application", which is the
 * one that disambiguates.
 */
function nearestHeading(sectionContext: string): string {
  return sectionContext.split('›')[0]?.trim() ?? '';
}

export function resolveDropdownQuestion(descriptor: DropdownDescriptor): ResolvedQuestion {
  const label = descriptor.label.trim();
  const heading = nearestHeading(descriptor.sectionContext);

  // A label that already names its own subject is left alone. "Education
  // Country" needs no help, and prefixing it with its heading would produce
  // "Education Education Country" — which scores worse, not better.
  const contextual =
    heading && needsSectionContext(label) ? contextualQuestionLabel(label, heading) : label;

  const direct = matchCanonicalQuestion(contextual);
  if (direct.question !== 'unknown') {
    return {
      canonicalQuestion: direct.question,
      interpretedLabel: contextual,
      confidence: direct.confidence,
    };
  }

  // The contextual reading found nothing. Try the bare label before giving up:
  // a heading can mislead as easily as it can clarify, and a label that reads
  // cleanly on its own should not be lost to the section it happens to sit in.
  if (contextual !== label) {
    const bare = matchCanonicalQuestion(label);
    if (bare.question !== 'unknown') {
      return {
        canonicalQuestion: bare.question,
        interpretedLabel: label,
        confidence: bare.confidence,
      };
    }
  }

  return { canonicalQuestion: 'unknown', interpretedLabel: contextual || label, confidence: 0 };
}
