import {
  profileSchema,
  type EducationEntry,
  type ExperienceEntry,
  type Profile,
  type ProfileFieldStatus,
  type ProfileSource,
  type ProfileSourceLabel,
  type ProfileSyncEntry,
} from '../schemas/profile.js';

export type { ProfileFieldStatus, ProfileSource, ProfileSourceLabel, ProfileSyncEntry };

/**
 * Merging the profiles that Internship Pilot and the agent server each hold.
 *
 * The two stores drifted apart because nothing ever copied one into the other:
 * the settings page edited the agent server's copy, the Apply flow filled the
 * bundle's copy, and neither had ever seen the other. Merging them is therefore
 * a recovery operation on real user data, and it obeys one rule above all:
 *
 *   **A populated value is never replaced by an empty one.**
 *
 * Nothing here invents a value. Every field in the result came verbatim from
 * one of the inputs, and a field absent from all of them stays absent — which
 * is what keeps "the user has not told us" distinguishable from "the user said
 * nothing applies".
 */

/** Where a profile came from, lowest number winning when timestamps tie. */
export const PROFILE_SOURCE_RANK = {
  /** The canonical profile the website maintains. */
  internship_pilot: 0,
  /** The agent server's own copy, edited through extension settings. */
  agent_server: 1,
  /** Anything recovered from an older extension storage shape. */
  legacy_extension: 2,
} as const;

export interface ProfileMergeResult {
  profile: Profile;
  report: ProfileSyncEntry[];
  /** True when the merged profile differs from `destination`. */
  changed: boolean;
}

/** Empty for merge purposes: nothing the user actually told us. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Sources in the order their values should be consulted.
 *
 * Most recently saved first, because an explicit edit the user made five
 * minutes ago outranks a copy of the same field from last week wherever it
 * lives. The declared rank only breaks ties, so two stores written in the same
 * second still resolve deterministically rather than by array order.
 */
export function orderSources(sources: readonly ProfileSource[]): ProfileSource[] {
  return [...sources].sort((left, right) => {
    const byTime = right.profile.updatedAt.localeCompare(left.profile.updatedAt);
    if (byTime !== 0) return byTime;
    return PROFILE_SOURCE_RANK[left.label] - PROFILE_SOURCE_RANK[right.label];
  });
}

/** The first non-empty value along the ordered sources, or undefined. */
function pick<T>(ordered: readonly ProfileSource[], read: (profile: Profile) => T): T | undefined {
  for (const source of ordered) {
    const value = read(source.profile);
    if (!isEmpty(value)) return value;
  }
  return undefined;
}

/** Normalized text for comparing two entries that describe the same thing. */
function identity(...parts: ReadonlyArray<string | undefined>): string {
  return parts
    .map((part) => (part ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .filter(Boolean)
    .join('|');
}

/**
 * Unions entry lists without creating a second copy of one entry.
 *
 * Two entries are the same when they share an id, or when their natural key —
 * the employer and title, the school and degree, the project's name — is the
 * same. Matched entries are merged field by field along the source order, so an
 * entry that Internship Pilot knows the dates for and the agent server knows the
 * responsibilities for ends up with both rather than with whichever arrived
 * last.
 */
function unionEntries<T extends { id: string }>(
  lists: ReadonlyArray<readonly T[]>,
  naturalKey: (entry: T) => string,
): T[] {
  const merged: T[] = [];
  const byIdentity = new Map<string, number>();

  for (const list of lists) {
    for (const entry of list) {
      const keys = [`id:${entry.id}`, `key:${naturalKey(entry)}`].filter(
        (key) => key !== 'key:',
      );
      const existingIndex = keys
        .map((key) => byIdentity.get(key))
        .find((index) => index !== undefined);

      if (existingIndex === undefined) {
        const index = merged.length;
        merged.push(entry);
        for (const key of keys) byIdentity.set(key, index);
        continue;
      }

      // Same entry, seen again from a lower-priority source. Only the fields
      // the winner left empty are taken, so nothing populated is overwritten.
      const winner = merged[existingIndex] as Record<string, unknown>;
      for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
        if (field === 'id') continue;
        if (isEmpty(winner[field]) && !isEmpty(value)) winner[field] = value;
      }
      for (const key of keys) if (!byIdentity.has(key)) byIdentity.set(key, existingIndex);
    }
  }
  return merged;
}

function educationKey(entry: EducationEntry): string {
  return identity(entry.institution, entry.degree, entry.major);
}

function experienceKey(entry: ExperienceEntry): string {
  return identity(entry.employer, entry.title, entry.startDate);
}

/** Deduplicated free-text list, first spelling wins, order preserved. */
function unionStrings(lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const value of list) {
      const key = value.toLowerCase().replace(/\s+/g, ' ').trim();
      if (key && !seen.has(key)) seen.set(key, value);
    }
  }
  return [...seen.values()];
}

