import type { EducationEntry, ExperienceEntry, ProfileUpdate } from '@internship-agent/shared';
import type { ProfileDraftController } from '../useProfileDraft.js';
import { CheckboxField, SelectField, TextField } from '../components/Field.js';
import { EntryList } from '../components/EntryList.js';
import { LineListInput, ListInput } from '../components/ListInput.js';

type Project = ProfileUpdate['projects'][number];
type Certification = ProfileUpdate['certifications'][number];
type Volunteering = ProfileUpdate['volunteering'][number];
type SpokenLanguage = ProfileUpdate['skills']['spokenLanguages'][number];
type Proficiency = SpokenLanguage['proficiency'];

const PROFICIENCIES: ReadonlyArray<{ value: Proficiency; label: string }> = [
  { value: 'basic', label: 'Basic' },
  { value: 'conversational', label: 'Conversational' },
  { value: 'professional', label: 'Professional' },
  { value: 'fluent', label: 'Fluent' },
  { value: 'native', label: 'Native' },
];

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function EducationSection({
  controller,
}: {
  controller: ProfileDraftController;
}): JSX.Element {
  const { draft, update } = controller;

  return (
    <>
      <h2>Education</h2>
      <p className="section-note">
        Add each school you want to be able to report. Leave a field blank if you do not want it
        offered — nothing here is filled in for you.
      </p>
      <EntryList<EducationEntry>
        entries={draft.education}
        onChange={(education) => update((current) => ({ ...current, education }))}
        createEntry={() => ({
          id: newId('edu'),
          institution: '',
          coursework: [],
          honors: [],
          activities: [],
        })}
        addLabel="Add school"
        emptyMessage="No schools added yet."
        titleOf={(entry) => entry.institution}
      >
        {(entry, patch) => (
          <div className="grid grid--2">
            <TextField
              id={`${entry.id}-institution`}
              label="Institution"
              value={entry.institution}
              onChange={(institution) => patch({ institution })}
            />
            <TextField
              id={`${entry.id}-degree`}
              label="Degree"
              value={entry.degree ?? ''}
              onChange={(degree) => patch({ degree: degree || undefined })}
              placeholder="BS, BA, MS"
            />
            <TextField
              id={`${entry.id}-major`}
              label="Major"
              value={entry.major ?? ''}
              onChange={(major) => patch({ major: major || undefined })}
            />
            <TextField
              id={`${entry.id}-minor`}
              label="Minor"
              value={entry.minor ?? ''}
              onChange={(minor) => patch({ minor: minor || undefined })}
            />
            <TextField
              id={`${entry.id}-startDate`}
              label="Start date"
              value={entry.startDate ?? ''}
              onChange={(startDate) => patch({ startDate: startDate || undefined })}
              placeholder="2023-09"
              hint="YYYY, YYYY-MM, or YYYY-MM-DD"
            />
            <TextField
              id={`${entry.id}-graduationDate`}
              label="Graduation date"
              value={entry.graduationDate ?? ''}
              onChange={(graduationDate) => patch({ graduationDate: graduationDate || undefined })}
              placeholder="2027-05"
              hint="YYYY, YYYY-MM, or YYYY-MM-DD"
            />
            <TextField
              id={`${entry.id}-gpa`}
              label="GPA"
              type="number"
              value={entry.gpa === undefined ? '' : String(entry.gpa)}
              onChange={(value) => patch({ gpa: value === '' ? undefined : Number(value) })}
              hint="Left blank means the agent will not answer GPA questions."
            />
            <TextField
              id={`${entry.id}-gpaScale`}
              label="GPA scale"
              type="number"
              value={entry.gpaScale === undefined ? '' : String(entry.gpaScale)}
              onChange={(value) => patch({ gpaScale: value === '' ? undefined : Number(value) })}
              placeholder="4"
            />
            <div className="grid__full">
              <ListInput
                id={`${entry.id}-coursework`}
                label="Relevant coursework"
                values={entry.coursework}
                onChange={(coursework) => patch({ coursework })}
              />
              <ListInput
                id={`${entry.id}-honors`}
                label="Honors"
                values={entry.honors}
                onChange={(honors) => patch({ honors })}
              />
              <ListInput
                id={`${entry.id}-activities`}
                label="Activities"
                values={entry.activities}
                onChange={(activities) => patch({ activities })}
              />
            </div>
          </div>
        )}
      </EntryList>
    </>
  );
}

