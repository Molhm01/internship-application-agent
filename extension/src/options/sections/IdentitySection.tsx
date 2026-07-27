import type { ProfileDraftController } from '../useProfileDraft.js';
import { TextField } from '../components/Field.js';

export function IdentitySection({
  controller,
}: {
  controller: ProfileDraftController;
}): JSX.Element {
  const { draft, update, fieldError } = controller;
  const personal = draft.personal;

  const setPersonal = (patch: Partial<typeof personal>): void =>
    update((current) => ({ ...current, personal: { ...current.personal, ...patch } }));

  const setAddress = (patch: Partial<typeof personal.address>): void =>
    update((current) => ({
      ...current,
      personal: { ...current.personal, address: { ...current.personal.address, ...patch } },
    }));

  return (
    <>
      <h2>Name</h2>
      <p className="section-note">
        Use the name as it appears on your legal documents. Applications frequently ask for it
        separately from a preferred name.
      </p>
      <div className="grid grid--2">
        <TextField
          id="legalFirstName"
          label="Legal first name"
          value={personal.legalFirstName ?? ''}
          onChange={(value) => setPersonal({ legalFirstName: value || undefined })}
          error={fieldError('personal.legalFirstName')}
        />
        <TextField
          id="legalMiddleName"
          label="Legal middle name"
          value={personal.legalMiddleName ?? ''}
          onChange={(value) => setPersonal({ legalMiddleName: value || undefined })}
          error={fieldError('personal.legalMiddleName')}
        />
        <TextField
          id="legalLastName"
          label="Legal last name"
          value={personal.legalLastName ?? ''}
          onChange={(value) => setPersonal({ legalLastName: value || undefined })}
          error={fieldError('personal.legalLastName')}
        />
        <TextField
          id="preferredName"
          label="Preferred name"
          value={personal.preferredName ?? ''}
          onChange={(value) => setPersonal({ preferredName: value || undefined })}
          error={fieldError('personal.preferredName')}
        />
        <TextField
          id="pronouns"
          label="Pronouns"
          value={personal.pronouns ?? ''}
          onChange={(value) => setPersonal({ pronouns: value || undefined })}
          hint="Left blank unless you want it offered."
          error={fieldError('personal.pronouns')}
        />
      </div>

      <h2>Contact</h2>
      <div className="grid grid--2">
        <TextField
          id="email"
          label="Email"
          type="email"
          value={personal.email ?? ''}
          onChange={(value) => setPersonal({ email: value || undefined })}
          error={fieldError('personal.email')}
        />
        <TextField
          id="alternateEmail"
          label="Alternate email"
          type="email"
          value={personal.alternateEmail ?? ''}
          onChange={(value) => setPersonal({ alternateEmail: value || undefined })}
          error={fieldError('personal.alternateEmail')}
        />
        <TextField
          id="phone"
          label="Phone"
          type="tel"
          value={personal.phone ?? ''}
          onChange={(value) => setPersonal({ phone: value || undefined })}
          hint="Include the country code if you apply internationally."
          error={fieldError('personal.phone')}
        />
      </div>

      <h2>Address</h2>
      <div className="grid grid--2">
        <TextField
          id="addressLine1"
          label="Street address"
          value={personal.address.line1 ?? ''}
          onChange={(value) => setAddress({ line1: value || undefined })}
          error={fieldError('personal.address.line1')}
        />
        <TextField
          id="addressLine2"
          label="Apartment, suite, unit"
          value={personal.address.line2 ?? ''}
          onChange={(value) => setAddress({ line2: value || undefined })}
          error={fieldError('personal.address.line2')}
        />
        <TextField
          id="addressCity"
          label="City"
          value={personal.address.city ?? ''}
          onChange={(value) => setAddress({ city: value || undefined })}
          error={fieldError('personal.address.city')}
        />
        <TextField
          id="addressState"
          label="State or region"
          value={personal.address.state ?? ''}
          onChange={(value) => setAddress({ state: value || undefined })}
          error={fieldError('personal.address.state')}
        />
        <TextField
          id="addressPostalCode"
          label="Postal code"
          value={personal.address.postalCode ?? ''}
          onChange={(value) => setAddress({ postalCode: value || undefined })}
          error={fieldError('personal.address.postalCode')}
        />
        <TextField
          id="addressCountry"
          label="Country"
          value={personal.address.country ?? ''}
          onChange={(value) => setAddress({ country: value || undefined })}
          error={fieldError('personal.address.country')}
        />
      </div>

      <h2>Links</h2>
      <p className="section-note">Full URLs, including https://.</p>
      <div className="grid grid--2">
        <TextField
          id="linkedin"
          label="LinkedIn"
          type="url"
          value={personal.linkedin ?? ''}
          onChange={(value) => setPersonal({ linkedin: value || undefined })}
          placeholder="https://www.linkedin.com/in/you"
          error={fieldError('personal.linkedin')}
        />
        <TextField
          id="github"
          label="GitHub"
          type="url"
          value={personal.github ?? ''}
          onChange={(value) => setPersonal({ github: value || undefined })}
          placeholder="https://github.com/you"
          error={fieldError('personal.github')}
        />
        <TextField
          id="portfolio"
          label="Portfolio"
          type="url"
          value={personal.portfolio ?? ''}
          onChange={(value) => setPersonal({ portfolio: value || undefined })}
          error={fieldError('personal.portfolio')}
        />
        <TextField
          id="personalWebsite"
          label="Personal website"
          type="url"
          value={personal.personalWebsite ?? ''}
          onChange={(value) => setPersonal({ personalWebsite: value || undefined })}
          error={fieldError('personal.personalWebsite')}
        />
      </div>
    </>
  );
}
