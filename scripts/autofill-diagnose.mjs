#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The autofill diagnosis, taken from a real run of the built extension.
 *
 * This deliberately does not simulate the pipeline. It drives the acceptance
 * spec — popup click, service worker, content script, scanner, planner,
 * executor, verifier — collects the evidence that run wrote, and renders it.
 * A diagnosis assembled any other way describes the source rather than the
 * thing the browser is running, and the failure this repository is recovering
 * from was precisely a gap between those two.
 *
 *   node scripts/autofill-diagnose.mjs           run, then report
 *   node scripts/autofill-diagnose.mjs --render  report on the last run only
 *
 * Exit code is non-zero when no evidence could be produced.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(ROOT, 'local-data', 'autofill-run-evidence.json');
const REPORT = join(ROOT, 'AUTOFILL_RUN_DIAGNOSTIC.md');
const SPEC = 'tests/e2e/autofill-acceptance.spec.ts';

const renderOnly = process.argv.includes('--render');

function runAcceptance() {
  console.log(`Running ${SPEC} against extension/dist…\n`);
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['playwright', 'test', SPEC, '--reporter=line'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  return result.status ?? 1;
}

function ms(value) {
  return `${Math.round(value)} ms`;
}

/** Total duration of every stage with this name, across every pass. */
function stageTotal(trace, stage) {
  return trace.stages
    .filter((entry) => entry.stage === stage)
    .reduce((total, entry) => total + entry.durationMs, 0);
}

function render(evidence) {
  const { report, trace } = evidence;
  const verified = report.results.filter((result) => result.verification === 'verified');
  const optional = report.results.filter((result) => result.verification === 'optional_left_blank');
  const failed = report.results.filter((result) => result.verification === 'failed');
  const outstanding = report.requiredFields.filter(
    (verdict) => verdict.outcome !== 'FILLED_VERIFIED',
  );

  const lines = [];
  const say = (line = '') => lines.push(line);

  say('# Autofill run diagnostic');
  say();
  say(`Collected ${evidence.collectedAt} from a single click on the built extension.`);
  say();
  say('## Runtime identity');
  say();
  say('| Component | Build id |');
  say('| --------- | -------- |');
  for (const [component, id] of Object.entries(evidence.buildIds)) {
    say(`| ${component} | \`${id}\` |`);
  }
  say(`| run trace | \`${trace.buildId}\` |`);
  say();
  say('## What the page offered, and what became a question');
  say();
  say('| Measure | Value |');
  say('| ------- | ----- |');
  say(`| Raw controls matched | ${trace.rawControls} |`);
  say(`| Rejected as not questions | ${trace.falseControlsRemoved} |`);
  say(`| Collapsed as duplicates | ${trace.duplicateControlsRemoved} |`);
  say(`| Normalized questions | ${trace.normalizedQuestions} |`);
  say(`| Required questions | ${trace.requiredQuestions} |`);
  say(`| Filled and verified | ${verified.length} |`);
  say(`| Correctly left blank (optional) | ${optional.length} |`);
  say(`| Needing the user | ${report.userInputRequired} |`);
  say(`| Failed execution | ${failed.length} |`);
  say(
    `| Actions rejected by the contract | ${trace.fields.filter((f) => f.contractResult === 'rejected').length} |`,
  );
  say(`| Documents attached | ${report.documentsAttached} |`);
  say(`| Passes | ${report.iterations} |`);
  say();
  say('## Timing');
  say();
  say('| Stage | Duration |');
  say('| ----- | -------- |');
  say(`| Scan | ${ms(stageTotal(trace, 'scan'))} |`);
  say(`| Plan (deterministic) | ${ms(stageTotal(trace, 'plan'))} |`);
  say(`| Execute and verify (deterministic) | ${ms(stageTotal(trace, 'execute'))} |`);
  say(`| Analysis (one batched request) | ${ms(stageTotal(trace, 'analyze'))} |`);
  say(`| Execute and verify (analyzed) | ${ms(stageTotal(trace, 'execute_ai'))} |`);
  say(`| First saved value visible on the page | ${ms(evidence.firstFieldMs)} |`);
  say(`| Whole run, click to terminal state | ${ms(evidence.wallClockMs)} |`);
  say(`| Analysis requests | ${trace.aiRequests} |`);
  say(`| Dependent controls re-read | ${trace.dependentFieldsRescanned} |`);
  say();
  say('## The bundle handoff');
  say();
  say(`- Company: ${evidence.bundle.company}`);
  say(`- Job title: ${evidence.bundle.jobTitle}`);
  say(
    `- Tailored résumé: expected \`${evidence.bundle.resumeFilename}\`, attached \`${evidence.uploaded.resume || '(none)'}\``,
  );
  say(
    `- Tailored cover letter: expected \`${evidence.bundle.coverLetterFilename}\`, attached \`${evidence.uploaded.coverLetter || '(none)'}\``,
  );
  say();
  say('## Outstanding, and why');
  say();
  if (outstanding.length === 0) {
    say('Nothing was left outstanding.');
  } else {
    for (const verdict of outstanding) {
      say(`- **${verdict.label}** — ${verdict.outcome}: ${verdict.reason}`);
    }
  }
  say();
  say('## Submission');
  say();
  say(`- Submission prevented: ${report.submissionPrevented}`);
  say(`- The fixture recorded no submit event.`);
  say();

  return lines.join('\n');
}

async function main() {
  if (!renderOnly) {
    const status = runAcceptance();
    if (status !== 0) {
      console.error(
        '\nThe acceptance run did not pass. The evidence below, if any, is from that run.\n',
      );
      process.exitCode = status;
    }
  }

  const raw = await readFile(EVIDENCE, 'utf8').catch(() => null);
  if (raw === null) {
    console.error(
      `No run evidence at ${EVIDENCE}. Run "npm run test:autofill:acceptance" first, ` +
        'or drop --render so this command collects it.',
    );
    process.exitCode = 1;
    return;
  }

  const markdown = render(JSON.parse(raw));
  await writeFile(REPORT, `${markdown}\n`, 'utf8');
  console.log(markdown);
  console.log(`\nWritten to ${REPORT}`);
}

await main();
