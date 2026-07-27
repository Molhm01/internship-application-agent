import type { ProfileUpdate } from '@internship-agent/shared';
import type { ProfileDraftController } from '../useProfileDraft.js';
import { SelectField, TextField, TriStateField } from '../components/Field.js';
import { ListInput } from '../components/ListInput.js';

type RemotePreference = NonNullable<ProfileUpdate['preferences']['remotePreference']>;

const REMOTE_OPTIONS: ReadonlyArray<{ value: RemotePreference | 'unset'; label: string }> = [
  { value: 'unset', label: 'Not answered' },
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
  { value: 'no_preference', label: 'No preference' },
];

export function EligibilitySection({
  controller,
}: {
  controller: ProfileDraftController;
}): JSX.Element {
  const { draft, update, fieldError } = controller;
  const eligibility = draft.eligibility;

  const setEligibility = (patch: Partial<typeof eligibility>): void =>
    update((current) => ({ ...current, eligibility: { ...current.eligibility, ...patch } }));

  return (
    <>
      <h2>Work authorization</h2>
      <p className="section-note">
        Citizenship and sponsorship are treated as sensitive. What you store here is used only when
        a matching policy on the Sensitive answers tab allows it; otherwise the question is sent to
        review.
      </p>

      <TextField
        id="workAuthorization"
        label="Work authorization"
        value={eligibility.workAuthorization ?? ''}
        onChange={(workAuthorization) =>
          setEligibility({ workAuthorization: workAuthorization || undefined })
        }
        placeholder="US citizen, permanent resident, F-1 with OPT eligibility"
        error={fieldError('eligibility.workAuthorization')}
      />
      <TriStateField
        id="requiresFutureSponsorship"
        label="Will you require sponsorship in the future?"
        value={eligibility.requiresFutureSponsorship}
        onChange={(requiresFutureSponsorship) => setEligibility({ requiresFutureSponsorship })}
      />
      <TextField
        id="citizenshipResponse"
        label="Preferred answer to citizenship questions"
        value={eligibility.citizenshipResponse ?? ''}
        onChange={(citizenshipResponse) =>
          setEligibility({ citizenshipResponse: citizenshipResponse || undefined })
        }
        hint="Left blank means citizenship questions always go to review."
        error={fieldError('eligibility.citizenshipResponse')}
      />

      <h2>Relocation and travel</h2>
      <div className="grid grid--2">
        <TriStateField
          id="willingToRelocate"
          label="Willing to relocate?"
          value={eligibility.willingToRelocate}
          onChange={(willingToRelocate) => setEligibility({ willingToRelocate })}
        />
        <TextField
          id="willingToTravelPercent"
          label="Willing to travel (%)"
          type="number"
          value={
            eligibility.willingToTravelPercent === undefined
              ? ''
              : String(eligibility.willingToTravelPercent)
          }
          onChange={(value) =>
            setEligibility({
              willingToTravelPercent: value === '' ? undefined : Number(value),
            })
          }
          error={fieldError('eligibility.willingToTravelPercent')}
        />
        <TriStateField
          id="hasDriversLicense"
          label="Do you have a driver's license?"
          value={eligibility.hasDriversLicense}
          onChange={(hasDriversLicense) => setEligibility({ hasDriversLicense })}
        />
        <TriStateField
          id="meetsMinimumAge"
          label="Are you at least 18?"
          value={eligibility.meetsMinimumAge}
          onChange={(meetsMinimumAge) => setEligibility({ meetsMinimumAge })}
        />
      </div>

      <h2>Availability</h2>
      <div className="grid grid--2">
        <TextField
          id="earliestStartDate"
          label="Earliest start date"
          type="date"
          value={eligibility.earliestStartDate ?? ''}
          onChange={(earliestStartDate) =>
            setEligibility({ earliestStartDate: earliestStartDate || undefined })
          }
          error={fieldError('eligibility.earliestStartDate')}
        />
        <TextField
          id="internshipAvailability"
          label="Internship availability"
          value={eligibility.internshipAvailability ?? ''}
          onChange={(internshipAvailability) =>
            setEligibility({ internshipAvailability: internshipAvailability || undefined })
          }
          placeholder="Summer 2027, 12 weeks, full time"
          error={fieldError('eligibility.internshipAvailability')}
        />
      </div>
    </>
  );
}

export function PreferencesSection({
  controller,
}: {
  controller: ProfileDraftController;
}): JSX.Element {
  const { draft, update, fieldError } = controller;
  const preferences = draft.preferences;

  const setPreferences = (patch: Partial<typeof preferences>): void =>
    update((current) => ({ ...current, preferences: { ...current.preferences, ...patch } }));

  return (
    <>
      <h2>Target roles and locations</h2>
      <ListInput
        id="targetRoles"
        label="Target roles"
        values={preferences.targetRoles}
        onChange={(targetRoles) => setPreferences({ targetRoles })}
        placeholder="Embedded Software Intern, Hardware Engineering Intern"
      />
      <ListInput
        id="industries"
        label="Industries"
        values={preferences.industries}
        onChange={(industries) => setPreferences({ industries })}
        placeholder="Semiconductors, Aerospace, Medical devices"
      />
      <ListInput
        id="preferredLocations"
        label="Preferred locations"
        values={preferences.preferredLocations}
        onChange={(preferredLocations) => setPreferences({ preferredLocations })}
        placeholder="Boston, MA; Austin, TX; Remote"
      />
      <TextField
        id="discoverySource"
        label="How you heard about opportunities"
        value={preferences.discoverySource ?? ''}
        onChange={(discoverySource) =>
          setPreferences({ discoverySource: discoverySource || undefined })
        }
        error={fieldError('preferences.discoverySource')}
        placeholder="University career center"
      />
      <SelectField<RemotePreference | 'unset'>
        id="remotePreference"
        label="Remote preference"
        value={preferences.remotePreference ?? 'unset'}
        options={REMOTE_OPTIONS}
        onChange={(value) =>
          setPreferences({ remotePreference: value === 'unset' ? undefined : value })
        }
      />

      <h2>Salary preference</h2>
      <p className="section-note">
        Salary expectation is a sensitive question. It is never volunteered from this field unless a
        policy on the Sensitive answers tab permits it.
      </p>
      <TextField
        id="salaryPreference"
        label="Salary preference"
        value={preferences.salaryPreference ?? ''}
        onChange={(salaryPreference) =>
          setPreferences({ salaryPreference: salaryPreference || undefined })
        }
        placeholder="$30–40/hour, or Negotiable"
        error={fieldError('preferences.salaryPreference')}
      />
    </>
  );
}
