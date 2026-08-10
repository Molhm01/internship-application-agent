# Repeater Engine Audit

Why an applicant with three jobs submitted one, and what was actually missing.

## The short answer

Every part of the repeater machinery existed and worked. None of it was reachable from the
button the user presses.

`runApplicationAutofill` accepts an **optional** dependency called `growRepeatedSections`
(`extension/src/autofill/orchestrator.ts:158`) and calls it on the first pass
(`orchestrator.ts:920`). The production caller — `runAutofill()` in
`extension/src/background/index.ts:1671` — supplies twenty-odd dependencies and **does not supply
that one**. The optional chaining at line 920 reads `dependencies.growRepeatedSections` as
`undefined`, the whole block is skipped without a warning, and the run proceeds against whatever
blocks the page happened to load with.

The only caller that ever passed it was a test
(`tests/extension/lincolnRepeaters.test.ts:215`). That test passes, and has passed the entire
time, which is why the gap survived: the engine was green in the suite and dead in the browser.

```
Autofill Application
  → background runAutofill()          ← growRepeatedSections not in the dependency object
  → runApplicationAutofill()
  → pass 1: if (dependencies.growRepeatedSections)   ← undefined, block skipped silently
  → scan → plan → execute             ← against 1 block, forever
```

## Trace of the current path

### Where the records are loaded

`experience[]` and `education[]` are read from the saved profile, which reaches the worker through
`getProfile()` / `bundleForUrl(url)` in `extension/src/background/index.ts`. Both arrays arrive
complete — nothing truncates them. `profileSchema` (`shared/schemas/profile.ts:304,315`) types them
as unbounded arrays, and `mergeProfiles` preserves every entry.

**All records are present in the runtime profile.** The loss happens later, and it is not a loss of
data — it is a loss of _destinations_.

### How blocks are recognised

`markRepeatedRecords` (`extension/src/scanner/domScanner.ts:1552`) numbers repeated blocks. It works
from an _anchor_ question — the one question a block of its kind cannot be without:

| Section    | Anchor questions (first present wins)            |
| ---------- | ------------------------------------------------ |
| experience | `employer`, `job_title`, `employment_start_date` |
| education  | `school`, `education_type`, `degree`, `major`    |
| projects   | `project_name`, `project_description`            |

For each anchor it walks up the DOM with `blockContainerFor` (`domScanner.ts:1515`) to the outermost
ancestor still holding exactly one anchor — that element _is_ the repeated block, whatever the vendor
wrapped it in. Every field inside the Nth block gets `recordIndex: N`.

Two guards matter, and both are correct:

- `if (anchors.length < 2) continue` (`domScanner.ts:1565`). One anchor is one block, so index 0 is
  left implicit. This is why a single-block page shows no `recordIndex` anywhere.
- Conditional children (`If other, enter School`) are skipped in the main loop so they cannot
  _consume_ a block slot, then inherit their parent's `recordIndex` at `domScanner.ts:1601`.

Downstream, `deterministicPlanner.ts:87` reads `profile.experience[field.recordIndex ?? 0]` and
`:105` reads `profile.education[field.recordIndex]`. `dropdownScanner.ts:170` computes its own
`recordIndexOf`.

**So block isolation was never the bug.** Given N blocks, the scanner numbers them and the planner
answers each from its own record. The engine was starved of blocks, not confused about them.

### How the Add controls are represented

The live application renders them as ordinary buttons carrying the section name:

```html
<fieldset id="experienceSection">
  <legend>Work Experience</legend>
  ...
  <button type="button">+ Add</button>
</fieldset>
```

`findAddControl` (`extension/src/content/repeatedSections.ts:72`) already identifies them. It scans
`button,[role="button"],a[href="#"],input[type="button"]`, requires `ADD_WORDS` (`add|another|+`),
rejects anything matching `submit` or `type="submit"`, and then requires `SECTION_WORDS[kind]` to
match — so the section must be _named_, and a bare `+ Add` is refused as ambiguous.

**This is the second, narrower defect.** The live form's control reads exactly `+ Add`. Its own text
names no section, so `SECTION_WORDS` never matches and `findAddControl` returns `null` — meaning even
once the dependency is wired, that button is not found. The section name is present in the DOM, but
in the `<legend>` above the button rather than in the button's own label, and `controlText()` reads
only `textContent`, `aria-label` and `title` of the control itself.

### Does the scanner deliberately exclude Add buttons?

