name: unresolved-field-resolution
description: Implementation of deterministic review_required handling for sensitive fields and unanswerable Ollama responses
metadata:
  type: project

---

## Context

The form analysis handler processes ATS forms via a model that returns `ApplicationPlan` objects with `FillAction`. When the plan contains actions flagged as `review_required`, the current branch must deterministically resolve them without user intervention.

Architectural rules prohibit executing any action before deterministic validation; the resolver enforces this by:
1. Scanning all proposed fills for fields requiring explicit policy (race, ethnicity, salary expectations) or missing profile data.
2. Marking those actions as `review_required` and logging structured errors.
3. Returning a plan where only fully validated `fill_text`, `submit_button_click`, and `select_option` entries are preserved—everything else is stripped before the response leaves this handler.

## Resolution Strategy

### Deterministic Review Logic (resolver.ts)

A new module at `agent-server/src/app/resolver/review-required-resolver.ts`:
- Receives a raw plan from form analysis, scans for sensitive fields and missing data conditions.
- Marks actions as needing manual review or filters them out based on policy flags in profile (`policies.sensitiveQuestionHandling.enabled` defaults to false).

### Schema Enforcement (shared)

In `application-plan-schema.ts`:
- Add a `needsReview: boolean | undefined` field to describe why an action was filtered.
- Preserve the Zod pipeline that validates Ollama output; malformed responses trigger repair before plan generation so they never reach this resolver.

### Test Coverage

Add Playwright tests in `.claude/tests/extension/playwright/form-analysis.e2e.spec.ts`:
1. Form with sensitive fields (race, salary) → verify no fill actions are generated for them.
2. Ollama returns null for missing profile data → plan contains only `review_required` actions filtered out before response.

### Unit Tests (agent-server/src/app/resolver/__tests__)
- Deterministic filtering when all proposed fills require review: empty plan returned with structured error in logs.
- Partial coverage: sensitive fields + non-sensitive fillable items coexist, producing a partial valid plan.
- Ollama null response handling ensures the schema repair step succeeds before reaching resolver logic.

## Implementation Path

1. Implement `resolver.ts` with deterministic review filtering.
2. Add `needsReview` field to Zod schemas for auditability and error logging purposes only (never executed).
3. Wire form-analysis handler to call this resolver before returning a plan that leaves the server process.
4. Write integration tests using Playwright forms from `.claude/tests/extension/playwright/form-analysis.e2e.spec.ts`.
5. Add unit test coverage for edge cases and partial fills scenarios.

## Verification Commands

```bash
npm run validate        # lint, typecheck, format, build all green
npx playwright install && npx playwright test form-analysis  # e2e pass
npm run test:e2e        # full Playwright suite including new tests passes
git add agent-server/src/app/resolver/shared.ts shared/schemas/application-plan-schema.ts
```

The task completes when all code paths are covered, CI green (typecheck+lint+format), and the resolver behavior matches the architectural rule that no action executes until deterministic validation clears it.
