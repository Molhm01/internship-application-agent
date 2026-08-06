# Profile synchronization diagnostic

Collected 2026-08-05 against the working tree of `Internship-Agent-Recovery`
(`3d4b2d9`) and `Internship-AI` (`99ee153`), reading the two live SQLite
databases directly.

**No personal value appears in this document.** Every observation about stored
data is reported as a key name plus `present` / `empty` / a row count.

---

## 1. The data path, as it actually runs

```
Internship Pilot profile page
  └─ POST /api/profile/*            ──►  ApplicationProfile (one row, id="default")
                                         Experience / Project / Education (structured tables)
                                         ResumeFact (facts extracted from an uploaded résumé)
                                         ApprovedAnswer
"Apply with Application Agent"
  └─ applyWithApplicationAgent()
       ├─ fetchProfileBundlePart()   ──►  GET /api/application-bundle
       │                                   └─ buildProfileSnapshot(row, {facts, experiences,
       │                                                                 projects, educations})
       ├─ fetchDocumentPdf() × 1–2   ──►  GeneratedDocument bytes
       └─ sendApplicationBundle()    ──►  window.postMessage (bundle bridge)
                                          │
extension content script  bundleBridge.ts │  validates applicationBundleTransferSchema
  └─ chrome.runtime.sendMessage('SAVE_APPLICATION_BUNDLE')
       └─ saveBundle()               ──►  IndexedDB `internship-agent-bundles`
                                          (bundle row + document blobs)

Autofill run
  └─ buildPlan()
       ├─ bundleForUrl(url)          ──►  bundle.profile          ◄── source A
       ├─ getProfile()               ──►  agent server /profile   ◄── source B
       │                                   └─ local-data/agent.db, table `profile`, JSON blob
       └─ profile = bundle?.profile ?? profileResult.data?.profile
             └─ buildDeterministicPlan(scan, profile, answers, document)

Extension settings (options page)
  └─ useProfileDraft()  ── reads and writes **source B only**
```

## 2. Every separate profile representation currently in use

| #   | Representation                                                                                         | Owner                       | Storage               | Reaches autofill?                                        |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------- | -------------------------------------------------------- |
| 1   | `ApplicationProfile` row (flat columns)                                                                | Internship Pilot            | `dev.db`              | Yes, via the snapshot                                    |
| 2   | `Experience` / `Project` / `Education` tables                                                          | Internship Pilot            | `dev.db`              | Yes, via the snapshot                                    |
| 3   | `ResumeFact` rows                                                                                      | Internship Pilot            | `dev.db`              | Partly — see §5                                          |
| 4   | `UserProfile` / `ApplicationPreferences` / `SensitiveAnswerPreferences`                                | Internship Pilot (auth-era) | `dev.db`              | **No** — never read by the bundle route                  |
| 5   | `ProfileSnapshot` (`profileSnapshot.ts`)                                                               | Internship Pilot            | in-flight JSON        | Yes                                                      |
| 6   | `applicationBundleTransferSchema.profile`                                                              | shared contract             | postMessage payload   | Yes                                                      |
| 7   | `applicationBundleSchema.profile`                                                                      | extension                   | IndexedDB             | Yes (source A)                                           |
| 8   | `profileSchema` blob in `profile.data`                                                                 | Agent server                | `local-data/agent.db` | Yes (source B)                                           |
| 9   | Agent server tables `education`, `experience`, `projects`, `activities`, `volunteering`, `eligibility` | Agent server                | `local-data/agent.db` | **No** — all empty, and nothing reads them into the plan |

There is no legacy `chrome.storage` profile: the extension has never kept its
own copy. Its settings page is a thin editor over representation 8.

## 3. Fields present in each source (key names only)

### 3.1 `ApplicationProfile` (Internship Pilot) — observed