Yes, and correctly. `shouldIgnore` in `domScanner.ts` drops non-answerable controls, and
`fieldFromElements` returns nothing for a button that carries no question. An Add button is not a
question, so it never becomes a `DetectedField`. It has to be found by the repeater engine's own
search, which is what `findAddControl` is for.

### Where record-index information is lost

Nowhere. It is never _created_, because with one block on the page `anchors.length < 2` holds and the
numbering loop is skipped by design. `recordIndex` stays `undefined`, and `?? 0` sends every field to
record 0. That is the correct reading of a one-block page — the page really does only have room for
one job.

### Exact reason additional records are ignored

Three findings, in the order they bite:

1. **`growRepeatedSections` is never supplied to the orchestrator by the production worker.**
   `extension/src/background/index.ts:1671` omits it; `orchestrator.ts:920` therefore skips block
   creation entirely. Add is never clicked because nothing ever asks for it to be clicked. This is
   the root cause.
2. **`findAddControl` cannot see a `+ Add` button that does not name its own section.** Section
   identity lives in the enclosing heading/legend, which the control-text check never reads. Even
   with (1) fixed, the live form's buttons stay invisible.
3. **`countRepeatedBlocks` returns 0 for a section whose only block is empty and whose questions the
   scanner did not classify.** It counts anchors, and an unclassified control has no `canonicalKey`,
   so a section can read as "no blocks" and `planRepeatedSection` then treats it as
   `SKIPPED_NO_PAGE_SECTION`.

## Counts observed

Against the live-style reproduction (`tests/fixtures/lab/repeater-master.html`):

| Section         | Profile records | Blocks initially found | Add control identity                                                                         |
| --------------- | --------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| Work Experience | 3               | 1                      | `<button type="button">+ Add</button>` inside `#experienceSection`, headed `WORK EXPERIENCE` |
| Education       | 2               | 1                      | `<button type="button">+ Add</button>` inside `#educationSection`, headed `EDUCATION`        |

Required: 2 Add presses for experience, 1 for education. Observed before this change: 0 and 0.

## Observed after the fix, on the built extension

From `local-data/repeater-run-evidence.json`, collected by
`tests/e2e/repeater-master.spec.ts` from one click on "Autofill Application":

| Section         | Records | Blocks before | Add clicks | Blocks after | Bound | Verified |
| --------------- | ------- | ------------- | ---------- | ------------ | ----- | -------- |
| Work Experience | 3       | 1             | 2          | 3            | 3     | 3        |
| Education       | 2       | 1             | 1          | 2            | 2     | 2        |

Second run against the same filled page: **0 Add clicks, 0 new blocks, 0 duplicates** in both
sections, every record reported `MATCHED_BY_VALUE`.

### A third defect, found by the second run rather than by reading

The first implementation of the binder matched a block to a record by comparing the _value_ in the
block's anchor control. That is sufficient for Work Experience, whose anchor is a text input the
executor fills. It is not sufficient for Education, whose anchor is the **School dropdown** — a
dependent control with no options at all until Country and then State have been answered.

A first run that grew the section but could not complete that chain leaves both education blocks
holding nothing. A second run then sees two _empty_ blocks, hands one to each record by the
empty-block rule, finds one record still unplaced, and presses Add — producing a third education
block on the second press of the same button. Observed exactly once, on the built extension, before
the fix.

The repair is that the binder now honours its own marks first: a block already carrying
`data-agent-record-index` belongs to that record regardless of what it contains, and value matching
is the fallback rather than the only rule. Covered by
`tests/extension/repeaterEngine.test.ts` → "adds nothing when the blocks it bound are still empty,
whatever their values".

## What was already correct and is being reused, not rebuilt

- `planRepeatedSection` / `markBlockCreationFailed` / `summariseMappings`
  (`shared/logic/repeatedSections.ts`) — the arithmetic, including the `MAX_BLOCKS` ceiling and the
  "never press for a record that does not exist" rule. Second-run dedup falls straight out of
  `addPresses = max(0, records − blocks)`.
- `markRepeatedRecords` + `countRepeatedBlocks` (`domScanner.ts`) — anchor-based block discovery and
  numbering.
- `deterministicPlanner` record selection by `recordIndex`.
- The Dropdown Autofill Engine (`extension/src/dropdown/`, `background/dropdownAcrossFrames.ts`),
  which already carries `recordIndex` on its descriptors and so drives the right menu in the right
  block once the block exists.

The new `extension/src/repeaters/` subsystem owns section identity, Add-control identity, observed
block creation, record binding, and the trace. It does not fill fields itself: text goes to the
existing executor and menus go to the existing Dropdown Engine, exactly as the brief requires.
