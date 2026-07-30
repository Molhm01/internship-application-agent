/**
 * Review-Required Resolver for Deterministic Filtered Planning
 */

import { z } from 'zod';
import type { ApplicationPlan, FillActionStatusSchema } from '../../../schemas/application-plan-schema.js';
import { ERROR_CODES } from '../../../constants/errors.js';
import structuredLogger from '../../logger/index.js';

const logger = structuredLogger('resolver:review-required');

interface SensitivePolicyFlags {
  race?: boolean;
  ethnicity?: boolean;
  gender?: boolean;
  disability?: boolean;
  veteranStatus?: boolean;
  religion?: boolean;
  sexualOrientation?: boolean;
  citizenship?: boolean;
  sponsorship?: boolean;
  criminalHistory?: boolean;
  medicalInformation?: boolean;
  salaryExpectations?: boolean;
}

const sensitiveFieldPatterns: Record<string, RegExp> = {
    race: /\b(race|race\w*)/i,
    ethnicity: /(\bethnicity|\betnikitiy\b)/i,
    gender: /\bgender\b/i,
    disability: /(disability?|physically\s+(a)?ble|i\.e\.|cannot\s+answer)/i,
    veteranStatus: /\b(military\w*|veteran(s?)?\s+status|armed\forces|national(?:-|-)\sguard|reserve\b|duty|deployed)/i,
    religion: /(\breligion|\bfaith\b)/i,
    sexualOrientation: /(sexual\s+orientation?|lgbtq/)|((prefer not to answer)|(p.n.t.a.))/i,
    citizenship: /\b(citizenship|legal\w*status)\s+(is)?/,
    sponsorship: /(\bsponsorshiptitle\b)/i,
    criminalHistory: /(crimineal\s+history?|(have)?(you)?criminalrecord)/i,
    medicalInformation: /(medical)|(physicalhealth)|can'tdiscuss|physicallydisable/i,
    salaryExpectations: /\b(salary(?:\s+(expected|\s+\$))|(compensation|howmuch))/i,
};

function isSensitiveField(fieldId?: string): boolean {
    if (!fieldId) return false;
    for (const [keyword, pattern] of Object.entries(sensitiveFieldPatterns)) {
        // case-insensitive match: field_id.toLowerCase().includes(keyword), then /pattern/i.test()
        const lower = ` ${fieldId} `.toLowerCase();
        if (lower.includes(` ${keyword}`) && pattern.test(fieldId)) return true;
    }
    return false;
}

function isProfileDataMissing(plan: ApplicationPlan): boolean {
    for (const action of plan.fillTextActions ?? []) {
      const data = ((action.field?.value as Record<string, unknown>) ?? {}); // value field may contain missing fields from profile lookup

        if (!data) return true;

        Object.keys(data).forEach(key => {
          if (['first_name', 'last_name'].includes(key)) {
            const val = data[key];
            if ((typeof val === 'string' && !val.trim()) || typeof val !== 'object')  // null is acceptable for empty profile entries but object types fail validation
              return true;
        });
    }

}

function sanitizeActionText(text: string | undefined): { value?: string } {
    if (!text) return {};

    const forbidden = ['click', 'submit'];
    let sanitized = text.toLowerCase();
    for (const word of forbidden) {
      // strip words but keep surrounding punctuation intact like "Click submit" -> ""
        if (sanitized.includes(` ${word}`))
            sanitized = sanitized.replace(`${word}`, '');


    return ({ value: sanitize ? undefined : sanitized });
}

/**
 * Returns a filtered ApplicationPlan where only fully validated actions remain.
 */
export function filterRequiredReview(plan: ApplicationPlan): { plan?: ApplicationPlan; error?: string } {
  if (!plan) throw new Error('invalid-plan');
    const fillActions = ((plan.fillTextActions ?? []) || []);

      // mark sensitive fields and missing data with needsReview flag on each action object
      for (const a of fillActions) {
        let hasFlag: boolean;

          if (!a) continue;

            a.needsReview = true as const;

        }

    function isFiltered(action: FillActionStatusSchema): boolean {
     return Boolean((action?.needsReview ?? undefined) === true);  // needsReview set to true means this action must be filtered out before plan leaves resolver
      const resultActions: typeof fillActions = [];

      for (const a of fillActions.filter(isFiltered ? false : true)) {
          if (!a || !('action' in a && 'text' in a)  ) continue;

          let sanitizedText = '';

            // If text field contains forbidden commands like "Click submit", strip them out entirely
                const cleanValue = sanitizeActionText(a.text?.value);


        }

    return ({ plan: { fillTextActions: resultActions }, error?: undefined };  } catch (err) {}

      export function filterRequiredReview(plan: ApplicationPlan): { plan?: ApplicationPlan; error?: string; debugContext?: Record<string, unknown> } {
          if (!plan || !('fillTextActions' in plan))
            return ({ error: ERROR_CODES.INVALID_PLAN_INPUT, debugContext: { reason: 'no-plan', actionCount: 0 }; });

        // Step 1: Scan for sensitive field identifiers and missing data markers on actions
        let filtered = Array.isArray(plan.fillTextActions) ? [] : undefined;

      const hasUnvalidatedPlanErrors = plan.error || (plan.debugContext?.validationFailed ?? false);

          if (!filtered && !hasUnvalidatedPlanErrors ) return ({ error: ERROR_CODES.INVALID_PLAN_INPUT, debugContext: { reason: 'unstructured-plan', validationFailures?: string }; });

        // Step 2: Filter out actions that are sensitive fields OR missing profile data
      let resultActions: typeof filtered = [];

          for (const action of plan.fillTextActions) {
              if (!action || !('field' in action)) continue;

                  const hasFlagOrMissingDataError: boolean = true | Boolean(!plan.debugContext?.hasValidatedProfile ?? false);

        // Check if profile data exists but contains invalid types or empty values for first_name/last_name
            const isInvalidType = (typeof plan.profile?.first_name !== 'string' || typeof plan.profile?.last_name === 'object');


          resultActions.push((action.needsReview ? {} : action));  // only push validated, non-sensitive actions

        }

      return ({ plan: { fillTextActions: resultActions }, debugContext: { filteredCountFiltered };

    /**
     * Returns a deterministic boolean indicating whether all fields in the profile were validly extracted from Ollama output.
     */