Present: `id, fullName, email, phone, linkedin, school, updatedAt,
clearanceEligible, eeoDisabilityStatus, eeoGender, eeoRaceEthnicity,
eeoVeteranStatus, requiresSponsorship, workAuthorization, addressCity,
addressState, addressStreet, addressZip, locationPreferences, previousSchool,
willingToRelocate, countryOfResidence, legalFirstName, legalLastName, pronouns,
phoneCountryCode, degreeType, major, graduationDate, gpa, relevantCoursework,
earliestStartDate, hasDriversLicense, meetsMinimumAge, applicationEmail,
preferredUsername, wantsAccountCreationHelp, noMiddleName, metroRegion,
preferredWebsiteField, highestDegreeAwarded, salaryStrategy,
marketingTextConsent, employerPortalStrategy`

Empty: `github, website, internshipTermAvailability, preferredName,
salaryAnswerPreference, legalMiddleName, alternateEmail, portfolio,
educationLevel, minor, educationStartDate, gpaScale, remotePreference,
referralSource, addressLine2, suffix, salaryMinimum, securityClearanceStatus`

### 3.2 Structured tables (Internship Pilot) — observed row counts

| Table                     | Rows   |
| ------------------------- | ------ |
| `Experience`              | **0**  |
| `Project`                 | **0**  |
| `Education`               | **0**  |
| `ResumeFact`              | **51** |
| `ApprovedAnswer`          | 1      |
| `GeneratedDocument`       | 135    |
| `CompanyRelationshipFact` | 1      |
| `UserProfile`             | **0**  |

`ResumeFact` breakdown by `type` (all `status = approved`):
`activity` 3, `coursework` 6, `education` 2, `experience` 3, `gpa` 1,
`graduationDate` 1, `project` 3, `skill` 32.

### 3.3 Agent server profile blob — observed

Present: `version, id, personal.legalFirstName, personal.legalLastName,
personal.email, personal.phone, personal.address.line1, personal.address.city,
personal.address.state, personal.address.postalCode, personal.address.country,
personal.linkedin, updatedAt`

Empty arrays: `education[], experience[], projects[], certifications[],
volunteering[], skills.technical[], skills.programmingLanguages[],
skills.engineeringSoftware[], skills.hardware[], skills.spokenLanguages[],
preferences.targetRoles[], preferences.industries[],
preferences.preferredLocations[], preferences.resumeSelectionRules[],
sensitivePolicies[]`

Absent entirely: `personal.phoneCountryCode`, `eligibility.*`,
`highestCompletedDegree`, `currentDegreeInProgress`.

Agent server tables `education`, `experience`, `projects`, `activities`,
`volunteering`, `eligibility`, `documents`, `approved_answers`: **0 rows each**.

## 4. Schema / version mismatch

- `PROFILE_SNAPSHOT_VERSION` (website) = 2; `CURRENT_BUNDLE_VERSION`
  (extension) = 2; `CURRENT_PROFILE_VERSION` (shared) = 2. These agree, so no
  bundle is being rejected on version grounds.
- The stored agent-server blob carries `version` from an earlier write and is
  never migrated — `profileSchema.version` merely defaults to 1 and nothing
  compares it against `CURRENT_PROFILE_VERSION`. A version field that is never
  read cannot detect drift.
- The canonical contract has **no** `phoneType`, `addressType`, `degreeLevel`,
  `sourceAttribution`, `employerPortalStrategy`, organization/activity lists, or
  document references, even though `CANONICAL_QUESTIONS` already contains
  `phone_type`, `address_type`, `degree_level` and the scanner detects them.
  Those questions therefore have a detector and no possible answer.

## 5. Fields dropped during serialization (website → snapshot)

`buildProfileSnapshot` falls back to `ResumeFact` rows when a structured table
is empty — but only for two of the four sections:

| Section    | Structured source                       | Résumé-fact fallback      | Result with the observed data                                      |
| ---------- | --------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| experience | `Experience` (0 rows)                   | yes (`type = experience`) | 3 entries survive                                                  |
| projects   | `Project` (0 rows)                      | yes (`type = project`)    | 3 entries survive                                                  |
| education  | `Education` (0 rows)                    | **none**                  | only the single entry synthesized from `ApplicationProfile.school` |
| skills     | —                                       | yes (`type = skill`)      | 32 entries survive                                                 |
| activities | —                                       | **none**                  | 3 `activity` facts dropped entirely                                |
| coursework | `ApplicationProfile.relevantCoursework` | **none**                  | 6 `coursework` facts dropped                                       |

