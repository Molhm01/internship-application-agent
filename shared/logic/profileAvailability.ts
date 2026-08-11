import type { Profile } from '../schemas/profile.js';

/**
 * What the saved profile can and cannot answer, as booleans.
 *
 * This exists because a live run's failures are not all the same kind of
 * failure, and from outside they looked identical. Lincoln Electric came back
 * with nine option controls reading "No Selection", and the natural reading was
 * that nine dropdowns are broken. Some of them are. Others have nothing to be
 * filled *from* — and one pair cannot be filled from any profile this schema is
 * able to store, which is a defect in a completely different place.
 *
 * So before repairing a control, the question is: is there an answer to put in
 * it? These booleans answer that, per record, and they are the first thing the
 * Lincoln Live Form Trace reports.
 *
 * ## Values never appear here
 *
 * Only `true`/`false` and counts. A trace is a document people paste into bug
 * reports; "the second education record has a major" is a diagnosis, and the
 * major itself is the applicant's business.
 */

/** What one saved job can answer. */
export interface WorkRecordAvailability {
  recordIndex: number;
  hasEmployer: boolean;
  hasTitle: boolean;
  hasLocation: boolean;
  hasStartDate: boolean;
  hasEndDate: boolean;
  statesCurrent: boolean;
  hasEmploymentType: boolean;
  hasReasonForLeaving: boolean;
}

/** What one saved education entry can answer. */
export interface EducationRecordAvailability {
  recordIndex: number;
  hasInstitution: boolean;
  /** `degree` or `degreeLevel` — either can answer an "Education Type" list. */
  hasEducationType: boolean;
  hasMajor: boolean;
  /**
   * Always false, and deliberately reported rather than omitted.
   *
   * `educationEntrySchema` has no country field and no state field. A form
   * asking "Education Country" or "Education State/Province" — Lincoln asks
   * both — therefore has no saved fact to draw on, whatever the control is
   * built from and however well the dropdown engine drives it. That is a gap in
   * the profile schema, not a dropdown failure, and reporting it as `false`
   * here is what tells the two apart.
   */
  hasCountry: boolean;
  hasState: boolean;
  hasGraduationDate: boolean;
  /** Whether the record positively states completed / in progress. */
  statesCompletion: boolean;
}

export interface ProfileAvailability {
  workRecordCount: number;
  educationRecordCount: number;
  work: WorkRecordAvailability[];
  education: EducationRecordAvailability[];
  /** Fields the profile schema cannot store at all, named once. */
  unstorableQuestions: string[];
}

const filled = (value: string | undefined | null): boolean =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Reads the profile's answering power, and nothing it contains.
 *
 * Pure and total: a profile with no records produces zero counts and empty
 * lists rather than throwing, because a trace that fails to build is a trace
 * nobody can send.
 */
export function describeProfileAvailability(profile: Profile): ProfileAvailability {
  const work: WorkRecordAvailability[] = profile.experience.map((entry, recordIndex) => ({
    recordIndex,
    hasEmployer: filled(entry.employer),
    hasTitle: filled(entry.title),
    hasLocation: filled(entry.location),
    hasStartDate: filled(entry.startDate),
    hasEndDate: filled(entry.endDate),
    statesCurrent: entry.current === true,
    hasEmploymentType: filled(entry.employmentType),
    hasReasonForLeaving: filled(entry.reasonForLeaving),
  }));

  const education: EducationRecordAvailability[] = profile.education.map((entry, recordIndex) => ({
    recordIndex,
    hasInstitution: filled(entry.institution),
    hasEducationType: filled(entry.degree) || filled(entry.degreeLevel),
    hasMajor: filled(entry.major),
    // See the interface. There is no field to read.
    hasCountry: false,
    hasState: false,
    hasGraduationDate: filled(entry.graduationDate),
    statesCompletion: entry.status !== undefined,
  }));

  const unstorable: string[] = [];
  if (education.length > 0) {
    unstorable.push(
      'education_country: the profile schema has no country field on an education entry',
      'education_state: the profile schema has no state field on an education entry',
    );
  }

  return {
    workRecordCount: work.length,
    educationRecordCount: education.length,
    work,
    education,
    unstorableQuestions: unstorable,
  };
}

/**
 * The availability, as sentences a bug report can carry.
 *
 * Written here rather than left to whoever reads the JSON, because the whole
 * point is to separate "this control is broken" from "nothing saved answers
 * it", and a reader should not have to work that out from booleans.
 */
export function describeAvailabilityGaps(availability: ProfileAvailability): string[] {
  const lines: string[] = [];
  lines.push(
    `${availability.workRecordCount} saved job(s), ${availability.educationRecordCount} saved education record(s).`,
  );
  for (const record of availability.work) {
    const missing: string[] = [];
    if (!record.hasEmploymentType) missing.push('employment type');
    if (!record.hasReasonForLeaving) missing.push('reason for leaving');
    if (!record.hasStartDate) missing.push('start date');
    if (!record.hasEndDate && !record.statesCurrent) missing.push('end date');
    if (missing.length > 0) {
      lines.push(`Job ${record.recordIndex + 1} has no ${missing.join(', ')}.`);
    }
  }
  for (const record of availability.education) {
    const missing: string[] = [];
    if (!record.hasEducationType) missing.push('education type');
    if (!record.hasMajor) missing.push('area of study');
    if (!record.statesCompletion) missing.push('completion status');
    if (!record.hasGraduationDate) missing.push('graduation date');
    if (missing.length > 0) {
      lines.push(`Education ${record.recordIndex + 1} has no ${missing.join(', ')}.`);
    }
  }
  for (const gap of availability.unstorableQuestions) {
    lines.push(`No profile field exists for ${gap.split(':')[0]}, so no run can answer it.`);
  }
  return lines;
}
