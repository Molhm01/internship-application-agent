import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateAndObserve,
  resolveLauncherInput,
  surveyUploadControls,
} from '../../extension/src/uploads/uploadControls.js';

/**
 * Upload-control discovery, against the shapes that defeated the old build.
 *
 * The previous discovery was one `querySelectorAll('input[type="file"]')`. Each
 * test below is a control that query returns nothing for and that a person
 * looking at the page would point straight at.
 */

/**
 * The ambient jsdom document, not a fresh `new JSDOM`.
 *
 * Discovery narrows elements with `instanceof HTMLElement`, and a separately
 * constructed JSDOM realm has its own `HTMLElement` — every check would fail for
 * a reason that has nothing to do with the code under test. A content script
 * always runs in the same realm as the document it is scanning, so this is also
 * the accurate setup.
 */
function dom(body: string): Document {
  document.body.innerHTML = body;
  return document;
}

let counter = 0;
const ids = (): string => `id-${(counter += 1)}`;

describe('upload control discovery', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds a hidden file input driven by a styled "My Computer" button', async () => {
    const document = dom(`
      <fieldset>
        <h3>Resume</h3>
        <label for="resume-input">My Computer</label>
        <button type="button">Google Drive</button>
        <input id="resume-input" name="resumeFile" type="file" style="opacity:0" />
      </fieldset>
    `);

    const survey = await surveyUploadControls(document, false, ids);
    const resume = survey.controls.find((control) => control.kind === 'resume');

    expect(resume).toBeDefined();
    expect(resume!.input?.id).toBe('resume-input');
    // Hidden, and reachable anyway. A widget-driven input is populated
    // programmatically, so its visibility says nothing about whether it can be
    // filled — refusing those is what left "Resume *" unattached on a page that
    // plainly showed an upload button.
    expect(resume!.input).not.toBeNull();
    expect(survey.uploadLaunchers).toBeGreaterThan(0);
    // The Google Drive button is seen and deliberately not treated as a target.
    expect(survey.cloudLaunchers).toBeGreaterThan(0);
  });

  it('never treats a cloud-provider button as a local upload target', async () => {
    const document = dom(`
      <fieldset>
        <h3>Resume</h3>
        <button type="button" id="drive">Upload from Google Drive</button>
        <button type="button" id="dropbox">Dropbox</button>
        <button type="button" id="onedrive">OneDrive</button>
      </fieldset>
    `);

    const survey = await surveyUploadControls(document, true, ids);

    // "Upload from Google Drive" matches the upload pattern too. Excluding the
    // cloud providers *before* the launcher patterns run is what stops the
    // extension clicking one and sending the user to an OAuth consent screen
    // in the middle of an application.
    expect(survey.uploadLaunchers).toBe(0);
    expect(survey.cloudLaunchers).toBe(3);
    expect(survey.controls).toHaveLength(0);
  });

  it('waits for the file input a launcher inserts after it is pressed', async () => {
    const document = dom(`
      <fieldset>
        <h3>Resume</h3>
        <button type="button" id="launch">My Computer</button>
        <div id="target"></div>
      </fieldset>
    `);
    const launcher = document.getElementById('launch')!;
    launcher.addEventListener('click', () => {
      const view = document.defaultView!;
      view.setTimeout(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.name = 'resumeFile';
        document.getElementById('target')!.append(input);
      }, 20);
    });

    const created = await activateAndObserve(launcher, document, 1_000);
    expect(created).not.toBeNull();
    expect(created!.name).toBe('resumeFile');
  });

  it('reports a launcher it cannot resolve rather than claiming the page has no uploads', async () => {
    const document = dom(`
      <fieldset>
        <h3>Resume</h3>
        <button type="button" id="launch">My Computer</button>
      </fieldset>
    `);

    const survey = await surveyUploadControls(document, false, ids);
    const control = survey.controls.find((candidate) => candidate.kind === 'resume');

    // The distinction the user needs: "found, not reachable" is a different
    // problem from "this page has no upload control", and reporting the second
    // for the first is what made the original bug report say the extension was
    // blind to buttons that were plainly on screen.
    expect(control).toBeDefined();
    expect(control!.discovery).toBe('launcher_unresolved');
    expect(control!.input).toBeNull();
    expect(survey.uploadLaunchers).toBe(1);
  });

  it('does not activate a launcher when activation was not authorized', async () => {
    const document = dom(`
      <fieldset>
        <h3>Resume</h3>
        <button type="button" id="launch">My Computer</button>
      </fieldset>
    `);
    let clicked = false;
    document.getElementById('launch')!.addEventListener('click', () => {
      clicked = true;
    });

    await surveyUploadControls(document, false, ids);
    expect(clicked).toBe(false);
  });

  it('classifies each section from its own words before the page around it', async () => {
    const document = dom(`
      <fieldset><h3>Resume</h3><label for="a">My Computer</label>
        <input id="a" name="resumeFile" type="file" /></fieldset>
      <fieldset><h3>Cover Letter</h3><label for="b">My Computer</label>
        <input id="b" name="coverLetterFile" type="file" /></fieldset>
      <fieldset><h3>Transcript</h3><label for="c">My Computer</label>
        <input id="c" name="transcriptFile" type="file" /></fieldset>
      <fieldset><h3>Work Samples</h3><label for="d">My Computer</label>
        <input id="d" name="workSamplesFile" type="file" /></fieldset>
    `);

    const survey = await surveyUploadControls(document, false, ids);
    const kindOf = (elementId: string): string | undefined =>
      survey.controls.find((control) => control.input?.id === elementId)?.kind;

    expect(kindOf('a')).toBe('resume');
    expect(kindOf('b')).toBe('cover_letter');
    // Never ours, however the run goes.
    expect(kindOf('c')).toBe('unrelated');
    expect(kindOf('d')).toBe('unrelated');
  });

  it('finds a file input inside an open shadow root', async () => {
    const document = dom(`<div id="host"></div>`);
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<h3>Resume</h3><input id="shadow-resume" name="resumeFile" type="file" />`;

    const survey = await surveyUploadControls(document, false, ids);
    expect(survey.fileInputs).toBe(1);
    expect(survey.controls.some((control) => control.kind === 'resume')).toBe(true);
  });

  it('resolves a launcher through aria-controls as well as label[for]', () => {
    const document = dom(`
      <fieldset>
        <h3>Resume</h3>
        <div role="button" id="launch" aria-controls="hidden-resume">Browse</div>
        <input id="hidden-resume" name="resumeFile" type="file" />
      </fieldset>
    `);

    const resolved = resolveLauncherInput(document.getElementById('launch')!, document);
    expect(resolved?.input.id).toBe('hidden-resume');
    expect(resolved?.discovery).toBe('launcher_linked');
  });

  it('refuses to treat a submit control as an upload launcher', async () => {
    const document = dom(`
      <fieldset>
        <h3>Resume</h3>
        <button type="submit" id="submit">Submit Application</button>
      </fieldset>
    `);
    let clicked = false;
    document.getElementById('submit')!.addEventListener('click', () => {
      clicked = true;
    });

    const survey = await surveyUploadControls(document, true, ids);
    // Structural, not aspirational: "Submit" matches no launcher pattern and is
    // additionally excluded by name, so there is no route from this module to a
    // final submit.
    expect(survey.uploadLaunchers).toBe(0);
    expect(clicked).toBe(false);
  });
});
