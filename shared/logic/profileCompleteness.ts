import type { Profile } from '../schemas/profile.js';

export interface CompletenessSection {
  id: string;
  label: string;
  /** Required sections drive the percentage; optional ones are reported only. */
  required: boolean;
  complete: boolean;
  /** Human-readable names of what is still absent. Never a guess at a value. */
  missing: string[];
}

export interface ProfileCompleteness {
  percent: number;
  completeSections: number;
  totalRequiredSections: number;
  sections: CompletenessSection[];
}

function hasText(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

interface SectionSpec {
  id: string;
  label: string;
  required: boolean;
  /** Each entry is a requirement name plus whether the profile satisfies it. */
  checks: Array<{ name: string; satisfied: boolean }>;
}

/**
 * Reports which parts of the profile the user has filled in. This is strictly a
 * measurement: it never infers a value, and a missing field is reported as
 * missing rather than defaulted.
 */
export function computeProfileCompleteness(profile: Profile): ProfileCompleteness {
  const personal = profile.personal;
  const address = personal.address;
  const eligibility = profile.eligibility;
  const preferences = profile.preferences;
  const skills = profile.skills;

  const specs: SectionSpec[] = [
    {
      id: 'identity',
      label: 'Legal and preferred name',
      required: true,
      checks: [
        { name: 'Legal first name', satisfied: hasText(personal.legalFirstName) },
        { name: 'Legal last name', satisfied: hasText(personal.legalLastName) },
      ],
    },
    {
      id: 'contact',
      label: 'Email and phone',
      required: true,
      checks: [
        { name: 'Email', satisfied: hasText(personal.email) },
        { name: 'Phone', satisfied: hasText(personal.phone) },
      ],
    },
    {
      id: 'address',
      label: 'Address',
      required: true,
      checks: [
        { name: 'Street address', satisfied: hasText(address.line1) },
        { name: 'City', satisfied: hasText(address.city) },
        { name: 'State or region', satisfied: hasText(address.state) },
        { name: 'Postal code', satisfied: hasText(address.postalCode) },
        { name: 'Country', satisfied: hasText(address.country) },
      ],
    },
    {
      id: 'links',
      label: 'LinkedIn, GitHub, portfolio, website',
      required: true,
      checks: [
        {
          name: 'At least one professional link',
          satisfied:
            hasText(personal.linkedin) ||
            hasText(personal.github) ||
            hasText(personal.portfolio) ||
            hasText(personal.personalWebsite),
        },
      ],
    },
    {
      id: 'education',
      label: 'Education',
      required: true,
      checks: [
        {
          name: 'At least one school with a graduation date',
          satisfied: profile.education.some(
            (entry) => hasText(entry.institution) && hasText(entry.graduationDate),
          ),
        },
      ],
    },
    {
      id: 'experience',
      label: 'Work experience',
      required: true,
      checks: [
        {
          name: 'At least one role with a title',
          satisfied: profile.experience.some(
            (entry) => hasText(entry.employer) && hasText(entry.title),
          ),
        },
      ],
    },
    {
      id: 'skills',
      label: 'Skills',
      required: true,
      checks: [
        {
          name: 'At least one technical skill or language',
          satisfied: skills.technical.length > 0 || skills.programmingLanguages.length > 0,
        },
      ],
    },
    {
      id: 'eligibility',
      label: 'Work authorization and sponsorship',
      required: true,
      checks: [
        { name: 'Work authorization', satisfied: hasText(eligibility.workAuthorization) },
        {
          name: 'Future sponsorship requirement',
          satisfied: typeof eligibility.requiresFutureSponsorship === 'boolean',
        },
      ],
    },
    {
      id: 'availability',
      label: 'Relocation, travel, and start date',
      required: true,
      checks: [
        {
          name: 'Relocation willingness',
          satisfied: typeof eligibility.willingToRelocate === 'boolean',
        },
        { name: 'Earliest start date', satisfied: hasText(eligibility.earliestStartDate) },
      ],
    },
    {
      id: 'preferences',
      label: 'Target roles and locations',
      required: true,
      checks: [
        { name: 'At least one target role', satisfied: preferences.targetRoles.length > 0 },
        {
          name: 'At least one preferred location',
          satisfied: preferences.preferredLocations.length > 0,
        },
      ],
    },
    {
      id: 'projects',
      label: 'Projects',
      required: false,
      checks: [{ name: 'At least one project', satisfied: profile.projects.length > 0 }],
    },
    {
      id: 'certifications',
      label: 'Certifications',
      required: false,
      checks: [
        { name: 'At least one certification', satisfied: profile.certifications.length > 0 },
      ],
    },
    {
      id: 'volunteering',
      label: 'Activities and volunteering',
      required: false,
      checks: [{ name: 'At least one activity', satisfied: profile.volunteering.length > 0 }],
    },
    {
      id: 'salary',
      label: 'Salary preference',
      required: false,
      checks: [{ name: 'Salary preference', satisfied: hasText(preferences.salaryPreference) }],
    },
    {
      id: 'sensitive',
      label: 'Demographic and sensitive answers',
      required: false,
      checks: [
        {
          name: 'At least one stored policy',
          satisfied: profile.sensitivePolicies.length > 0,
        },
      ],
    },
  ];

  const sections: CompletenessSection[] = specs.map((spec) => ({
    id: spec.id,
    label: spec.label,
    required: spec.required,
    complete: spec.checks.every((check) => check.satisfied),
    missing: spec.checks.filter((check) => !check.satisfied).map((check) => check.name),
  }));

  const required = sections.filter((section) => section.required);
  const completeRequired = required.filter((section) => section.complete);

  return {
    // Percentage counts required sections only, so a complete-enough profile can
    // actually reach 100 without inventing optional history.
    percent:
      required.length === 0 ? 0 : Math.round((completeRequired.length / required.length) * 100),
    completeSections: completeRequired.length,
    totalRequiredSections: required.length,
    sections,
  };
}