export function ExperienceSection({
  controller,
}: {
  controller: ProfileDraftController;
}): JSX.Element {
  const { draft, update } = controller;

  return (
    <>
      <h2>Work experience</h2>
      <EntryList<ExperienceEntry>
        entries={draft.experience}
        onChange={(experience) => update((current) => ({ ...current, experience }))}
        createEntry={() => ({
          id: newId('exp'),
          employer: '',
          current: false,
          responsibilities: [],
          achievements: [],
        })}
        addLabel="Add role"
        emptyMessage="No roles added yet."
        titleOf={(entry) => [entry.title, entry.employer].filter(Boolean).join(' — ')}
      >
        {(entry, patch) => (
          <div className="grid grid--2">
            <TextField
              id={`${entry.id}-employer`}
              label="Employer"
              value={entry.employer}
              onChange={(employer) => patch({ employer })}
            />
            <TextField
              id={`${entry.id}-title`}
              label="Title"
              value={entry.title ?? ''}
              onChange={(title) => patch({ title: title || undefined })}
            />
            <TextField
              id={`${entry.id}-location`}
              label="Location"
              value={entry.location ?? ''}
              onChange={(location) => patch({ location: location || undefined })}
            />
            <TextField
              id={`${entry.id}-expStart`}
              label="Start date"
              value={entry.startDate ?? ''}
              onChange={(startDate) => patch({ startDate: startDate || undefined })}
              placeholder="2025-06"
            />
            <TextField
              id={`${entry.id}-expEnd`}
              label="End date"
              value={entry.endDate ?? ''}
              onChange={(endDate) => patch({ endDate: endDate || undefined })}
              placeholder="2025-08"
              hint="Leave blank if this is your current role."
            />
            <CheckboxField
              id={`${entry.id}-current`}
              label="This is my current role"
              checked={entry.current}
              onChange={(current) => patch({ current })}
            />
            <div className="grid__full">
              <LineListInput
                id={`${entry.id}-responsibilities`}
                label="Responsibilities"
                values={entry.responsibilities}
                onChange={(responsibilities) => patch({ responsibilities })}
              />
              <LineListInput
                id={`${entry.id}-achievements`}
                label="Achievements"
                values={entry.achievements}
                onChange={(achievements) => patch({ achievements })}
              />
            </div>
          </div>
        )}
      </EntryList>
    </>
  );
}

export function ProjectsSection({
  controller,
}: {
  controller: ProfileDraftController;
}): JSX.Element {
  const { draft, update } = controller;

  return (
    <>
      <h2>Projects</h2>
      <EntryList<Project>
        entries={draft.projects}
        onChange={(projects) => update((current) => ({ ...current, projects }))}
        createEntry={() => ({
          id: newId('proj'),
          name: '',
          technologies: [],
          accomplishments: [],
        })}
        addLabel="Add project"
        emptyMessage="No projects added yet."
        titleOf={(entry) => entry.name}
      >
        {(entry, patch) => (
          <div className="grid grid--2">
            <TextField
              id={`${entry.id}-name`}
              label="Project name"
              value={entry.name}
              onChange={(name) => patch({ name })}
            />
            <TextField
              id={`${entry.id}-url`}
              label="URL"
              type="url"
              value={entry.url ?? ''}
              onChange={(url) => patch({ url: url || undefined })}
            />
            <TextField
              id={`${entry.id}-projStart`}
              label="Start date"
              value={entry.startDate ?? ''}
              onChange={(startDate) => patch({ startDate: startDate || undefined })}
              placeholder="2026-01"
            />
            <TextField
              id={`${entry.id}-projEnd`}
              label="End date"
              value={entry.endDate ?? ''}
              onChange={(endDate) => patch({ endDate: endDate || undefined })}
            />
            <div className="grid__full">
              <TextField
                id={`${entry.id}-description`}
                label="Description"
                multiline
                value={entry.description ?? ''}
                onChange={(description) => patch({ description: description || undefined })}
              />
              <ListInput
                id={`${entry.id}-technologies`}
                label="Technologies"
                values={entry.technologies}
                onChange={(technologies) => patch({ technologies })}
              />
              <LineListInput
                id={`${entry.id}-accomplishments`}
                label="Accomplishments"
                values={entry.accomplishments}
                onChange={(accomplishments) => patch({ accomplishments })}
              />
            </div>
          </div>
        )}
      </EntryList>
    </>
  );
}