/**
 * The contract paths reported by the sync diagnostic, and how to read each one.
 *
 * Spelled with the brief's section names (`nameContact`, `skillsAndActivities`)
 * rather than the schema's internal ones, because this list is what the user
 * reads. Every reader returns a presence indicator only — the report never
 * carries a value, and this table is the single place that guarantees it.
 */
const REPORTED_SCALARS: ReadonlyArray<{ key: string; read: (p: Profile) => unknown }> = [
  { key: 'nameContact.legalFirstName', read: (p) => p.personal.legalFirstName },
  { key: 'nameContact.middleName', read: (p) => p.personal.legalMiddleName },
  { key: 'nameContact.legalLastName', read: (p) => p.personal.legalLastName },
  { key: 'nameContact.preferredName', read: (p) => p.personal.preferredName },
  { key: 'nameContact.email', read: (p) => p.personal.email },
  { key: 'nameContact.phoneCountryCode', read: (p) => p.personal.phoneCountryCode },
  { key: 'nameContact.phoneNumber', read: (p) => p.personal.phone },
  { key: 'nameContact.phoneType', read: (p) => p.personal.phoneType },
  { key: 'nameContact.addressType', read: (p) => p.personal.address.type },
  { key: 'nameContact.addressLine1', read: (p) => p.personal.address.line1 },
  { key: 'nameContact.addressLine2', read: (p) => p.personal.address.line2 },
  { key: 'nameContact.city', read: (p) => p.personal.address.city },
  { key: 'nameContact.state', read: (p) => p.personal.address.state },
  { key: 'nameContact.postalCode', read: (p) => p.personal.address.postalCode },
  { key: 'nameContact.country', read: (p) => p.personal.address.country },
  { key: 'education.highestCompletedDegree', read: (p) => p.highestCompletedDegree },
  { key: 'education.currentDegreeInProgress', read: (p) => p.currentDegreeInProgress },
  { key: 'eligibility.workAuthorization', read: (p) => p.eligibility.workAuthorization },
  { key: 'eligibility.sponsorshipNow', read: (p) => p.eligibility.requiresSponsorshipNow },
  { key: 'eligibility.sponsorshipFuture', read: (p) => p.eligibility.requiresFutureSponsorship },
  { key: 'eligibility.relocation', read: (p) => p.eligibility.willingToRelocate },
  { key: 'eligibility.clearance', read: (p) => p.eligibility.securityClearanceStatus },
  { key: 'preferences.preferredLocations', read: (p) => p.preferences.preferredLocations },
  { key: 'preferences.earliestStartDate', read: (p) => p.eligibility.earliestStartDate },
  { key: 'preferences.sourceAttribution', read: (p) => p.preferences.discoverySource },
  { key: 'preferences.salaryPreference', read: (p) => p.preferences.salaryPreference },
  {
    key: 'preferences.employerPortalStrategy',
    read: (p) => p.preferences.employerPortalStrategy,
  },
  { key: 'skillsAndActivities.skills', read: (p) => p.skills.technical },
  { key: 'skillsAndActivities.certifications', read: (p) => p.certifications },
  { key: 'skillsAndActivities.organizations', read: (p) => p.organizations },
  { key: 'skillsAndActivities.activities', read: (p) => p.activities },
  { key: 'documents.defaultResume', read: (p) => p.documents.defaultResume },
  { key: 'documents.tailoredResume', read: (p) => p.documents.tailoredResume },
  { key: 'documents.tailoredCoverLetter', read: (p) => p.documents.tailoredCoverLetter },
];