Also dropped by the snapshot type itself: `SnapshotProject` has no `url`,
`startDate`, or `endDate` even though `projectEntrySchema` accepts all three and
the `Project` table stores `startDate`/`endDate`. `SnapshotEducation` has no
`status`, so no snapshot entry can ever answer "highest degree awarded" from an
education row.

## 6. Fields dropped during bundle creation

None. `applyWithApplicationAgent` copies `profile`, `approvedAnswers`,
`accountPreferences`, and `companyRelationship` through unchanged, and
`applicationBundleTransferSchema` accepts the whole `profileSchema`. Unknown
keys are stripped by Zod, which is what silently removes anything the website
adds without a matching contract change — but nothing is being added today.

## 7. Fields dropped during Agent-server storage

**Everything, because nothing is ever written.** There is no code path anywhere
in this repository that takes `bundle.profile` and stores it on the agent
server. `saveBundle` writes the snapshot into IndexedDB only. The agent server's
`PUT /profile` is called from exactly one place: the settings page save button.

Consequences, all of which match the reported symptoms:

- The settings page reads representation 8, which contains only what the user
  typed into it by hand — first name, last name, email, phone, address,
  LinkedIn. Every other section renders empty, so the extension appears to be
  asking for information the user already gave Internship Pilot.
- The agent server's own `education` / `experience` / `projects` tables are
  empty and unread.
- A run started **without** a bundle (the user opened the employer page
  themselves, or the bundle no longer matches the URL) falls back to
  representation 8 and therefore has no experience, education, projects,
  skills, eligibility, or sensitive policies at all. That is exactly the set of
  fields reported as unfillable, and exactly the complement of the set reported
  as working.

## 8. Legacy profile fallback paths

- `buildProfileSnapshot(row, sources)` accepts a bare `FactRow[]` as its second
  argument for callers that predate structured tables. Still live.
- `ApplicationProfile.school` synthesizes an education entry with the fixed id
  `education-primary`, which collides by design with nothing but is also not a
  stable id derived from the row it came from.
- `UserProfile` and friends (representation 4) are a newer, unfinished profile
  model with 0 rows and no reader in the bundle path. They are dead weight, not
  a fallback.
- The extension has no legacy `chrome.storage` profile to migrate.

## 9. Non-profile root causes recorded while tracing

These are separate defects found on the same paths and fixed alongside:

1. **Phone country code has no answer to give.** `phoneCountryCode` exists in
   `personalInfoSchema` and in the `ApplicationProfile` table and is read by
   nothing. `deterministicMatcher` answers `phone_country_code` by deriving a
   dial code from `personal.address.country`, so a profile whose country is
   absent — such as any profile assembled by the settings page before the
   address section is filled — has no value for the control at all.
2. **`normalizeQuestion` recognizes only the words "country code", "dialling
   code", "phone code", "calling code".** A widget that labels its selector
   "Code", "Country/Region", or nothing at all (the common
   `intl-tel-input`-style flag button) is never classified as
   `phone_country_code`.
3. **Hidden file inputs are never scanned.** `shouldIgnore` rejects any element
   failing `isVisibleControl`, which rejects `display:none`. The standard ATS
   pattern — a visually-hidden `<input type="file">` driven by a styled button —
   therefore produces no upload field, no upload action, and no résumé.
4. **The agent server holds 0 documents**, so the "default résumé" fallback has
   nothing to fall back to on this machine.
5. Country selection succeeds on the committed iCIMS lab fixture
   (`local-data/autofill-run-evidence.json`, `Country * → FILLED_VERIFIED`), so
   the live failure is a control shape the fixtures do not yet cover, not a
   missing value. The saved country **is** present in representation 8.

## 10. Exact root cause

