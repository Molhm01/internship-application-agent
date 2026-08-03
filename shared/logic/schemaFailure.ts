import { z } from 'zod';

/**
 * Turning a schema failure into a sentence a person can act on.
 *
 * A `ZodError`'s `message` is a JSON dump of its issue array. Interpolating it
 * into a user-facing string — which is what `${error}` and `error.message` both
 * do — puts several hundred characters of `{"code":"invalid_enum_value",
 * "options":[...]}` in front of somebody who wanted to fill in a job
 * application. That is exactly what the popup was showing.
 *
 * It is also actively misleading. The dumped `options` array is the list the
 * *validator* holds, so a user reading it concludes the value is unsupported,
 * when the real fault is that two halves of the extension were built at
 * different times and hold different lists.
 *
 * So: the sentence names the field and the problem, the full issue list goes to
 * `debugContext` where the diagnostics page can show it deliberately, and the
 * word "rebuild" appears when the shape of the failure says version skew.
 */

const MAX_LISTED_FIELDS = 3;

function pathOf(issue: z.ZodIssue): string {
  const path = issue.path.filter(
    (segment): segment is string | number =>
      typeof segment === 'string' || typeof segment === 'number',
  );
  return path.length > 0 ? path.join('.') : 'the response';
}

/**
 * True when the failure looks like two builds disagreeing rather than bad data.
 *
 * An unrecognized enum member is the signature: the sender produced a value the
 * receiver has never heard of, which for an internal message means one side is
 * older. Genuine bad input from a web page fails on shape or length instead.
 */
export function looksLikeVersionSkew(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) => issue.code === 'invalid_enum_value' || issue.code === 'invalid_union',
  );
}

/** One short sentence. Never JSON, never the validator's option list. */
export function describeSchemaFailure(error: unknown, subject = 'the data'): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const fields = [...new Set(error.issues.map(pathOf))];
  const listed = fields.slice(0, MAX_LISTED_FIELDS).join(', ');
  const rest = fields.length - MAX_LISTED_FIELDS;
  const where = rest > 0 ? `${listed} and ${rest} more` : listed;

  const skew = looksLikeVersionSkew(error)
    ? ' This usually means part of the extension is out of date — rebuild it and reload it at chrome://extensions.'
    : '';

  return `${subject} did not match what this build of the extension expects (${where}).${skew}`;
}

/**
 * The issues, structured, for `debugContext`.
 *
 * Capped and stripped to code and path. The rejected value itself is never
 * included: a scan carries what the user typed into a form, and a password
 * field's value must not reach a log by way of an error report.
 */
export function schemaFailureContext(error: unknown): Record<string, unknown> {
  if (!(error instanceof z.ZodError)) return {};
  return {
    issues: error.issues.slice(0, 20).map((issue) => ({ code: issue.code, path: pathOf(issue) })),
    issueCount: error.issues.length,
    versionSkew: looksLikeVersionSkew(error),
  };
}