/** One status for a key, from what the destination had and what it now has. */
function statusFor(before: unknown, after: unknown): ProfileFieldStatus {
  const had = !isEmpty(before);
  const has = !isEmpty(after);
  if (!has) return 'missing';
  if (!had) return 'imported';
  return JSON.stringify(before) === JSON.stringify(after) ? 'present' : 'updated';
}

/**
 * Merges every source into `destination` without losing anything either held.
 *
 * `destination` is itself treated as a source, so calling this with nothing new
 * to add is a no-op that reports `changed: false` — which is what lets the
 * settings page and the bundle handler both run it unconditionally.
 */
export function mergeProfiles(
  destination: Profile,
  incoming: readonly ProfileSource[],
): ProfileMergeResult {
  const destinationSource: ProfileSource = { label: 'agent_server', profile: destination };
  const ordered = orderSources([
    ...incoming.filter((source) => source.profile !== destination),
    destinationSource,
  ]);
  const profiles = ordered.map((source) => source.profile);

  const merged = profileSchema.parse({
    ...destination,
    personal: {
      ...destination.personal,
      legalFirstName: pick(ordered, (p) => p.personal.legalFirstName),
      legalMiddleName: pick(ordered, (p) => p.personal.legalMiddleName),
      noMiddleName: pick(ordered, (p) => p.personal.noMiddleName),
      legalLastName: pick(ordered, (p) => p.personal.legalLastName),
      suffix: pick(ordered, (p) => p.personal.suffix),
      preferredName: pick(ordered, (p) => p.personal.preferredName),
      pronouns: pick(ordered, (p) => p.personal.pronouns),
      email: pick(ordered, (p) => p.personal.email),
      alternateEmail: pick(ordered, (p) => p.personal.alternateEmail),
      phone: pick(ordered, (p) => p.personal.phone),
      phoneCountryCode: pick(ordered, (p) => p.personal.phoneCountryCode),
      phoneType: pick(ordered, (p) => p.personal.phoneType),
      linkedin: pick(ordered, (p) => p.personal.linkedin),
      github: pick(ordered, (p) => p.personal.github),
      portfolio: pick(ordered, (p) => p.personal.portfolio),
      personalWebsite: pick(ordered, (p) => p.personal.personalWebsite),
      preferredWebsiteField: pick(ordered, (p) => p.personal.preferredWebsiteField),
      address: {
        line1: pick(ordered, (p) => p.personal.address.line1),
        line2: pick(ordered, (p) => p.personal.address.line2),
        city: pick(ordered, (p) => p.personal.address.city),
        state: pick(ordered, (p) => p.personal.address.state),
        postalCode: pick(ordered, (p) => p.personal.address.postalCode),
        country: pick(ordered, (p) => p.personal.address.country),
        metroRegion: pick(ordered, (p) => p.personal.address.metroRegion),
        type: pick(ordered, (p) => p.personal.address.type),
      },
    },
    education: unionEntries(
      profiles.map((p) => p.education),
      educationKey,
    ),
    highestCompletedDegree: pick(ordered, (p) => p.highestCompletedDegree),
    currentDegreeInProgress: pick(ordered, (p) => p.currentDegreeInProgress),
    experience: unionEntries(
      profiles.map((p) => p.experience),
      experienceKey,
    ),
    projects: unionEntries(
      profiles.map((p) => p.projects),
      (entry) => identity(entry.name),
    ),
    certifications: unionEntries(
      profiles.map((p) => p.certifications),
      (entry) => identity(entry.name, entry.issuer),
    ),
    volunteering: unionEntries(
      profiles.map((p) => p.volunteering),
      (entry) => identity(entry.organization, entry.role),
    ),
    organizations: unionStrings(profiles.map((p) => p.organizations)),
    activities: unionStrings(profiles.map((p) => p.activities)),
    skills: {
      technical: unionStrings(profiles.map((p) => p.skills.technical)),
      programmingLanguages: unionStrings(profiles.map((p) => p.skills.programmingLanguages)),
      engineeringSoftware: unionStrings(profiles.map((p) => p.skills.engineeringSoftware)),
      hardware: unionStrings(profiles.map((p) => p.skills.hardware)),
      spokenLanguages: unionEntries(
        profiles.map((p) =>
          p.skills.spokenLanguages.map((entry) => ({ ...entry, id: entry.language })),
        ),
        (entry) => identity(entry.language),
      ).map(({ id: _id, ...rest }) => rest),
    },
    eligibility: {
      workAuthorization: pick(ordered, (p) => p.eligibility.workAuthorization),
      requiresSponsorshipNow: pick(ordered, (p) => p.eligibility.requiresSponsorshipNow),
      requiresFutureSponsorship: pick(ordered, (p) => p.eligibility.requiresFutureSponsorship),
      securityClearanceStatus: pick(ordered, (p) => p.eligibility.securityClearanceStatus),
      citizenshipResponse: pick(ordered, (p) => p.eligibility.citizenshipResponse),
      willingToRelocate: pick(ordered, (p) => p.eligibility.willingToRelocate),
      willingToTravelPercent: pick(ordered, (p) => p.eligibility.willingToTravelPercent),
      hasDriversLicense: pick(ordered, (p) => p.eligibility.hasDriversLicense),
      meetsMinimumAge: pick(ordered, (p) => p.eligibility.meetsMinimumAge),
      earliestStartDate: pick(ordered, (p) => p.eligibility.earliestStartDate),
      internshipAvailability: pick(ordered, (p) => p.eligibility.internshipAvailability),
    },
    preferences: {
      targetRoles: unionStrings(profiles.map((p) => p.preferences.targetRoles)),
      industries: unionStrings(profiles.map((p) => p.preferences.industries)),
      preferredLocations: unionStrings(profiles.map((p) => p.preferences.preferredLocations)),
      discoverySource: pick(ordered, (p) => p.preferences.discoverySource),
      employerPortalStrategy: pick(ordered, (p) => p.preferences.employerPortalStrategy),
      remotePreference: pick(ordered, (p) => p.preferences.remotePreference),
      salaryPreference: pick(ordered, (p) => p.preferences.salaryPreference),
      salaryStrategy: pick(ordered, (p) => p.preferences.salaryStrategy),
      salaryMinimum: pick(ordered, (p) => p.preferences.salaryMinimum),
      marketingTextConsent: pick(ordered, (p) => p.preferences.marketingTextConsent),
      resumeSelectionRules: unionEntries(
        profiles.map((p) => p.preferences.resumeSelectionRules),
        (entry) => identity(entry.documentId),
      ),
    },
    documents: {
      defaultResume: pick(ordered, (p) => p.documents.defaultResume),
      tailoredResume: pick(ordered, (p) => p.documents.tailoredResume),
      tailoredCoverLetter: pick(ordered, (p) => p.documents.tailoredCoverLetter),
    },
    // A policy is a disclosure decision, so the most recent source wins outright
    // rather than being unioned: two stores disagreeing about whether the user
    // declined must not resolve into "both".
    sensitivePolicies:
      pick(ordered, (p) => p.sensitivePolicies) ?? destination.sensitivePolicies,
  });

  const report: ProfileSyncEntry[] = REPORTED_SCALARS.map(({ key, read }) => ({
    key,
    status: statusFor(read(destination), read(merged)),
  }));

  for (const [section, before, after] of [
    ['education', destination.education, merged.education],
    ['experience', destination.experience, merged.experience],
    ['projects', destination.projects, merged.projects],
  ] as const) {
    const label = section === 'education' ? 'school' : section === 'experience' ? 'employer' : 'projectName';
    after.forEach((entry, index) => {
      const existed = before.some((candidate) => candidate.id === entry.id);
      report.push({
        key: `${section}[${index}].${label}`,
        status: existed ? 'present' : 'imported',
      });
    });
    if (after.length === 0) report.push({ key: `${section}[]`, status: 'missing' });
  }

  return {
    profile: merged,
    report,
    changed: JSON.stringify({ ...merged, updatedAt: '' }) !== JSON.stringify({ ...destination, updatedAt: '' }),
  };
}
