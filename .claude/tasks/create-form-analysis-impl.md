Based on schemas in shared/schemas/plan.ts and fill.ts, the form analysis handler needs to:

1. Parse ATS forms via content script → return DetectedField[] objects with status (filled|resolved_review_required)
2. For fields requiring explicit policy handling OR missing profile data markers from Ollama response:
   - Call deterministic resolver logic using unresolvedFieldResolutionSchema or fieldMatchSchema patterns  
3. Return ApplicationPlan where only fully validated fill actions are included in the plan before leaving handler

Resolver module at agent-server/src/app/resolver/:
- review-required-resolver.ts handles filtering sensitive fields with requiresReview=true (prohibited from autofill) OR missing profile data entries
- Use deterministicFillActionSchema to validate AI suggestions always carry requiresReview flag
- Zod schema superRefine() in fill.ts shows existing validation that rejects actions before execution

Wire this resolver into the form analysis endpoint returning ApplicationPlan:
1. Content script detects field → returns DetectedField objects with status "filled" (deterministic) or review_required  
2. Form analyzer builds plan via applicationPlanSchema at line 92 in shared/schemas/plan.ts
3. Resolver scans all proposed fills, filters out sensitive fields OR missing profile data cases where needsReview=true
4. Plan response leaves server process only if resolver validates actions against deterministicFillActionSchema

Unit tests for: empty plan when all fields require review, partial coverage with non-sensitive + valid items from Ollama null responses in shared/logic/aiQuestions.ts or ai schema files showing grounded output patterns. Add Playwright form analysis e2e test verifying no fill action generated without user approval first before marking as completed run status.
