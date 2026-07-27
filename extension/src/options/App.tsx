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
import { DiagnosticsSection } from './sections/DiagnosticsSection.js';

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

const TABS = [
  { id: 'identity', label: 'Name and contact' },
  { id: 'education', label: 'Education' },
  { id: 'experience', label: 'Work experience' },
  { id: 'projects', label: 'Projects' },
  { id: 'credentials', label: 'Skills and activities' },
  { id: 'eligibility', label: 'Eligibility' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'sensitive', label: 'Sensitive answers' },
  { id: 'documents', label: 'Documents' },
  { id: 'answers', label: 'Approved answers' },
  { id: 'ai', label: 'AI answers' },
  { id: 'connection', label: 'Connection' },
  { id: 'diagnostics', label: 'Diagnostics' },
] as const;

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

  return (
    <div className="options-shell">
      <header className="options-header">
        <div>
          <h1>Internship Application Agent</h1>
          <p className="muted">
            Everything here stays on this machine. The agent never submits an application.
          </p>
        </div>
        {completeness ? (
          <div
            className="completeness"
            title={`${completeness.completeSections} of ${completeness.totalRequiredSections} required sections complete`}
          >
            <span className="completeness__percent">{completeness.percent}%</span>
            <span className="muted">profile complete</span>
          </div>
        ) : null}
      </header>

      <nav aria-label="Settings sections" className="options-nav">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`options-nav__tab${tab === entry.id ? ' options-nav__tab--active' : ''}`}
            aria-current={tab === entry.id ? 'page' : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main className="options-main">
        {loading && isProfileTab(tab) ? <p className="muted">Loading profile…</p> : null}

        {loadError && isProfileTab(tab) ? (
          <div className="result result--bad" role="alert">
            <p>
              <strong>Could not load your profile.</strong> {loadError.message}
            </p>
            <p>{loadError.suggestedAction}</p>
            <button type="button" onClick={controller.reload}>
              Try again
            </button>
          </div>
        ) : null}

        {!loading && !loadError && isProfileTab(tab) ? (
          <>
            {isNew ? (
              <p className="result" role="status">
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
        {tab === 'connection' ? (
          <ConnectionSection onConnectionChanged={controller.reload} />
        ) : null}
        {tab === 'diagnostics' ? <DiagnosticsSection /> : null}
      </main>

      {isProfileTab(tab) && !loading && !loadError ? (
        <footer className="options-footer">
          <div className="options-footer__status" aria-live="polite">
            {saveState.kind === 'saving' ? <span className="muted">Saving…</span> : null}
            {saveState.kind === 'saved' ? (
              <span className="result--ok">Profile saved at {saveState.at}.</span>
            ) : null}
            {saveState.kind === 'invalid' ? (
              <span className="result--bad" role="alert">
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
              <span className="result--bad" role="alert">
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
