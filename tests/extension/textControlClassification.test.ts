import { beforeEach, describe, expect, it } from 'vitest';
import { scanApplication } from '../../extension/src/scanner/scanApplication.js';
import { attachInFrame, discoverInFrame } from '../../extension/src/uploads/frameUploads.js';

/**
 * "Legal First Name" is typed into, not chosen from.
 *
 * The shipped build classified `<input type="text" role="combobox">` as a
 * combobox, which permits `select_option`, which sent the saved first name to an
 * option matcher, which reported *"No option on the page matched 'Molhm'"* — for
 * a box you simply type your name into.
 *
 * The repair is an ordering one: the DOM node's own type is consulted before any
 * ARIA role or CSS class. These tests pin that ordering against every shape that
 * produced the bug.
 */

async function scan(): Promise<Awaited<ReturnType<typeof scanApplication>>> {
  return scanApplication({
    scanId: 'scan-text-contract',
    document,
    signal: new AbortController().signal,
  });
}

function fieldFor(
  result: Awaited<ReturnType<typeof scanApplication>>,
  label: string,
): (typeof result.fields)[number] | undefined {
  return result.fields.find((field) => field.label.toLowerCase().includes(label.toLowerCase()));
}

describe('text control classification', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('classifies an ARIA-combobox text input as text, not a dropdown', async () => {
    document.body.innerHTML = `
      <form>
        <label for="firstName">Legal First Name</label>
        <input id="firstName" name="firstName" type="text" role="combobox"
               aria-expanded="false" class="css-1abcde-control" />
      </form>
    `;

    const field = fieldFor(await scan(), 'Legal First Name');
    expect(field).toBeDefined();
    expect(field!.fieldType).toBe('text');
    // No option list, because a text box has no options. An empty option list is
    // what an option matcher searches and fails to match against.
    expect(field!.options ?? []).toHaveLength(0);
  });

  it.each([
    ['react-select class', 'class="select__control"', 'text'],
    ['listbox role', 'role="listbox"', 'text'],
    ['combobox role', 'role="combobox"', 'text'],
  ])('classifies a text input with a %s as text', async (_name, attribute, expected) => {
    document.body.innerHTML = `
      <form>
        <label for="x">Legal Last Name</label>
        <input id="x" name="lastName" type="text" ${attribute} />
      </form>
    `;
    expect(fieldFor(await scan(), 'Legal Last Name')!.fieldType).toBe(expected);
  });

  it('keeps email, tel, number and url distinct from text', async () => {
    document.body.innerHTML = `
      <form>
        <label for="e">Email Address</label><input id="e" type="email" role="combobox" />
        <label for="p">Phone Number</label><input id="p" type="tel" class="select__control" />
        <label for="n">Years of Experience</label><input id="n" type="number" />
        <label for="u">Portfolio URL</label><input id="u" type="url" />
      </form>
    `;
    const result = await scan();
    expect(fieldFor(result, 'Email Address')!.fieldType).toBe('email');
    expect(fieldFor(result, 'Phone Number')!.fieldType).toBe('tel');
    expect(fieldFor(result, 'Years of Experience')!.fieldType).toBe('number');
    expect(fieldFor(result, 'Portfolio URL')!.fieldType).toBe('url');
  });

  it('still reads a real select and a readonly combobox as choice controls', async () => {
    document.body.innerHTML = `
      <form>
        <label for="s">Country</label>
        <select id="s"><option value="">Choose</option><option value="us">United States</option></select>
        <label for="c">State</label>
        <input id="c" type="text" role="combobox" readonly aria-expanded="false" />
      </form>
    `;
    const result = await scan();
    expect(fieldFor(result, 'Country')!.fieldType).toBe('select');
    // A readonly input cannot be typed into at all, so it really is a dropdown
    // wearing an input's clothes. Calling it text would leave it blank forever.
    expect(fieldFor(result, 'State')!.fieldType).toBe('combobox');
  });

  // The listbox named by `aria-controls` here does not exist yet: it is created
  // when the user types. `aria-autocomplete` is the only evidence available
  // before then, and without it a searchable Location box — or a State control
  // whose options appear once Country is chosen — would be typed into and the
  // widget's own state left unset.
  it('still reads a searchable input that answers from a list as a combobox', async () => {
    document.body.innerHTML = `
      <form>
        <label for="loc">Location (City)</label>
        <input id="loc" type="text" role="combobox" aria-autocomplete="list"
               aria-controls="loc-listbox" aria-expanded="false" />
      </form>
    `;
    expect(fieldFor(await scan(), 'Location (City)')!.fieldType).toBe('combobox');
  });

  it('reads an input whose listbox is already rendered as a combobox', async () => {
    document.body.innerHTML = `
      <form>
        <label for="c">Country</label>
        <input id="c" type="text" role="combobox" aria-controls="c-list" aria-expanded="false" />
        <ul id="c-list" role="listbox"><li role="option">United States</li></ul>
      </form>
    `;
    expect(fieldFor(await scan(), 'Country')!.fieldType).toBe('combobox');
  });

  it('leaves password, date and file controls alone', async () => {
    document.body.innerHTML = `
      <form>
        <label for="pw">Password</label><input id="pw" type="password" />
        <label for="d">Start Date</label><input id="d" type="date" />
        <label for="f">Resume</label><input id="f" type="file" />
      </form>
    `;
    const result = await scan();
    expect(fieldFor(result, 'Password')!.fieldType).toBe('password');
    expect(fieldFor(result, 'Start Date')!.fieldType).toBe('date');
    expect(fieldFor(result, 'Resume')!.fieldType).toBe('file');
  });
});

