# Document attachment diagnostic

Scope: tailored résumé and cover letter only — generation → transfer → extension storage →
employer file input → DOM verification. Nothing else was investigated or changed.

## The flow as it existed

| Stage                | Where                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Résumé bytes created | `Internship-AI/src/lib/documents/generate.ts` → Typst compile → `data/jobs/<id>/resume-vN.pdf`, row in `GeneratedDocument`                                                                 |
| Cover letter bytes   | same function → `cover-letter-vN.pdf`, second `GeneratedDocument` row                                                                                                                      |
| Filename / MIME      | no filename is stored; one is invented **at handoff time** by `applyWithAgent.ts::filenameFor` (`Resume-<company>-<title>.pdf`). MIME is always `application/pdf`                          |
| Transfer attempt     | only on "Apply with Application Agent": `applyWithApplicationAgent` → `sendApplicationBundle` → `window.postMessage` → `extension/src/content/bundleBridge.ts` → `SAVE_APPLICATION_BUNDLE` |
| Extension storage    | IndexedDB `internship-agent-bundles` (`extension/src/storage/bundleStore.ts`), bundle row + blob per document                                                                              |
| Retrieval at fill    | `bundleForUrl(url)` in `bundleStore.ts`, then `attachBundleDocuments` in `extension/src/uploads/bundleUploads.ts`                                                                          |
| Employer file input  | `attachApprovedFile` in `extension/src/executor/domExecutor.ts` (`DataTransfer` → `element.files`)                                                                                         |
| Agent server         | has `/documents` (manual library) — **nothing ever registered a tailored document there**                                                                                                  |

## Exact original document-transfer failure

Tailored documents only ever reached the extension, never the agent server, and only as part of
a bundle **keyed to `officialApplicationUrl`**. Retrieval is `bundleForUrl(url)`, which matches
the current tab by posting path, then by portal-journey origin. When the source button redirects
through Jobright, the employer tab lands on a URL whose path does not match the posting and whose
origin does not match the journey origin, so `bundleForUrl` returns `null`. The bundle bytes were
still in IndexedDB; nothing could find them. The popup then rendered
`AutofillPanel.tsx:349` — "No application loaded from Internship Pilot, so no tailored résumé or
cover letter is …" — and every upload was disarmed.

Secondary: generating documents alone transferred nothing. If the user generated documents and
never pressed "Apply with Application Agent" in that same tab session, the extension had no copy
at all. There were no latest-document pointers anywhere, and no document endpoints on the agent
server that a tailored file could be written to.

## Exact original upload-executor failure

1. There was no document-only path. Attaching a file was possible only as an `upload_file` action
   inside a full deterministic fill plan produced by a complete page scan.
2. `attachBundleDocuments` rewrote every résumé/cover-letter upload action to
   `missing_information` whenever `bundleForUrl` returned nothing — the exact case above — and
   deliberately dropped `documentId`/`documentName`. So the executor was handed nothing to attach.
3. `uploadFields()` filters `field.visible`, so a hidden `input[type=file]` driven by a styled
   "Upload résumé" button (the standard iCIMS/Greenhouse/Lever control) was never treated as an
   upload slot at all — even though `executeDomAction` has an explicit carve-out that would have
   accepted it.
4. `uploadAction` emits `approved: false, requiresReview: true`, and `executeDomAction` refuses
   unapproved actions, so even a matched bundle needed a separate approval step before any file
   moved.

## What was built

- One versioned record, `latestDocumentRecordSchema` (`shared/schemas/latestDocuments.ts`).
- Agent-server `latest_documents` table (migration 7) + authenticated
  `POST/GET /documents/latest`, `GET /documents/latest/:id/content`; bytes go through the existing
  `DocumentStorage` and `resolveInsideRoot`. Checksum (SHA-256) and byte length verified on write.
- Internship Pilot delivers each freshly generated PDF to the agent server and waits for the ack
  (`Internship-AI/src/lib/documents/agentDelivery.ts`, called from `generateDocumentsForJob`).
- Extension mirrors the latest records into IndexedDB `internship-agent-documents`, re-downloading
  only when the server record id changed, verifying checksum and byte length.
- A document-only command, `ATTACH_DOCUMENTS`, that scans **file inputs only**, classifies them
  deterministically, attaches, and verifies against observed DOM state. No AI call, no text fields,
  no submit control ever touched.
