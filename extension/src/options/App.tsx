import { useState } from 'react';
import { useProfileDraft } from './useProfileDraft.js';
import { IdentitySection } from './sections/IdentitySection.js';
import {
  CredentialsSection,
  EducationSection,
  ExperienceSection,
  ProjectsSection,
} from './sections/HistorySection.js';
import { EligibilitySection, PreferencesSection } from './sections/EligibilitySection.js';
import { SensitiveSection } from './sections/SensitiveSection.js';
import { DocumentsSection } from './sections/DocumentsSection.js';
import { AnswersSection } from './sections/AnswersSection.js';
import { ConnectionSection } from './sections/ConnectionSection.js';
import { AiSettingsSection } from './sections/AiSettingsSection.js';
import { EmployerAccountsSection } from './sections/EmployerAccountsSection.js';
import { DiagnosticsSection } from './sections/DiagnosticsSection.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ErrorState, LoadingState, Skeleton } from '../components/Feedback.js';

/** Tabs whose content is part of the profile record and share one save button. */
const PROFILE_TABS = [
  'identity',
  'education',
  'experience',
  'projects',
  'credentials',
  'eligibility',
  'preferences',
  'sensitive',
] as const;

/**
 * The four things settings actually contains.
 *
 * Fourteen tabs in one wrapping row is a list, not a structure: it gives the
 * connection settings the same weight as the applicant's work history and makes
 * the reader scan all fourteen to find either. Grouping them says what kind of
 * thing each one is — who you are, what you have already decided to answer, the
 * files you attach, and the machinery underneath.
 */
const GROUPS = [
  { id: 'profile', label: 'Profile' },
  { id: 'answers', label: 'Answers' },
  { id: 'files', label: 'Files' },
  { id: 'system', label: 'System' },
] as const;

type GroupId = (typeof GROUPS)[number]['id'];

const TABS = [
  { id: 'identity', label: 'Name and contact', group: 'profile', icon: 'user' },
  { id: 'education', label: 'Education', group: 'profile', icon: 'layers' },
  { id: 'experience', label: 'Work experience', group: 'profile', icon: 'clock' },
  { id: 'projects', label: 'Projects', group: 'profile', icon: 'file' },
  { id: 'credentials', label: 'Skills and activities', group: 'profile', icon: 'activity' },
  { id: 'eligibility', label: 'Eligibility', group: 'profile', icon: 'check' },
  { id: 'preferences', label: 'Preferences', group: 'profile', icon: 'settings' },
  { id: 'sensitive', label: 'Sensitive answers', group: 'answers', icon: 'lock' },
  { id: 'answers', label: 'Approved answers', group: 'answers', icon: 'check-double' },
  { id: 'ai', label: 'AI answers', group: 'answers', icon: 'cpu' },
  { id: 'documents', label: 'Documents', group: 'files', icon: 'file' },
  { id: 'employer-accounts', label: 'Employer accounts', group: 'system', icon: 'shield' },
  { id: 'connection', label: 'Connection', group: 'system', icon: 'server' },
  { id: 'diagnostics', label: 'Diagnostics', group: 'system', icon: 'search' },
] as const satisfies readonly {
  id: string;
  label: string;
  group: GroupId;
  icon: IconName;
}[];

type TabId = (typeof TABS)[number]['id'];

