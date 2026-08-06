import { describe, expect, it } from 'vitest';
import type { AttachableDocumentPayload } from '@internship-agent/shared';
import { runSingleFrameAttachment } from './helpers/singleFrameAttach.js';

/**
 * The document-only run against real DOM, including the two shapes that used to
 * defeat it: a hidden input behind an Upload button, and a widget that clears
 * the input and renders the filename instead.
 */

const RESUME_BYTES = Buffer.from('%PDF-1.4\nresume\n%%EOF\n');
const COVER_BYTES = Buffer.from('%PDF-1.4\ncover\n%%EOF\n');

function payload(
  documentType: 'resume' | 'cover_letter',
  filename: string,
  bytes: Buffer,
  source: 'tailored' | 'default' = 'tailored',
): AttachableDocumentPayload {
  return {
    documentType,
    filename,
    mimeType: 'application/pdf',
    byteLength: bytes.byteLength,
    source,
    contentBase64: bytes.toString('base64'),
  };
}

const RESUME = payload('resume', 'Resume-Acme-Intern.pdf', RESUME_BYTES);
const COVER = payload('cover_letter', 'Cover-Letter-Acme-Intern.pdf', COVER_BYTES);

/** Mirrors what a real upload widget does: show the filename on change. */
function wireFilenameDisplay(): void {
  for (const input of Array.from(document.querySelectorAll('input[type="file"]'))) {
    input.addEventListener('change', () => {
      const status = document.getElementById(`${input.id}-filename`);
      if (status) status.textContent = (input as HTMLInputElement).files?.[0]?.name ?? '';
    });
  }
}

function fileNameIn(id: string): string | undefined {
  const input = document.getElementById(id) as HTMLInputElement | null;
  return input?.files?.[0]?.name;
}

