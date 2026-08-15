import {
  DEFAULT_SENSITIVE_POLICY,
  SENSITIVE_CATEGORIES,
  SENSITIVE_POLICIES,
  type SensitiveCategory,
  type SensitivePolicy,
} from '@internship-agent/shared';
import type { ProfileDraftController } from '../useProfileDraft.js';

const CATEGORY_LABELS: Record<SensitiveCategory, string> = {
  race: 'Race',
  ethnicity: 'Ethnicity',
  gender: 'Gender',
  disability: 'Disability status',
  veteran_status: 'Veteran status',
  religion: 'Religion',
  sexual_orientation: 'Sexual orientation',
  citizenship: 'Citizenship',
  sponsorship: 'Sponsorship',
  criminal_history: 'Criminal history',
  medical: 'Medical information',
  salary_expectation: 'Salary expectation',
  security_clearance: 'Security clearance',
};

const POLICY_LABELS: Record<SensitivePolicy, string> = {
  approved_auto_fill: 'Fill automatically with my stored answer',
  review_required: 'Ask me every time',
  decline_to_answer: 'Choose "decline to answer" when offered',
  leave_blank: 'Leave the field blank',
};

const POLICY_HELP: Record<SensitivePolicy, string> = {
  approved_auto_fill: 'Only the exact answer you type below will be used.',
  review_required: 'The default. The question appears in the review screen unanswered.',
  decline_to_answer:
    'Used only where the form offers a decline option; otherwise it goes to review.',
  leave_blank: 'The field is skipped and reported as skipped, never as filled.',
};

/**
 * Sensitive questions are opt-in per category. A category with no row here has no
 * policy, which the agent treats as `review_required` — it never guesses.
 */
export function SensitiveSection({
  controller,
}: {
  controller: ProfileDraftController;
}): JSX.Element {
  const { draft, update } = controller;
  const policies = draft.sensitivePolicies;

  const policyFor = (category: SensitiveCategory): SensitivePolicy | undefined =>
    policies.find((entry) => entry.category === category)?.policy;

  const valueFor = (category: SensitiveCategory): string =>
    policies.find((entry) => entry.category === category)?.value ?? '';

  const setPolicy = (category: SensitiveCategory, policy: SensitivePolicy | 'none'): void => {
    update((current) => {
      const rest = current.sensitivePolicies.filter((entry) => entry.category !== category);
      if (policy === 'none') return { ...current, sensitivePolicies: rest };

      const existing = current.sensitivePolicies.find((entry) => entry.category === category);
      return {
        ...current,
        sensitivePolicies: [
          ...rest,
          {
            category,
            policy,
            // A stored value is meaningful only for auto-fill; drop it otherwise
            // so it cannot be used by a later change of policy.
            ...(policy === 'approved_auto_fill' && existing?.value
              ? { value: existing.value }
              : {}),
          },
        ],
      };
    });
  };

  const setValue = (category: SensitiveCategory, value: string): void => {
    update((current) => ({
      ...current,
      sensitivePolicies: current.sensitivePolicies.map((entry) =>
        entry.category === category ? { ...entry, ...(value ? { value } : {}) } : entry,
      ),
    }));
  };

  return (
    <>
      <h2>Sensitive answers</h2>
      <p className="section-note">
        These questions are never guessed. Each category needs an explicit policy; with no policy
        the agent flags the question for your review. Nothing here is inferred from the rest of your
        profile.
      </p>

      {/*
        Said once, plainly, above the controls. This is the one screen where the
        product's central rule is the subject rather than the background, and a
        user who reads nothing else here should still come away knowing that a
        blank category means the question comes back to them.
      */}
      <div className="callout callout--sensitive">
        <p className="callout__title">The agent never infers these answers</p>
        <p>
          Only a choice you have explicitly saved here may be used. A category with no policy is
          asked, never guessed — and no value stored on this page is ever included in a diagnostic
          export.
        </p>
      </div>

      {/*
        A group rather than a table role: these rows are a select and sometimes
        a text box, and announcing them as table cells describes a structure a
        screen reader user cannot navigate.
      */}
      <div className="policy-table" role="group" aria-label="Sensitive answer policies">
        {SENSITIVE_CATEGORIES.map((category) => {
          const policy = policyFor(category);
          const selectId = `policy-${category}`;
          return (
            <div className="policy-row" key={category}>
              <div className="policy-row__label">
                <label htmlFor={selectId}>{CATEGORY_LABELS[category]}</label>
                {policy === undefined ? (
                  <span className="badge badge--warn">
                    No policy — {POLICY_LABELS[DEFAULT_SENSITIVE_POLICY].toLowerCase()}
                  </span>
                ) : null}
              </div>

              <select
                id={selectId}
                value={policy ?? 'none'}
                onChange={(event) =>
                  setPolicy(category, event.target.value as SensitivePolicy | 'none')
                }
              >
                <option value="none">No policy set (ask me every time)</option>
                {SENSITIVE_POLICIES.map((option) => (
                  <option key={option} value={option}>
                    {POLICY_LABELS[option]}
                  </option>
                ))}
              </select>

              {policy ? <p className="hint">{POLICY_HELP[policy]}</p> : null}

              {policy === 'approved_auto_fill' ? (
                <div className="field">
                  <label htmlFor={`${selectId}-value`}>Exact answer to use</label>
                  <input
                    id={`${selectId}-value`}
                    type="text"
                    value={valueFor(category)}
                    onChange={(event) => setValue(category, event.target.value)}
                  />
                  <p className="hint">
                    Required for automatic filling. Without it the question still goes to review.
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
