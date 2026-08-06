# Page execution diagnostic

Traced against the committed build (`734832a`, `BUILD_ID 734832a.s3.20260806014553`) before any
repair. Every claim below names the file and line in the built runtime that produces it.

## 1. The command path, as it actually runs

### "Attach Resume and Cover Letter"

| Step                 | File                                              | What happens                                                                  |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Popup click          | `extension/src/popup/useDocumentState.ts:84`      | sends `ATTACH_DOCUMENTS` to the worker                                        |
| Worker handler       | `extension/src/background/index.ts:1879`          | routes to `attachLatestDocuments`                                             |
| Tab resolution       | `extension/src/background/latestDocuments.ts:221` | `activeApplicationTab` → one `chrome.tabs.Tab`, **no frame enumeration**      |
| Content reachability | `extension/src/background/contentScript.ts:67`    | pings, and reinjects with `allFrames: false` (line 91)                        |
| Message to page      | `extension/src/background/latestDocuments.ts:246` | `chrome.tabs.sendMessage(tab.id, …)` with **no `frameId` option**             |
| Content handler      | `extension/src/content/index.ts:211`              | `runDocumentAttachment(document, …)` on that frame's `document` only          |
| Field discovery      | `extension/src/uploads/documentAttachment.ts:116` | `root.querySelectorAll('input[type="file"]')` — the entire discovery strategy |
| Attachment           | `extension/src/uploads/documentAttachment.ts:199` | `DataTransfer` → `input.files` → `input`/`change` → 3 s verification poll     |

### "Autofill Application"

`popup → background/index.ts:171 startScan → chrome.tabs.sendMessage(SCAN_APPLICATION)` (line 198)
→ `content/index.ts:383 → scanner/scanApplication.ts → scanner/domScanner.ts` →
`planner/deterministicPlanner.ts` → `background/index.ts:1387 EXECUTE_FILL_PLAN` →
`content/index.ts:269` → `executor/domExecutor.ts` → `verifier/domVerifier.ts`.

## 2. Findings

### Finding 1 — the content script only ever existed in the top frame

`extension/manifest.json` declared:

```json
{ "matches": ["http://*/*", "https://*/*"], "js": ["content.js"], "all_frames": false }
```

and the repair path in `background/contentScript.ts:91` reinjected with `allFrames: false` as well.
There is no `frameId` anywhere in `extension/src` — verified by grep; the only three matches in the
whole repository were `all_frames: false`, `allFrames: false`, and a test asserting `allFrames: false`.

**Consequence:** an upload widget rendered inside an iframe — which is how iCIMS, Workday and
SmartRecruiters render their document sections — is in a document the extension never had a script
in. `document.querySelectorAll('input[type="file"]')` in the top frame does not cross an iframe
boundary, so the count was legitimately zero.

### Finding 2 — discovery searched for file inputs and nothing else

`collectDocumentFileFields` (`uploads/documentAttachment.ts:115-141`) is a single
`querySelectorAll('input[type="file"]')`. It has no notion of:

- an upload **launcher** ("My Computer", "Upload", "Browse", "Choose File", "Attach"),
- a file input that the widget inserts into the DOM only after the launcher is activated,
- a file input inside a shadow root,
- a cloud-provider button that is _not_ a local-file target (Google Drive, Dropbox, OneDrive).

Hidden and off-screen inputs _were_ handled correctly (the function deliberately does not filter on
visibility) — that part was already right. What was missing is everything that is not an
`input[type=file]` node present at scan time.

**Consequence on the live page:** the visible "My Computer" buttons under Resume and Cover Letter
were invisible to the extension. Because the page also had no eagerly-rendered file input in the
frame that was scanned, `fields.length === 0`, and `attachRun.ts:99` emitted the literal sentence
_"This page has no file upload control."_ — which is what the user saw, next to four visible upload
buttons.

### Finding 3 — the 0.0 s elapsed time

`runDocumentAttachment` (`uploads/attachRun.ts:83-133`) records `startedAtMs`, calls
`collectDocumentFileFields`, then calls `attachOne` twice. `attachOne` returns `notFoundOutcome`
**immediately** when `field` is null (line 39-41) — before any `File` is constructed, before any
`DataTransfer`, before the 3-second verification poll. With zero discovered fields both documents
take that branch, so `now() - startedAtMs` rounds to 0.

**0.0 s was therefore not a crash and not a timeout. It is the precise signature of "the scan found
nothing, so nothing was attempted."** The run reported success-shaped output for a run that never
touched the page.

### Finding 4 — the message was broadcast, not routed

`chrome.tabs.sendMessage(tabId, message)` without a `frameId` option delivers to every frame that
has a listener and resolves with the **first** response. With `all_frames: false` there was only
ever one listener so this was invisible — but it means that simply flipping `all_frames` to `true`
without also routing by `frameId` would have replaced "always the top frame" with "whichever frame
answers first", which is worse. Both halves had to change together.

### Finding 5 — Legal First Name received option matching

`inferType` (`scanner/domScanner.ts:463-506`) tests `isCustomCombobox(element)` at line 471 —
**before** it ever asks whether the element is an `<input>` and what its `type` is (line 474).
`isCustomCombobox` (line 451-461) returns true for any element that:

- carries `role="combobox"` or `role="listbox"`, or
- matches `.select__control, [class*="react-select"] [class*="control"]`, or
- has a class matching `/css-[a-z0-9]+-control/`.

A live ATS autocomplete renders exactly that: `<input type="text" role="combobox" …>`. So a plain
text box was classified `combobox`, `ALLOWED_ACTIONS.combobox` in
`shared/logic/actionContract.ts:71` permits `select_option`, `contractViolation` therefore raised
nothing, and `optionMatcher.ts:319` produced `No option on the page matched "Molhm".`

The existing contract layer was working as designed. It was fed the wrong `fieldType`, and every
downstream guard trusts `fieldType` rather than the element. Nothing in the pipeline re-derived the
action from the real DOM node.

## 3. Answers to the specific questions asked

| Question                                            | Answer                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Does the command reach the content script?          | Yes — in the top frame only.                                                                          |
| Which tab ID is targeted?                           | `activeApplicationTab()`'s single tab; correct.                                                       |
| Which frame IDs are scanned?                        | None were ever identified. Effectively frame 0 by accident of injection.                              |
| File inputs per frame?                              | Never counted per frame; one flat count for the top document (`fileFieldsSeen`).                      |
| Upload launcher buttons?                            | Never looked for at all.                                                                              |
| Are hidden inputs excluded?                         | No — hidden inputs were already included. This was not a cause.                                       |
| Inputs created after clicking "My Computer"?        | Never observed; no launcher was ever activated and no `MutationObserver` existed.                     |
| Do scan results lose their frame ID?                | There was no frame ID to lose. `detectedFieldSchema` had no such field.                               |
| Are executor messages sent back to the right frame? | No. Every send was a whole-tab broadcast.                                                             |
| Why 0.0 s?                                          | Zero discovered fields → both `attachOne` calls short-circuit before constructing a `File`.           |
| Why did Legal First Name get option matching?       | `inferType` ran the custom-combobox check before the `<input type>` check, so it returned `combobox`. |

## 4. Root causes, in the order they were repaired

1. `all_frames: false` and `allFrames: false` — the extension had no presence in subframes.
2. No frame identity anywhere in the scan, plan, or execution path.
3. Upload discovery limited to `input[type=file]` nodes existing at scan time.
4. `inferType` derived control type from ARIA/CSS ahead of the DOM node's own type.
5. A run that discovers nothing reports as if it had run, with no assertion that visible upload
   controls imply a discoverable target.