> The Agent server profile and the Internship Pilot profile are two independent
> stores, and nothing has ever copied one into the other. The extension's
> settings page edits the Agent server copy; the website's Apply flow fills the
> bundle copy. The four fields that autofill — first name, last name, email,
> phone — are precisely the fields the user happened to type into the settings
> page by hand. Experience, education, projects, and skills exist only in
> Internship Pilot, so they are absent from every code path that does not have a
> live, URL-matching bundle, and absent from the settings UI unconditionally.

A secondary cause compounds it: on this machine the Internship Pilot structured
tables are empty and the data lives in `ResumeFact`, and the snapshot builder
has a résumé-fact fallback for experience, projects, and skills but **not** for
education, activities, or coursework — so even the bundle copy is incomplete.

## 11. Defects found while building the fixture, and fixed

These were found by driving the new fixture
(`tests/fixtures/lab/profile-sync-application.html`) through the real scanner,
planner, and executor rather than by reading the code. Each is a live-page
failure the committed lab fixtures did not reproduce.

1. **The country combobox was sent a machine code as its search query.**
   `selectComboboxOption` fell back to the _option's value_ when no search text
   was supplied. A Country control whose "United States of America" option has
   `value="US"` therefore had "US" typed into its search box; no label contains
   that string, the searchable list filtered itself to nothing, and the run
   finished with "US" in the box, the menu open, and no country chosen. Fixed by
   preferring the matched option's **label**.
2. **A structural rule guessed the phone country code, and guessed wrong.**
   `structuralFields.ts` preferred the first option matching
   `/united states|u\.?s\.?a?|\+1\b/`, which on a real list beginning
   "Australia (+61), Canada (+1), …" selects **Canada**. It also asserted the
   applicant was American rather than reading what they had told us. The rule is
   deleted; the dialling code is now a stored profile value matched exactly
   against the page's options.
3. **Structural rules outranked the applicant's own answers.** They ran ahead of
   the profile match, so a stored `phoneType` could not win over a guess made
   from the form's wording. They now run only when the profile is silent.
4. **Hidden file inputs were invisible to the scanner and refused by the
   executor.** Both `shouldIgnore` and the executor's `isVisible` guard rejected
   the standard ATS pattern — a `display:none` `<input type="file">` driven by a
   styled button. Both now make a narrow exception for file inputs, which are
   populated programmatically and whose visibility says nothing about whether
   they can be filled.
5. **A combobox's own popup was scanned as a second question.** The
   `[role="listbox"]` a combobox names in `aria-controls` was reported as its own
   Country control, so the run tried to fill Country twice and verified neither.
6. **An upload verified on "a file is attached" rather than "_this_ file is
   attached."** The executor now compares the control's reported filename
   against the name it actually wrote.

## 12. Verified against the live data

`buildProfileSnapshot` run against the real `Internship-AI/dev.db`, counts only:

| Section             | Before     | After |
| ------------------- | ---------- | ----- |
| `education`         | 1          | **3** |
| `experience`        | 3          | 3     |
| `projects`          | 3          | 3     |
| `skills.technical`  | 32         | 32    |
| `activities`        | — (no key) | **3** |
| `organizations`     | — (no key) | 0     |
| `sensitivePolicies` | 4          | 4     |

Snapshot version 3. `personal` now carries `phoneCountryCode`; `address` carries
`line1, city, state, postalCode, country, metroRegion`.

## 13. What the fix has to do

1. Extend the canonical contract to cover every key the brief names, with a
   version and a migration, so no representation can hold a fact the others
   cannot express.
2. Give the snapshot builder a résumé-fact fallback for education and
   activities, and carry project dates and URLs.
3. Import the Internship Pilot snapshot into the Agent server profile through a
   non-destructive merge, on bundle save and on settings load, so both copies
   converge and neither can overwrite a populated value with an empty one.
4. Make `phoneCountryCode` a first-class stored answer rather than a derivation
   of the address country, and widen phone-code question detection.
5. Scan hidden file inputs and button-activated file controls.
6. Report all of the above at key level in Diagnostics so the next divergence is
   visible before an application, not after one.