function isProfileTab(tab: TabId): boolean {
  return (PROFILE_TABS as readonly string[]).includes(tab);
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<TabId>('identity');
  const controller = useProfileDraft();
  const { completeness, saveState, dirty, loading, loadError, isNew } = controller;

  const incompleteRequired =
    completeness?.sections.filter((section) => section.required && !section.complete) ?? [];
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  return (
    <div className="options-shell">
      <header className="options-header">
        <div className="options-header__identity">
          <span className="options-header__mark" aria-hidden="true">
            <Icon name="activity" size={15} />
          </span>
          <div>
            <h1>Internship Application Agent</h1>
            <p className="muted">
              Everything here stays on this machine. The agent never submits an application.
            </p>
          </div>
        </div>
        {completeness ? (
          <div
            className="completeness"
            title={`${completeness.completeSections} of ${completeness.totalRequiredSections} required sections complete`}
          >
            <span className="completeness__percent">{completeness.percent}%</span>
            <span className="muted">profile complete</span>
            <div
              className="progress-track completeness__track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={completeness.percent}
              aria-label="Profile completeness"
            >
              <div
                className={`progress-fill${completeness.percent === 100 ? ' progress-fill--verified' : ''}`}
                style={{ width: `${completeness.percent}%` }}
              />
            </div>
          </div>
        ) : null}
      </header>

      <div className="options-body">
        {/*
          Deliberately buttons in a nav rather than an ARIA tablist. The panels
          are whole settings pages with their own headings and their own save
          state, and announcing them as tab panels tells a screen-reader user
          they are switching views inside one form when they are not.
        */}
        <nav aria-label="Settings sections" className="options-nav">
          {GROUPS.map((group) => (
            <div className="options-nav__group" key={group.id}>
              <p className="eyebrow options-nav__grouplabel">{group.label}</p>
              {TABS.filter((entry) => entry.group === group.id).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`options-nav__tab${tab === entry.id ? ' options-nav__tab--active' : ''}`}
                  aria-current={tab === entry.id ? 'page' : undefined}
                  onClick={() => setTab(entry.id)}
                >
                  <Icon name={entry.icon} size={13} aria-hidden="true" />
                  {entry.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="options-main" aria-labelledby="options-section-title">
          {/*
            A breadcrumb rather than a page title. Every section already opens
            with its own heading — "Work authorization", "Register a document" —
            and repeating the nav label above them would put two titles on the
            page saying almost the same thing. This says where you are; the
            section says what it is.
          */}
          <p className="options-main__crumb" id="options-section-title">
            {GROUPS.find((group) => group.id === current.group)?.label}
            <span aria-hidden="true">/</span>
            <span className="options-main__crumb-current">{current.label}</span>
          </p>

          {loading && isProfileTab(tab) ? (
            <>
              <LoadingState
                label="Loading profile…"
                detail="Reading your saved profile from the local agent server."
              />
              <Skeleton rows={4} variant="row" />
            </>
          ) : null}

          {loadError && isProfileTab(tab) ? (
            <ErrorState
              title="Could not load your profile."
              body={loadError.message}
              action={loadError.suggestedAction}
              onRetry={controller.reload}
              retryLabel="Try again"
            />
          ) : null}

          {!loading && !loadError && isProfileTab(tab) ? (
            <>
              {isNew ? (
                <p className="callout callout--accent" role="status">
                  <strong>No profile found. Create your profile.</strong> Fill in what you can and
                  press Save profile — blank fields stay blank, and the agent treats them as
                  unanswered rather than guessing.
                </p>
              ) : null}

              {tab === 'identity' ? <IdentitySection controller={controller} /> : null}
              {tab === 'education' ? <EducationSection controller={controller} /> : null}
              {tab === 'experience' ? <ExperienceSection controller={controller} /> : null}
              {tab === 'projects' ? <ProjectsSection controller={controller} /> : null}
              {tab === 'credentials' ? <CredentialsSection controller={controller} /> : null}
              {tab === 'eligibility' ? <EligibilitySection controller={controller} /> : null}
              {tab === 'preferences' ? <PreferencesSection controller={controller} /> : null}
              {tab === 'sensitive' ? <SensitiveSection controller={controller} /> : null}
            </>
          ) : null}

          {tab === 'documents' ? <DocumentsSection /> : null}
          {tab === 'answers' ? <AnswersSection /> : null}
          {tab === 'ai' ? <AiSettingsSection /> : null}
          {tab === 'employer-accounts' ? <EmployerAccountsSection /> : null}
          {tab === 'connection' ? (
            <ConnectionSection onConnectionChanged={controller.reload} />
          ) : null}
          {tab === 'diagnostics' ? <DiagnosticsSection /> : null}
        </main>
      </div>

      {isProfileTab(tab) && !loading && !loadError ? (
        <footer className="options-footer">
          <div className="options-footer__status" aria-live="polite">
            {saveState.kind === 'saving' ? <span className="muted">Saving…</span> : null}
            {saveState.kind === 'saved' ? (
              <span className="options-footer__ok">
                <span className="dot dot--ok" aria-hidden="true" />
                Profile saved at {saveState.at}.
              </span>
            ) : null}
            {saveState.kind === 'invalid' ? (
              <span className="options-footer__bad" role="alert">
                {Object.keys(saveState.fieldErrors).length}{' '}
                {Object.keys(saveState.fieldErrors).length === 1
                  ? 'field needs attention'
                  : 'fields need attention'}
                :{' '}
                {Object.entries(saveState.fieldErrors)
                  .slice(0, 3)
                  .map(([field, message]) => `${field} (${message})`)
                  .join(', ')}
                . Nothing was saved.
              </span>
            ) : null}
            {saveState.kind === 'error' ? (
              <span className="options-footer__bad" role="alert">
                {saveState.error.message} {saveState.error.suggestedAction}
              </span>
            ) : null}
            {saveState.kind === 'idle' && dirty ? (
              <span className="muted">Unsaved changes.</span>
            ) : null}
            {saveState.kind === 'idle' && !dirty && !isNew ? (
              <span className="muted">
                {incompleteRequired.length === 0
                  ? 'All required sections are complete.'
                  : `Still missing: ${incompleteRequired.map((section) => section.label).join(', ')}.`}
              </span>
            ) : null}
          </div>

          <button
            className="primary"
            type="button"
            onClick={controller.save}
            disabled={saveState.kind === 'saving' || !dirty}
          >
            {saveState.kind === 'saving' ? 'Saving…' : 'Save profile'}
          </button>
        </footer>
      ) : null}
    </div>
  );
}
