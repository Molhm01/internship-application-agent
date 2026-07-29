import type { FieldOption } from '../schemas/fields.js';
import { canonicalCountryName, canonicalStateName, normalizeOptionText } from './optionMatcher.js';

/**
 * Structured matching for location controls.
 *
 * A city name alone is not an answer: "Clifton" exists in New Jersey, Colorado,
 * Arizona, Texas, and Virginia. This module refuses to pick one unless the
 * saved state and country agree with the option's own state and country, so the
 * agent can never enter a place the user does not live in.
 *
 * Every comparison is against the options the page actually offers. Nothing here
 * invents a place, and nothing infers a region the profile did not state.
 */

export interface LocationTarget {
  city?: string | undefined;
  state?: string | undefined;
  country?: string | undefined;
}

export interface LocationMatchResult {
  matched: boolean;
  ambiguous: boolean;
  option?: FieldOption;
  /** True when the option's own text confirmed the saved state. */
  stateConfirmed: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  warnings: string[];
  /** Options that named the right city but the wrong region. */
  rejected: FieldOption[];
}

interface ParsedLabel {
  parts: string[];
  state: string | null;
  country: string | null;
}

function parseLabel(label: string): ParsedLabel {
  const parts = label
    .split(',')
    .map((part) => normalizeOptionText(part))
    .filter((part) => part.length > 0);

  let state: string | null = null;
  let country: string | null = null;
  // The first part is the city; a region token never overrides it, which keeps
  // "Washington, District of Columbia" from reading as the state of Washington.
  for (const part of parts.slice(1)) {
    if (!country) country = canonicalCountryName(part);
    if (!state && !canonicalCountryName(part)) state = canonicalStateName(part);
  }
  return { parts, state, country };
}

/** The search text to type into an autocomplete. Never more than saved data. */
export function locationSearchText(target: LocationTarget): string {
  return [target.city, target.state].filter((part) => Boolean(part && part.length > 0)).join(', ');
}

/** True when this control expects a whole place rather than one component. */
export function isLocationQuestion(canonical: string | undefined): boolean {
  return canonical === 'current_location' || canonical === 'city';
}

/**
 * Chooses the option whose city, state, and country all agree with the saved
 * profile.
 *
 * Requires every piece of saved evidence to agree. An option naming a different
 * state is rejected outright rather than scored, and two equally good survivors
 * are reported as ambiguous instead of resolved by picking one.
 */
export function matchLocationOption(
  target: LocationTarget,
  options: readonly FieldOption[],
): LocationMatchResult {
  const city = target.city ? normalizeOptionText(target.city) : '';
  const empty: Omit<LocationMatchResult, 'matched' | 'ambiguous' | 'reason'> = {
    stateConfirmed: false,
    confidence: 'low',
    warnings: [],
    rejected: [],
  };

  if (city.length === 0) {
    return {
      ...empty,
      matched: false,
      ambiguous: false,
      reason: 'No saved city exists, so no location can be selected.',
    };
  }

  const wantedState = target.state ? canonicalStateName(target.state) : null;
  const wantedCountry = target.country ? canonicalCountryName(target.country) : null;

  const rejected: FieldOption[] = [];
  const confirmed: FieldOption[] = [];
  const unconfirmed: FieldOption[] = [];

  for (const option of options) {
    if (option.disabled) continue;
    const parsed = parseLabel(option.label);
    const optionCity = parsed.parts[0] ?? '';
    // The saved city must be the option's own city, not a substring of it.
    if (optionCity !== city) continue;

    // Any stated disagreement disqualifies the option. This is what keeps
    // Clifton, Colorado off a New Jersey profile.
    if (wantedState && parsed.state && parsed.state !== wantedState) {
      rejected.push(option);
      continue;
    }
    if (wantedCountry && parsed.country && parsed.country !== wantedCountry) {
      rejected.push(option);
      continue;
    }

    if (wantedState && parsed.state === wantedState) confirmed.push(option);
    else unconfirmed.push(option);
  }

  if (confirmed.length === 1 && confirmed[0]) {
    return {
      matched: true,
      ambiguous: false,
      option: confirmed[0],
      stateConfirmed: true,
      confidence: 'high',
      reason: `"${confirmed[0].label}" matches your saved city, state, and country.`,
      warnings: [],
      rejected,
    };
  }
  if (confirmed.length > 1) {
    return {
      ...empty,
      matched: false,
      ambiguous: true,
      rejected,
      reason: `Several options name ${target.city} in ${target.state}.`,
      warnings: ['Choose the correct location yourself.'],
    };
  }

  // No option stated a region. A bare "Clifton" is compatible with the profile
  // but confirms nothing, so it is proposed only for explicit confirmation.
  if (unconfirmed.length === 1 && unconfirmed[0]) {
    return {
      matched: true,
      ambiguous: false,
      option: unconfirmed[0],
      stateConfirmed: false,
      confidence: 'medium',
      reason: `"${unconfirmed[0].label}" matches your saved city but does not state a region.`,
      warnings: ['This option does not name a state; confirm it is the right place.'],
      rejected,
    };
  }
  if (unconfirmed.length > 1) {
    return {
      ...empty,
      matched: false,
      ambiguous: true,
      rejected,
      reason: `Several options are labelled "${target.city}" without naming a region.`,
      warnings: ['Choose the correct location yourself.'],
    };
  }

  return {
    ...empty,
    matched: false,
    ambiguous: false,
    rejected,
    reason:
      rejected.length > 0
        ? `This list offers ${target.city} only in other regions, not ${target.state ?? 'your saved region'}.`
        : `No option on this form corresponds to "${locationSearchText(target)}".`,
    warnings:
      rejected.length > 0
        ? ['A location in a different state or country is never selected for you.']
        : [],
  };
}