describe('the document-only attachment run', () => {
  it('attaches each document to its own field and verifies both in the DOM', async () => {
    document.body.innerHTML = `
      <form>
        <fieldset><legend>Resume</legend>
          <label for="resume">Resume / CV</label>
          <input id="resume" name="resume" type="file" />
          <p id="resume-filename"></p>
        </fieldset>
        <fieldset><legend>Cover letter</legend>
          <label for="cover">Cover Letter</label>
          <input id="cover" name="cover_letter" type="file" />
          <p id="cover-filename"></p>
        </fieldset>
        <button id="submit" type="submit">Submit application</button>
      </form>`;
    wireFilenameDisplay();

    const report = await runSingleFrameAttachment('run-1', 'https://jobs.example/apply', [
      RESUME,
      COVER,
    ]);

    expect(report.resume).toMatchObject({
      fieldFound: true,
      attached: true,
      verified: true,
      filename: 'Resume-Acme-Intern.pdf',
      source: 'tailored',
    });
    expect(report.coverLetter).toMatchObject({
      fieldFound: true,
      attached: true,
      verified: true,
      filename: 'Cover-Letter-Acme-Intern.pdf',
    });
    expect(fileNameIn('resume')).toBe('Resume-Acme-Intern.pdf');
    expect(fileNameIn('cover')).toBe('Cover-Letter-Acme-Intern.pdf');
    expect(report.submitted).toBe(false);
    expect(report.fileFieldsSeen).toBe(2);
  });

  it('fills a hidden input driven by an Upload Resume button', async () => {
    document.body.innerHTML = `
      <div>
        <input id="hidden-resume" name="resume_alt" type="file" style="display:none" />
        <button type="button">Upload Resume</button>
        <p id="hidden-resume-filename"></p>
      </div>`;
    wireFilenameDisplay();

    const report = await runSingleFrameAttachment('run-2', 'https://jobs.example/apply', [RESUME]);

    expect(report.resume.verified).toBe(true);
    expect(fileNameIn('hidden-resume')).toBe('Resume-Acme-Intern.pdf');
  });

  it('verifies against a widget that clears the input and shows the name', async () => {
    document.body.innerHTML = `
      <div>
        <label for="resume">Resume</label>
        <input id="resume" name="resume" type="file" />
        <p id="resume-status"></p>
      </div>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    input.addEventListener('change', () => {
      const name = input.files?.[0]?.name ?? '';
      // What a React-controlled uploader does: take the file, post it, and
      // render the name while emptying the control.
      input.value = '';
      document.getElementById('resume-status')!.textContent = name;
    });

    const report = await runSingleFrameAttachment('run-3', 'https://jobs.example/apply', [RESUME]);

    expect(report.resume.attached).toBe(true);
    expect(report.resume.verified).toBe(true);
    expect(input.files?.length ?? 0).toBe(0);
  });

  it('gives a lone generic field the résumé only, and says so', async () => {
    document.body.innerHTML = `
      <form>
        <label for="doc">Attach a document</label>
        <input id="doc" name="document" type="file" />
        <p id="doc-filename"></p>
        <label for="photo">Headshot</label>
        <input id="photo" name="photo" type="file" />
        <p id="photo-filename"></p>
        <button id="submit" type="submit">Submit</button>
      </form>`;
    wireFilenameDisplay();

    const report = await runSingleFrameAttachment('run-4', 'https://jobs.example/apply', [
      RESUME,
      COVER,
    ]);

    expect(fileNameIn('doc')).toBe('Resume-Acme-Intern.pdf');
    expect(report.coverLetter.fieldFound).toBe(false);
    expect(report.coverLetter.attached).toBe(false);
    expect(report.coverLetter.message).toContain('No separate cover-letter field');
    // The unrelated control is untouched.
    expect(fileNameIn('photo')).toBeUndefined();
  });

  it('leaves unrelated file fields alone', async () => {
    document.body.innerHTML = `
      <form>
        <label for="resume">Resume</label><input id="resume" type="file" />
        <p id="resume-filename"></p>
        <label for="transcript">Official transcript</label><input id="transcript" type="file" />
        <p id="transcript-filename"></p>
      </form>`;
    wireFilenameDisplay();

    await runSingleFrameAttachment('run-5', 'https://jobs.example/apply', [RESUME, COVER]);

    expect(fileNameIn('resume')).toBe('Resume-Acme-Intern.pdf');
    expect(fileNameIn('transcript')).toBeUndefined();
  });

  it('reports a missing field honestly instead of attaching elsewhere', async () => {
    document.body.innerHTML = `
      <form>
        <label for="resume">Resume</label><input id="resume" type="file" />
        <p id="resume-filename"></p>
      </form>`;
    wireFilenameDisplay();

    const report = await runSingleFrameAttachment('run-6', 'https://jobs.example/apply', [
      RESUME,
      COVER,
    ]);

    expect(report.resume.verified).toBe(true);
    expect(report.coverLetter.fieldFound).toBe(false);
    expect(report.coverLetter.filename).toBeNull();
  });

  it('never reports a verified attachment when the page drops the file', async () => {
    document.body.innerHTML = `
      <form>
        <label for="resume">Resume</label><input id="resume" type="file" />
      </form>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    // Refuses everything, silently: the case that must never be called success.
    input.addEventListener('change', () => {
      input.value = '';
    });

    const report = await runSingleFrameAttachment('run-7', 'https://jobs.example/apply', [RESUME]);

    expect(report.resume.attached).toBe(true);
    expect(report.resume.verified).toBe(false);
    expect(report.resume.message).toContain('never showed it');
  });

  it('names the document source it used', async () => {
    document.body.innerHTML = `
      <label for="resume">Resume</label><input id="resume" type="file" />
      <p id="resume-filename"></p>`;
    wireFilenameDisplay();

    const report = await runSingleFrameAttachment('run-8', 'https://jobs.example/apply', [
      payload('resume', 'Master-Resume.pdf', RESUME_BYTES, 'default'),
    ]);

    expect(report.resume.source).toBe('default');
    expect(report.resume.filename).toBe('Master-Resume.pdf');
  });

  it('says so plainly when the page has no upload control at all', async () => {
    document.body.innerHTML = '<form><input type="text" name="first_name" /></form>';
    const report = await runSingleFrameAttachment('run-9', 'https://jobs.example/apply', [RESUME]);
    expect(report.fileFieldsSeen).toBe(0);
    expect(report.resume.fieldFound).toBe(false);
    // "In any frame" is the part that had to change. The old sentence — "This
    // page has no file upload control" — was said about the main document alone,
    // on a page whose upload controls were in an iframe.
    expect(report.resume.message).toContain('No file upload control was found in any frame');
    // And it is only ever said when there was genuinely nothing to find.
    expect(report.trace?.assertionFailed).toBe(false);
  });
});