describe('attaching a stored file to a discovered control', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const payload = {
    documentType: 'resume' as const,
    filename: 'Resume-Acme.pdf',
    mimeType: 'application/pdf' as const,
    // "%PDF" — four bytes, matching `byteLength`, so the integrity check passes.
    contentBase64: 'JVBERg==',
    byteLength: 4,
    source: 'tailored' as const,
  };

  it('puts the real bytes in the real input and verifies from the DOM', async () => {
    document.body.innerHTML = `
      <fieldset><h3>Resume</h3>
        <label for="r">My Computer</label>
        <input id="r" name="resumeFile" type="file" />
      </fieldset>`;

    const survey = await discoverInFrame(document, 'run-1', false);
    const control = survey.controls.find((candidate) => candidate.kind === 'resume')!;
    expect(control).toBeDefined();

    const result = await attachInFrame('run-1', control.controlId, payload);
    expect(result).toMatchObject({ attached: true, verified: true, failureCode: null });

    const input = document.getElementById('r') as HTMLInputElement;
    expect(input.files?.[0]?.name).toBe('Resume-Acme.pdf');
    expect(input.files?.[0]?.type).toBe('application/pdf');
    expect(input.files?.[0]?.size).toBe(4);
  });

  it('refuses a stored document whose bytes do not match its recorded length', async () => {
    document.body.innerHTML = `
      <fieldset><h3>Resume</h3><input id="r" name="resumeFile" type="file" /></fieldset>`;
    const survey = await discoverInFrame(document, 'run-2', false);
    const control = survey.controls.find((candidate) => candidate.kind === 'resume')!;

    const result = await attachInFrame('run-2', control.controlId, {
      ...payload,
      byteLength: 9_999,
    });

    // A truncated copy is refused rather than uploaded. "Attached" must never be
    // reported for a file the employer would receive as a broken PDF.
    expect(result.attached).toBe(false);
    expect(result.failureCode).toBe('DOCUMENT_NOT_STORED');
    expect((document.getElementById('r') as HTMLInputElement).files?.length ?? 0).toBe(0);
  });

  it('refuses a control id it never issued', async () => {
    const result = await attachInFrame('run-never-opened', 'upload-made-up', payload);
    expect(result.attached).toBe(false);
    expect(result.failureCode).toBe('CONTROL_LEFT_PAGE');
  });

  it('reports an unreachable launcher as such rather than as a missing field', async () => {
    document.body.innerHTML = `
      <fieldset><h3>Resume</h3><button type="button">My Computer</button></fieldset>`;
    const survey = await discoverInFrame(document, 'run-3', false);
    const control = survey.controls.find((candidate) => candidate.kind === 'resume')!;

    expect(control.accessible).toBe(false);
    const result = await attachInFrame('run-3', control.controlId, payload);
    expect(result.failureCode).toBe('FILE_INPUT_NOT_ACCESSIBLE');
  });
});
