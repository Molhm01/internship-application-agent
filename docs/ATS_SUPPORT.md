# ATS support

## Milestone 4 status

| ATS                | Adapter id        | Status                                        |
| ------------------ | ----------------- | --------------------------------------------- |
| Generic HTML       | `generic`         | Scan + deterministic execution fixture-tested |
| Greenhouse         | `greenhouse`      | Scan + deterministic execution fixture-tested |
| Lever              | `lever`           | Scan + deterministic execution fixture-tested |
| Workday            | `workday`         | Current rendered step fixture-tested; partial |
| Ashby              | `ashby`           | Detected; generic fallback                    |
| iCIMS              | `icims`           | Detected; generic fallback                    |
| SmartRecruiters    | `smartrecruiters` | Detected; generic fallback                    |
| SAP SuccessFactors | `successfactors`  | Detected; generic fallback                    |
| Oracle Taleo       | `taleo`           | Detected; generic fallback                    |

The highest detection confidence wins; priority breaks ties. Every selection logs the scan id,
adapter, confidence, and reason. Unsupported named systems return a visible warning and use the
read-only generic scanner rather than throwing.

## Adapter contract

```ts
interface AtsAdapter {
  id: AtsId;
  displayName: string;
  priority: number;
  detect(context: PageDetectionContext): AdapterDetection;
  scan(context: ScanContext): Promise<DetectedField[]>;
  extractJobContext(context: ScanContext): Promise<JobContext>;
  executeAction(context, field, action): Promise<FillExecutionResult>;
  verifyAction(context, field, action): Promise<FillVerificationResult>;
}
```

Adapters share the generic native-control executor and verifier; named adapters retain detection and
job-context selectors. There is deliberately no upload, navigation, arbitrary click, or submit
method.

## Coverage and limitations

The scanner reads explicit/wrapped/ARIA/placeholder/legend/nearby labels, native controls, grouped
radio and checkboxes, file fields, comboboxes, contenteditable fields, multi-selects, open shadow
roots, and same-origin frames. A bounded mutation observer catches fields inserted while scanning.

Closed shadow roots cannot be inspected. Cross-origin frames become warnings. Workday often splits
applications across steps, so scan each visible step separately. Virtualized options that have
never been rendered cannot be reported. Workday support is not claimed beyond the current rendered
step and the included fixture.

Real-site instructions are in [MANUAL_TESTING.md](MANUAL_TESTING.md). Fixture coverage is
automated; no claim of a live posting verification is made without a recorded manual run.

AI generation is ATS-independent: it applies only to scanned visible native text/textarea controls
that deterministic eligibility rules identify as custom questions. Greenhouse, Lever, Workday, and
generic pages use the same evidence, review, deterministic fill, and verification boundary. Custom
rich-text editors, cross-origin frames, uploads, hidden steps, and virtualized widgets remain manual.
