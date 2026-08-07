/**
 * Every failure surfaced to the user must carry one of these codes plus a
 * human-readable message and a suggested action. Generic "something went wrong"
 * messages are not acceptable anywhere in this product.
 */

/**
 * The one instruction for a page whose content script cannot be reached.
 *
 * Shared, and used verbatim in three places — the worker's error, the popup's
 * page panel, and the reinjection fallback — because a user who sees three
 * different sentences for one condition concludes there are three problems.
 * Reloading the *page* is the fix; reloading or reinstalling the extension is
 * not, and saying so cost real time.
 */
export const RECONNECT_MESSAGE = 'Reload this application page to reconnect the extension.';

export const ERROR_CODES = [
  'AGENT_SERVER_UNAVAILABLE',
  'OLLAMA_UNAVAILABLE',
  'OLLAMA_TIMEOUT',
  'INVALID_MODEL_RESPONSE',
  'AI_DISABLED',
  'AI_SETTINGS_INVALID',
  'MODEL_NOT_CONFIGURED',
  'MODEL_NOT_FOUND',
  'SERVER_AUTH_FAILED',
  'SERVER_REQUEST_FAILED',
  'GENERATION_TIMEOUT',
  'GENERATION_CANCELLED',
  'INVALID_MODEL_OUTPUT',
  'OUTPUT_SCHEMA_INVALID',
  'INSUFFICIENT_EVIDENCE',
  'UNSUPPORTED_QUESTION',
  'PROHIBITED_QUESTION',
  'PROMPT_INJECTION_DETECTED',
  'ANSWER_NOT_GROUNDED',
  'ANSWER_LIMIT_EXCEEDED',
  'ANSWER_EMPTY',
  'CONTEXT_TOO_LARGE',
  'RESUME_EXTRACTION_FAILED',
  'FIELD_CHANGED',
  'ANSWER_NOT_APPROVED',
  'ANSWER_FILL_FAILED',
  'ANSWER_VERIFICATION_FAILED',
  'GENERATED_ACTION_NOT_IN_PLAN',
  'GENERATED_ACTION_NOT_APPROVED',
  'GENERATED_ACTION_NOT_VALIDATED',
  'GENERATED_FIELD_NOT_FOUND',
  'GENERATED_FIELD_CHANGED',
  'GENERATED_VALUE_NOT_VERIFIED',
  'STALE_FILL_PLAN',
  'UNSUPPORTED_GENERATED_FIELD',
  'PROFILE_MISSING',
  'DOCUMENT_MISSING',
  'ATS_UNSUPPORTED',
  'FIELD_NOT_FOUND',
  'FIELD_NOT_VISIBLE',
  'FIELD_MISMATCH',
  'FIELD_DISABLED',
  'OPTION_NOT_FOUND',
  // Live option discovery and selection. Each names a distinct stage, so a
  // failed dropdown says which step it failed at instead of disappearing.
  'CONTROL_NOT_FOUND',
  'CONTROL_NOT_VISIBLE',
  'CONTROL_DISABLED',
  'LISTBOX_NOT_FOUND',
  'OPTIONS_NOT_DISCOVERED',
  'NO_OPTION_MATCH',
  'AMBIGUOUS_OPTION_MATCH',
  'OPTION_NOT_SELECTABLE',
  'OPTION_SELECTION_REVERTED',
  'OPTION_VALUE_NOT_VERIFIED',
  // A control whose choices another control produces — State after Country —
  // that never received them. Distinct from `OPTIONS_NOT_DISCOVERED`, which is
  // a list that opened and was empty: this one was never populated at all.
  'STATE_OPTIONS_NOT_POPULATED',
  // The universal dropdown engine's own stages. Every one of these used to be
  // the same red "Autofill failed" badge, which named no stage and suggested no
  // repair — the reason a State control that simply had not been repopulated
  // yet was indistinguishable from a page the agent could not drive at all.
  'DROPDOWN_OPEN_FAILED',
  'DROPDOWN_NO_OPTIONS_FOUND',
  'NO_SEMANTIC_OPTION_MATCH',
  'OPTION_DISABLED',
  'OPTION_CLICK_FAILED',
  'SELECTION_NOT_ACCEPTED',
  'DEPENDENT_CONTROL_NOT_REFRESHED',
  // Not a dropdown failure at all: nobody knows the answer. Carried as a code so
  // the difference between "the page would not take it" and "you have to answer
  // this one" survives all the way to the badge.
  'ANSWER_UNKNOWN',
  // A conditional control whose parent question does not currently activate it.
  // Not a failure: the question does not apply yet, and stating an answer to it
  // anyway is what put the applicant's own name in a relatives-detail box.
  'PARENT_ANSWER_REQUIRED',
  'LOCATION_NOT_FOUND',
  'LOCATION_AMBIGUOUS',
  'PHONE_COUNTRY_CODE_NOT_FOUND',
  'PROTECTED_POLICY_MISSING',
  'VALUE_NOT_VERIFIED',
  'ACTION_NOT_APPROVED',
  'SENSITIVE_REVIEW_REQUIRED',
  'UNSUPPORTED_CONTROL',
  'EXECUTION_CANCELLED',
  'INVALID_FILL_PLAN',
  'FILL_TIMEOUT',
  'UPLOAD_FAILED',
  'IFRAME_INACCESSIBLE',
  'PAGE_CHANGED',
  'PERMISSION_DENIED',
  'REVIEW_REQUIRED',
  /**
   * The background service worker did not answer, or answered with something
   * that is not a valid result. In practice this means the worker in the browser
   * is from an older build than the page asking it — Chrome resolves
   * `sendMessage` with `undefined` when no listener handles a message type.
   */
  'EXTENSION_RELOAD_REQUIRED',
  /**
   * The popup, the worker, and the content script are not from the same build.
   *
   * Distinct from `EXTENSION_RELOAD_REQUIRED`, which means a component did not
   * answer at all. This one means every component answered and they disagree —
   * the failure that produced a run against a bundle two commits behind its own
   * source, with a green test suite and no way to see it from inside the
   * browser. A mixed-version run is refused rather than attempted.
   */
  'BUILD_MISMATCH',
  /**
   * A diagnostic was asked for before there was anything to diagnose.
   *
   * Its own code rather than a generic failure: "nothing has run yet" and "the
   * trace could not be read" have the same shape and opposite remedies, and
   * telling someone chasing a fill bug to reload the extension when they simply
   * have not clicked the button yet sends them down the wrong path.
   */
  'NO_RUN_RECORDED',
  'ACTIVE_TAB_UNAVAILABLE',
  'CONTENT_SCRIPT_UNAVAILABLE',
  'UNSUPPORTED_PAGE',
  'ATS_DETECTION_FAILED',
  'SCAN_TIMEOUT',
  'SCAN_CANCELLED',
  'INVALID_SCAN_RESULT',
  'PAGE_CHANGED_DURING_SCAN',
  'BACKGROUND_WORKER_UNAVAILABLE',
  // One-button application autofill.
  'AUTOFILL_DISABLED',
  'AUTOFILL_CANCELLED',
  'SCAN_FAILED',
  'RESOLUTION_FAILED',
  'CAPTCHA_DETECTED',
  'MFA_DETECTED',
  'FINAL_SUBMISSION_STAGE',
  'MAX_ITERATIONS_REACHED',
  // Website → extension application-bundle handoff.
  'BUNDLE_MISSING',
  'BUNDLE_REJECTED',
  'BUNDLE_STORAGE_FAILED',
  'BUNDLE_DOCUMENT_MISSING',
  // Document-only attachment: the newest tailored résumé and cover letter.
  'LATEST_DOCUMENT_MISSING',
  'DOCUMENT_SYNC_FAILED',
  'DOCUMENT_ATTACHMENT_FAILED',
  // Batched page-level form analysis.
  'ANALYSIS_FAILED',
  'ANALYSIS_REJECTED',
  // Transport / server-side codes used by the local agent server.
  'UNAUTHORIZED',
  'ORIGIN_REJECTED',
  'RATE_LIMITED',
  'REQUEST_TOO_LARGE',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Default guidance shown when a caller does not supply a more specific
 * suggested action. Kept here so the popup, options page, and server agree.
 */
export const DEFAULT_ERROR_GUIDANCE: Record<ErrorCode, string> = {
  AGENT_SERVER_UNAVAILABLE:
    'Start the local agent server with `npm run dev:server`, then retry from the popup.',
  OLLAMA_UNAVAILABLE:
    'Start Ollama (`ollama serve`) and confirm it is listening on 127.0.0.1:11434.',
  OLLAMA_TIMEOUT:
    'The model took too long to respond. Try a smaller model or raise the timeout in settings.',
  INVALID_MODEL_RESPONSE:
    'The model returned data that failed schema validation. Retry, or switch to a model that follows JSON instructions.',
  AI_DISABLED: 'Enable local AI answer generation in extension settings, then retry.',
  AI_SETTINGS_INVALID:
    'Open AI settings, confirm the generation configuration, save it, and retry.',
  MODEL_NOT_CONFIGURED: 'Select an installed Ollama model in AI settings, then retry.',
  MODEL_NOT_FOUND:
    'Install the selected model with `ollama pull <model>`, or choose an installed model.',
  SERVER_AUTH_FAILED:
    'Copy the current local agent token into extension settings, save, and retry.',
  SERVER_REQUEST_FAILED:
    'Confirm the local agent server is running and that the extension and server builds match.',
  GENERATION_TIMEOUT:
    'Try again, choose a smaller local model, or increase the generation timeout.',
  GENERATION_CANCELLED: 'Start generation again when you are ready.',
  INVALID_MODEL_OUTPUT:
    'The local model returned unusable output. Retry or choose a model that follows JSON instructions.',
  OUTPUT_SCHEMA_INVALID:
    'The model response did not match the required answer schema and was not used.',
  INSUFFICIENT_EVIDENCE: 'Add the missing facts in review, then regenerate the answer.',
  UNSUPPORTED_QUESTION: 'Answer this question manually or mark it leave blank.',
  PROHIBITED_QUESTION: 'Answer this sensitive or legally binding question manually.',
  PROMPT_INJECTION_DETECTED:
    'Review the question and posting. Suspicious page instructions were treated only as untrusted text.',
  ANSWER_NOT_GROUNDED:
    'Edit the answer to use only displayed evidence, add evidence, or regenerate it.',
  ANSWER_LIMIT_EXCEEDED: 'Shorten the answer until it fits the detected field limit.',
  ANSWER_EMPTY: 'Enter an answer or regenerate before approval.',
  CONTEXT_TOO_LARGE: 'Reduce the added evidence or use a smaller selected resume section.',
  RESUME_EXTRACTION_FAILED:
    'Re-extract the resume, choose a supported PDF, DOCX, or TXT file, or continue with profile evidence.',
  FIELD_CHANGED: 'Re-analyze the application because the custom-answer field changed.',
  ANSWER_NOT_APPROVED: 'Review and explicitly approve the generated or edited answer first.',
  ANSWER_FILL_FAILED: 'Insert this answer manually and review the page validation message.',
  ANSWER_VERIFICATION_FAILED:
    'The page did not retain the generated answer. Review and insert it manually.',
  GENERATED_ACTION_NOT_IN_PLAN:
    'Return to review so the approved answer can be reattached to the current fill plan.',
  GENERATED_ACTION_NOT_APPROVED:
    'Return to review and explicitly approve the generated answer before filling.',
  GENERATED_ACTION_NOT_VALIDATED:
    'Review or regenerate the answer until validation passes, then approve it again.',
  GENERATED_FIELD_NOT_FOUND:
    'Re-analyze the application because the generated-answer field is no longer present.',
  GENERATED_FIELD_CHANGED:
    'Re-analyze the application because the generated-answer field changed after scanning.',
  GENERATED_VALUE_NOT_VERIFIED:
    'The page did not retain the generated answer. Review the field and insert it manually.',
  STALE_FILL_PLAN: 'Re-analyze the application and rebuild the fill plan before filling.',
  UNSUPPORTED_GENERATED_FIELD:
    'This generated-answer control cannot be filled safely; enter the reviewed answer manually.',
  PROFILE_MISSING:
    'Open the extension settings and complete your profile before analyzing an application.',
  DOCUMENT_MISSING:
    'Register the document in settings, or pick a different resume for this application.',
  ATS_UNSUPPORTED:
    'This applicant tracking system has no dedicated adapter yet. The generic scanner may still work.',
  FIELD_NOT_FOUND: 'The field is no longer on the page. Re-analyze the application and try again.',
  FIELD_NOT_VISIBLE: 'Scroll the field into view or expand its section, then retry this field.',
  FIELD_MISMATCH:
    'The field no longer matches the scan. Re-analyze the application before filling.',
  FIELD_DISABLED: 'Enable this field manually, or complete the prerequisite question first.',
  OPTION_NOT_FOUND:
    'None of the dropdown options matched. Choose an option manually in the review screen.',
  VALUE_NOT_VERIFIED: 'The page did not keep the value that was entered. Fill this field manually.',
  ACTION_NOT_APPROVED: 'Review and approve this action before trying to fill it.',
  SENSITIVE_REVIEW_REQUIRED:
    'Review this sensitive answer and approve it explicitly, or leave it blank.',
  UNSUPPORTED_CONTROL: 'Fill this control manually. Its browser behavior is not safely supported.',
  CONTROL_NOT_FOUND:
    'The control is no longer on the page. Re-analyze the application and try again.',
  CONTROL_NOT_VISIBLE:
    'The control is hidden. Scroll to it or open the section that contains it, then retry.',
  CONTROL_DISABLED: 'The control is disabled. Complete whatever unlocks it, then retry.',
  LISTBOX_NOT_FOUND:
    'The option list never opened, so no choices could be read. Open it yourself and pick a value.',
  OPTIONS_NOT_DISCOVERED:
    'The list opened but offered no choices. It may still be loading — retry, or choose a value yourself.',
  NO_OPTION_MATCH:
    'None of the choices on this control correspond to your saved answer. Pick the right one yourself.',
  AMBIGUOUS_OPTION_MATCH:
    'Several choices matched your saved answer equally. Choose the correct one yourself.',
  OPTION_NOT_SELECTABLE:
    'The matching choice could not be selected. Select it yourself and continue.',
  OPTION_SELECTION_REVERTED:
    'The page discarded the selection after it was made. Select it yourself and check it stays.',
  OPTION_VALUE_NOT_VERIFIED:
    'The control does not show the choice that was selected. Check its current value.',
  STATE_OPTIONS_NOT_POPULATED:
    'The country was set, but this control never produced its list of states or provinces. Choose one yourself.',
  DROPDOWN_OPEN_FAILED:
    'This dropdown did not open for a click, a keypress, or typing. Open it yourself and choose a value.',
  DROPDOWN_NO_OPTIONS_FOUND:
    'The dropdown opened and offered nothing to choose. It may still be loading — retry, or choose a value yourself.',
  NO_SEMANTIC_OPTION_MATCH:
    'No choice on this control is defensibly equivalent to your saved answer, and one is never guessed for you. Choose it yourself.',
  OPTION_DISABLED:
    'The right choice is on the list and the page will not let it be selected. Complete whatever unlocks it, then retry.',
  OPTION_CLICK_FAILED:
    'The choice disappeared from the list before it could be clicked. Retry, or select it yourself.',
  SELECTION_NOT_ACCEPTED:
    'The choice was clicked and the control never took it. Select it yourself and check it stays.',
  DEPENDENT_CONTROL_NOT_REFRESHED:
    'This control still has no choices, because the field it depends on has not populated it yet. Retry once that field is set.',
  ANSWER_UNKNOWN:
    'Nothing saved answers this question, so nothing was selected. Answer it yourself, or save the fact in your profile and retry.',
  PARENT_ANSWER_REQUIRED:
    'This only applies when the question above it is answered a particular way. Answer that one first, or leave this blank.',
  LOCATION_NOT_FOUND:
    'This list offers no location matching your saved city, state, and country. Choose one yourself.',
  LOCATION_AMBIGUOUS:
    'Several locations matched your saved address equally. Choose the correct one yourself.',
  PHONE_COUNTRY_CODE_NOT_FOUND:
    'No dialling code on this control matches your saved country. Select it yourself.',
  PROTECTED_POLICY_MISSING:
    'This question is never answered without an explicit saved policy. Set one in settings, or answer it yourself.',
  EXECUTION_CANCELLED: 'Return to the fill plan and start a new fill run when ready.',
  INVALID_FILL_PLAN: 'Rebuild the fill plan from a fresh application scan.',
  FILL_TIMEOUT:
    'The page did not finish filling in time. Review its current values and retry safely.',
  UPLOAD_FAILED: 'Attach the document manually and confirm the filename appears on the page.',
  IFRAME_INACCESSIBLE:
    'Part of this application is in a cross-origin frame that extensions cannot read. Fill that section manually.',
  PAGE_CHANGED: 'The application page changed during the run. Re-analyze before filling.',
  PERMISSION_DENIED:
    'Grant the extension access to this site from chrome://extensions, then retry.',
  REVIEW_REQUIRED: 'This answer needs your approval before it can be filled.',
  EXTENSION_RELOAD_REQUIRED:
    'Open chrome://extensions, press Reload on Internship Application Agent, then reopen this page. The background worker is out of date.',
  BUILD_MISMATCH:
    'Open chrome://extensions, press Reload on Internship Application Agent, then reload this page so every part of the extension comes from the same build.',
  NO_RUN_RECORDED: 'Run autofill on an application page first, then export the trace of that run.',
  ACTIVE_TAB_UNAVAILABLE: 'Open an HTTP or HTTPS application page, then try the scan again.',
  CONTENT_SCRIPT_UNAVAILABLE: RECONNECT_MESSAGE,
  UNSUPPORTED_PAGE: 'Open a normal HTTP or HTTPS job application page and retry.',
  ATS_DETECTION_FAILED:
    'Reload the page and retry. The generic scanner will be used when no named ATS matches.',
  SCAN_TIMEOUT: 'Reload the application page and retry the scan.',
  SCAN_CANCELLED: 'Start a new scan whenever you are ready.',
  INVALID_SCAN_RESULT:
    'Reload the extension and application page, then retry so both use the same schema.',
  PAGE_CHANGED_DURING_SCAN:
    'Return to the application step you want to inspect and start a new scan.',
  BACKGROUND_WORKER_UNAVAILABLE:
    'Reload the extension from chrome://extensions, reopen the application page, and retry.',
  AUTOFILL_DISABLED: 'Turn application autofill back on in extension settings, then retry.',
  AUTOFILL_CANCELLED: 'Start autofill again when you are ready.',
  SCAN_FAILED:
    'Reload the application page, wait until the form is visible, then run autofill again.',
  RESOLUTION_FAILED:
    'Open extension settings and confirm your profile and saved answers loaded, then retry.',
  CAPTCHA_DETECTED: 'Solve the CAPTCHA yourself, then run autofill again.',
  MFA_DETECTED: 'Enter the verification code yourself, then run autofill again.',
  FINAL_SUBMISSION_STAGE:
    'This is the final submission step. Review every answer and submit it yourself.',
  MAX_ITERATIONS_REACHED:
    'The form kept revealing new questions. Run autofill again to continue from where it stopped.',
  BUNDLE_MISSING:
    'Open the job on Internship Pilot and click "Apply with Application Agent" to send the tailored documents to the extension.',
  BUNDLE_REJECTED:
    'The application bundle failed validation and was not stored. Regenerate the tailored documents and try again.',
  BUNDLE_STORAGE_FAILED:
    'The extension could not save the application bundle. Reload the extension and try again.',
  BUNDLE_DOCUMENT_MISSING:
    'A tailored document is missing from the saved bundle. Send it again from Internship Pilot.',
  LATEST_DOCUMENT_MISSING:
    'Generate a tailored résumé or cover letter on Internship Pilot, then press Refresh Documents.',
  DOCUMENT_SYNC_FAILED:
    'The extension could not copy the latest documents from the agent server. Check that the server is running, then press Refresh Documents.',
  DOCUMENT_ATTACHMENT_FAILED:
    'The document could not be attached to this page. Attach it yourself before continuing.',
  ANALYSIS_FAILED:
    'The local model could not analyze this page. Retry, or fill the highlighted fields yourself.',
  ANALYSIS_REJECTED:
    'The model returned an unusable answer plan and it was discarded. Nothing was filled from it.',
  UNAUTHORIZED:
    'Paste the agent server token into extension settings. The token is printed when the server starts.',
  ORIGIN_REJECTED: 'This request origin is not allowed to reach the local agent server.',
  RATE_LIMITED: 'Too many requests to the local server. Wait a moment and retry.',
  REQUEST_TOO_LARGE: 'The request payload exceeded the local server limit.',
  VALIDATION_FAILED:
    'The request or response did not match its schema. See the debug context for details.',
  NOT_FOUND: 'The requested record does not exist.',
  NOT_IMPLEMENTED: 'This capability is planned for a later milestone and is not available yet.',
  INTERNAL_ERROR:
    'The local agent server hit an unexpected error. Check the server log for the full stack.',
};

/** Maps an error code to the HTTP status the local server should return. */
export const ERROR_HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  UNAUTHORIZED: 401,
  ORIGIN_REJECTED: 403,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  PROFILE_MISSING: 404,
  DOCUMENT_MISSING: 404,
  REQUEST_TOO_LARGE: 413,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  NOT_IMPLEMENTED: 501,
  OLLAMA_UNAVAILABLE: 503,
  OLLAMA_TIMEOUT: 504,
  MODEL_NOT_CONFIGURED: 400,
  AI_SETTINGS_INVALID: 422,
  MODEL_NOT_FOUND: 404,
  SERVER_AUTH_FAILED: 401,
  SERVER_REQUEST_FAILED: 502,
  GENERATION_TIMEOUT: 504,
  GENERATION_CANCELLED: 409,
  INSUFFICIENT_EVIDENCE: 422,
  UNSUPPORTED_QUESTION: 422,
  PROHIBITED_QUESTION: 422,
  ANSWER_NOT_GROUNDED: 422,
  ANSWER_LIMIT_EXCEEDED: 422,
  OUTPUT_SCHEMA_INVALID: 422,
};
