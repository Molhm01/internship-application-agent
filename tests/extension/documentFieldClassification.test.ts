import { describe, expect, it } from 'vitest';
import {
  classifyDocumentField,
  selectDocumentTargets,
  type DocumentFieldKind,
} from '@internship-agent/shared';
import { surveyUploadControls } from '../../extension/src/uploads/uploadControls.js';

/**
 * What each upload control wants, decided from text alone and without a model.
 * Every case here is one an employer page actually produces.
 */

describe('classifying a file field', () => {
  it('reads a résumé field from any of the words employers use', () => {
    for (const label of [
      'Resume',
      'Résumé',
      'Resume/CV',
      'Curriculum Vitae',
      'Upload resume',
      'Attach resume',
      'CV (required)',
    ]) {
      expect(classifyDocumentField({ label })).toBe('resume');
    }
  });

  it('reads a cover-letter field from any of the words employers use', () => {
    for (const label of [
      'Cover Letter',
      'Covering letter',
      'Motivation letter',
      'Letter of interest',
      'Upload cover letter',
    ]) {
      expect(classifyDocumentField({ label })).toBe('cover_letter');
    }
  });

  it('never reads a cover-letter field as a résumé field', () => {
    // The dangerous case: the text mentions both, and picking "resume" would
    // attach the wrong document to a real application.
    expect(classifyDocumentField({ label: 'Cover letter (PDF, same format as your resume)' })).toBe(
      'cover_letter',
    );
    expect(
      classifyDocumentField({ name: 'coverLetter', sectionHeading: 'Resume and letters' }),
    ).toBe('cover_letter');
  });

  it('uses attributes and surrounding context, not only the label', () => {
    expect(classifyDocumentField({ name: 'resume_file' })).toBe('resume');
    expect(classifyDocumentField({ elementId: 'coverLetterUpload' })).toBe('cover_letter');
    expect(classifyDocumentField({ ariaLabel: 'Upload your résumé' })).toBe('resume');
    expect(classifyDocumentField({ ariaLabelledByText: 'Cover letter' })).toBe('cover_letter');
    expect(classifyDocumentField({ sectionHeading: 'Resume' })).toBe('resume');
    expect(classifyDocumentField({ nearbyText: 'PDF only. Attach your CV here.' })).toBe('resume');
    expect(classifyDocumentField({ buttonText: 'Upload Resume' })).toBe('resume');
  });

  it('names an unlabelled document slot generic and everything else unrelated', () => {
    expect(classifyDocumentField({ label: 'Attach a document' })).toBe('generic');
    expect(classifyDocumentField({ label: 'Upload file' })).toBe('generic');
    expect(classifyDocumentField({ label: 'Official transcript' })).toBe('unrelated');
    expect(classifyDocumentField({ label: 'Portfolio' })).toBe('unrelated');
    expect(classifyDocumentField({ label: 'Headshot' })).toBe('unrelated');
    expect(classifyDocumentField({ label: 'Letter of recommendation' })).toBe('unrelated');
  });
});

const field = (kind: DocumentFieldKind): { kind: DocumentFieldKind } => ({ kind });

describe('choosing which field each document goes in', () => {
  it('pairs each document with its own field', () => {
    const fields = [field('resume'), field('cover_letter'), field('unrelated')];
    const targets = selectDocumentTargets(fields);
    expect(targets.resume).toBe(fields[0]);
    expect(targets.coverLetter).toBe(fields[1]);
    expect(targets.usedGenericForResume).toBe(false);
  });

  it('gives a lone generic slot the résumé and nothing else', () => {
    const fields = [field('generic'), field('unrelated')];
    const targets = selectDocumentTargets(fields);
    expect(targets.resume).toBe(fields[0]);
    expect(targets.coverLetter).toBeNull();
    expect(targets.usedGenericForResume).toBe(true);
  });

  it('leaves two unlabelled slots alone rather than guessing', () => {
    const targets = selectDocumentTargets([field('generic'), field('generic')]);
    expect(targets.resume).toBeNull();
    expect(targets.coverLetter).toBeNull();
  });

  it('never puts the résumé in an unrelated field', () => {
    const targets = selectDocumentTargets([field('unrelated'), field('unrelated')]);
    expect(targets.resume).toBeNull();
    expect(targets.coverLetter).toBeNull();
  });
});

describe('collecting file fields from a page', () => {
  it('finds hidden inputs, skips disabled ones, and reads no text field', async () => {
    document.body.innerHTML = `
      <label for="r">Resume</label><input id="r" type="file" />
      <input id="hidden-resume" name="resume_alt" type="file" style="display:none" />
      <label for="c">Cover Letter</label><input id="c" type="file" />
      <input id="off" name="resume_off" type="file" disabled />
      <input id="text-field" name="first_name" type="text" />
      <button id="submit-application" type="submit">Submit</button>
    `;

    const fields = (await surveyUploadControls(document, false)).controls;
    expect(fields.map((entry) => entry.input?.id)).toEqual(['r', 'hidden-resume', 'c']);
    expect(fields.map((entry) => entry.kind)).toEqual(['resume', 'resume', 'cover_letter']);
  });
});