export function CredentialsSection({
  controller,
}: {
  controller: ProfileDraftController;
}): JSX.Element {
  const { draft, update } = controller;
  const skills = draft.skills;

  const setSkills = (patch: Partial<typeof skills>): void =>
    update((current) => ({ ...current, skills: { ...current.skills, ...patch } }));

  return (
    <>
      <h2>Skills</h2>
      <ListInput
        id="technicalSkills"
        label="Technical skills"
        values={skills.technical}
        onChange={(technical) => setSkills({ technical })}
      />
      <ListInput
        id="programmingLanguages"
        label="Programming languages"
        values={skills.programmingLanguages}
        onChange={(programmingLanguages) => setSkills({ programmingLanguages })}
      />
      <ListInput
        id="engineeringSoftware"
        label="Engineering software"
        values={skills.engineeringSoftware}
        onChange={(engineeringSoftware) => setSkills({ engineeringSoftware })}
        placeholder="Altium, SolidWorks, Cadence"
      />
      <ListInput
        id="hardwareSkills"
        label="Hardware skills"
        values={skills.hardware}
        onChange={(hardware) => setSkills({ hardware })}
        placeholder="Oscilloscope, soldering, FPGA bring-up"
      />

      <h3>Spoken languages</h3>
      <EntryList<SpokenLanguage & { id: string }>
        entries={skills.spokenLanguages.map((entry, index) => ({ id: `lang-${index}`, ...entry }))}
        onChange={(entries) =>
          setSkills({
            spokenLanguages: entries.map(({ language, proficiency }) => ({
              language,
              proficiency,
            })),
          })
        }
        createEntry={() => ({ id: newId('lang'), language: '', proficiency: 'conversational' })}
        addLabel="Add language"
        emptyMessage="No spoken languages added yet."
        titleOf={(entry) => entry.language}
      >
        {(entry, patch) => (
          <div className="grid grid--2">
            <TextField
              id={`${entry.id}-language`}
              label="Language"
              value={entry.language}
              onChange={(language) => patch({ language })}
            />
            <SelectField<Proficiency>
              id={`${entry.id}-proficiency`}
              label="Proficiency"
              value={entry.proficiency}
              options={PROFICIENCIES}
              onChange={(proficiency) => patch({ proficiency })}
            />
          </div>
        )}
      </EntryList>

      <h2>Certifications</h2>
      <EntryList<Certification>
        entries={draft.certifications}
        onChange={(certifications) => update((current) => ({ ...current, certifications }))}
        createEntry={() => ({ id: newId('cert'), name: '' })}
        addLabel="Add certification"
        emptyMessage="No certifications added yet."
        titleOf={(entry) => entry.name}
      >
        {(entry, patch) => (
          <div className="grid grid--2">
            <TextField
              id={`${entry.id}-certName`}
              label="Name"
              value={entry.name}
              onChange={(name) => patch({ name })}
            />
            <TextField
              id={`${entry.id}-issuer`}
              label="Issuer"
              value={entry.issuer ?? ''}
              onChange={(issuer) => patch({ issuer: issuer || undefined })}
            />
            <TextField
              id={`${entry.id}-issueDate`}
              label="Issue date"
              value={entry.issueDate ?? ''}
              onChange={(issueDate) => patch({ issueDate: issueDate || undefined })}
              placeholder="2026-03"
            />
            <TextField
              id={`${entry.id}-expiration`}
              label="Expiration date"
              value={entry.expirationDate ?? ''}
              onChange={(expirationDate) => patch({ expirationDate: expirationDate || undefined })}
            />
            <TextField
              id={`${entry.id}-credentialId`}
              label="Credential ID"
              value={entry.credentialId ?? ''}
              onChange={(credentialId) => patch({ credentialId: credentialId || undefined })}
            />
          </div>
        )}
      </EntryList>

      <h2>Activities and volunteering</h2>
      <EntryList<Volunteering>
        entries={draft.volunteering}
        onChange={(volunteering) => update((current) => ({ ...current, volunteering }))}
        createEntry={() => ({ id: newId('vol'), organization: '' })}
        addLabel="Add activity"
        emptyMessage="No activities added yet."
        titleOf={(entry) => entry.organization}
      >
        {(entry, patch) => (
          <div className="grid grid--2">
            <TextField
              id={`${entry.id}-organization`}
              label="Organization"
              value={entry.organization}
              onChange={(organization) => patch({ organization })}
            />
            <TextField
              id={`${entry.id}-role`}
              label="Role"
              value={entry.role ?? ''}
              onChange={(role) => patch({ role: role || undefined })}
            />
            <TextField
              id={`${entry.id}-volStart`}
              label="Start date"
              value={entry.startDate ?? ''}
              onChange={(startDate) => patch({ startDate: startDate || undefined })}
            />
            <TextField
              id={`${entry.id}-volEnd`}
              label="End date"
              value={entry.endDate ?? ''}
              onChange={(endDate) => patch({ endDate: endDate || undefined })}
            />
            <div className="grid__full">
              <TextField
                id={`${entry.id}-volDescription`}
                label="Description"
                multiline
                value={entry.description ?? ''}
                onChange={(description) => patch({ description: description || undefined })}
              />
            </div>
          </div>
        )}
      </EntryList>
    </>
  );
}
