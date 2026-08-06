/**
 * Deciding what an upload control wants, from text alone.
 *
 * Pure and shared so the extension's DOM scanner and its tests can never reach
 * different verdicts, and so this decision is auditable without a browser. No AI
 * request is involved: a control that says "Resume" is not an ambiguous case,
 * and asking a model about it would be slower, less predictable, and impossible
 * to test deterministically.
 *
 * Two mistakes are unacceptable and are ruled out by ordering rather than hoped
 * against: a cover letter must never land in a résumé field, and a résumé must
 * never land in a cover-letter field. "Cover letter" is therefore tested first —
 * the string "Cover letter (optional, PDF resume format)" mentions both, and
 * naming it a résumé field would attach the wrong document to a real
 * application.
 */

export type DocumentFieldKind = 'resume' | 'cover_letter' | 'generic' | 'unrelated';

/**
 * Word boundaries written as letter lookarounds rather than `\b`.
 *
 * `\b` is defined against `[A-Za-z0-9_]`, so it does not fire after the `é` in
 * "résumé" — the accented spelling, which is the one this project uses in its
 * own UI, would not have matched at all.
 */
const START = '(?<![\\p{L}])';
const END = '(?![\\p{L}])';

const COVER_LETTER_PATTERN = new RegExp(
  `${START}(?:cover(?:ing)?\\s*letter|coverletter|motivation\\s*letter|letter\\s*of\\s*interest)${END}`,
  'iu',
);

const RESUME_PATTERN = new RegExp(
  `${START}(?:r[eé]sum[eé]|resume|curriculum\\s*vitae|cv)${END}`,
  'iu',
);

/**
 * A slot that asks for "a document" without saying which. Handled separately
 * from `unrelated`, because the single-generic-field rule prefers the résumé
 * there while an unrelated field is never touched at all.
 */
const GENERIC_PATTERN =
  /\b(attach|upload|choose|select|add)\b[^.]{0,40}\b(file|document|attachment)\b|\b(document|file)[\s_-]*upload\b/i;

/** Everything a file control might be for that is explicitly not ours. */
const UNRELATED_PATTERN =
  /\btranscript\b|\bacademic[\s_-]*record\b|\bportfolio\b|\bwork[\s_-]*samples?\b|\bwriting[\s_-]*sample\b|\bphoto\b|\bheadshot\b|\bid[\s_-]*(card|document)\b|\bpassport\b|\bcertificat|\bdiploma\b|\brecommendation\b|\breference[\s_-]*letter\b/i;

/** Every string on the page that says what one upload control is for. */
export interface DocumentFieldContext {
  label?: string | undefined;
  ariaLabel?: string | undefined;
  ariaLabelledByText?: string | undefined;
  name?: string | undefined;
  elementId?: string | undefined;
  sectionHeading?: string | undefined;
  nearbyText?: string | undefined;
  buttonText?: string | undefined;
  accept?: string | undefined;
  placeholder?: string | undefined;
  title?: string | undefined;
}

export function documentFieldText(context: DocumentFieldContext): string {
  return (
    [
      context.label,
      context.ariaLabel,
      context.ariaLabelledByText,
      context.name,
      context.elementId,
      context.sectionHeading,
      context.nearbyText,
      context.buttonText,
      context.placeholder,
      context.title,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      // Separators matter: `id="resumeUpload"` and `name="cover_letter"` are the
      // real-world shapes, and joining without a boundary would let two adjacent
      // attributes form a word that neither of them contains.
      .join(' | ')
  );
}

/**
 * Makes an attribute name readable by the same patterns as a visible label.
 *
 * `name="resume_file"` and `id="coverLetterUpload"` are the shapes real
 * employer pages use, and neither is separated by anything a word-boundary
 * match can see: an underscore is a word character, and a camelCase hump is not
 * a boundary at all.
 */
function normalizeForMatching(text: string): string {
  return text.replace(/[_\-.]+/g, ' ').replace(/([a-z\d])([A-Z])/g, '$1 $2');
}

/** What the control says about itself: its label and its own attributes. */
function directText(context: DocumentFieldContext): string {
  return join([
    context.label,
    context.ariaLabel,
    context.ariaLabelledByText,
    context.name,
    context.elementId,
    context.placeholder,
    context.title,
  ]);
}

/** What the page around the control says: headings, instructions, the button. */
function contextualText(context: DocumentFieldContext): string {
  return join([context.sectionHeading, context.buttonText, context.nearbyText]);
}

function join(parts: ReadonlyArray<string | undefined>): string {
  return normalizeForMatching(
    parts
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      // Separators matter: joining without a boundary would let two adjacent
      // attributes form a word that neither of them contains.
      .join(' | '),
  );
}

function match(text: string): DocumentFieldKind | null {
  if (COVER_LETTER_PATTERN.test(text)) return 'cover_letter';
  if (RESUME_PATTERN.test(text)) return 'resume';
  if (UNRELATED_PATTERN.test(text)) return 'unrelated';
  if (GENERIC_PATTERN.test(text)) return 'generic';
  return null;
}

/**
 * The control's own words are decisive; the page around it is only consulted
 * when they say nothing.
 *
 * The precedence is not cosmetic. A résumé input sitting inside a section
 * headed "Resume and cover letter" would otherwise be read from that heading —
 * and the cover-letter rule, which has to run first for the reason above, would
 * claim it. A hidden input whose only evidence is the "Upload Resume" button
 * beside it still classifies correctly, because that evidence is all there is.
 */
export function classifyDocumentField(context: DocumentFieldContext): DocumentFieldKind {
  return match(directText(context)) ?? match(contextualText(context)) ?? 'unrelated';
}

export interface ClassifiedDocumentField {
  readonly kind: DocumentFieldKind;
}

/**
 * Which field each document goes in, given everything found on the page.
 *
 * The generic rule is the delicate one. A lone unlabelled slot takes the résumé
 * and nothing else: attaching the cover letter to the same control would either
 * replace the résumé or, on a multi-file input, submit a cover letter the
 * employer never asked for. The caller reports that no separate cover-letter
 * field was found rather than pretending one was filled.
 */
export function selectDocumentTargets<T extends ClassifiedDocumentField>(
  fields: readonly T[],
): { resume: T | null; coverLetter: T | null; usedGenericForResume: boolean } {
  const resume = fields.find((field) => field.kind === 'resume') ?? null;
  const coverLetter = fields.find((field) => field.kind === 'cover_letter') ?? null;
  if (resume) return { resume, coverLetter, usedGenericForResume: false };

  const generics = fields.filter((field) => field.kind === 'generic');
  // Only when it is genuinely the single document slot on the page. Two
  // unlabelled uploads are a form we cannot read, and guessing which is which
  // is exactly the mistake this module exists to prevent.
  const lone = generics.length === 1 && !coverLetter ? generics[0]! : null;
  return {
    resume: lone,
    coverLetter,
    usedGenericForResume: lone !== null,
  };
}
