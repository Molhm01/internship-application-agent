import {
  describeProfileAvailability,
  matchCanonicalQuestion,
  type AgentProgress,
  type AgentRunTrace,
  type ApprovedAnswer,
  type PageObservation,
  type Profile,
} from '@internship-agent/shared';
import { runAgentLoop, type AgentLoopHost } from '../agent/agentLoop.js';
import { observeAcrossFrames, executeAcrossFrames } from './agentAcrossFrames.js';
import type { FrameTarget } from './frames.js';

/**
 * One agent run, from the button to READY_FOR_REVIEW.
 *
 * This is the production entry the "Autofill Application" button reaches. It
 * owns three things and nothing else: the trusted facts the agent may write,
 * the frames it may talk to, and the run's lifecycle.
 *
 * ## Where the answers come from
 *
 * Not from the model. The worker resolves a value for each observed control
 * from the saved profile *before* the model is asked anything, and hands the
 * agent a map of handles to trusted values. The agent's freedom is to decide
 * which control to work on next and when — never what the applicant's state or
 * employer or graduation date is. A value the model invents matches nothing in
 * that map and is refused by the safety layer.
 *
 * That division is the whole reason Agent Mode is safe to point at a real
 * application: the thing that could hallucinate has no access to the facts.
 */

export interface AgentRunInput {
  tabId: number;
  frames: readonly FrameTarget[];
  runId: string;
  buildId: string;
  profile: Profile;
  approvedAnswers: readonly ApprovedAnswer[];
  companyName: string;
  onProgress?: (progress: AgentProgress) => void;
  isCancelled?: () => boolean;
  /** Supplied when a model is configured; the deterministic policy runs otherwise. */
  decide?: AgentLoopHost['decide'];
}

export interface AgentRunResult {
  status: AgentRunTrace['status'];
  trace: AgentRunTrace;
}

/**
 * The values the worker trusts for the controls currently on screen.
 *
 * Built per observation rather than once per run, because the controls change:
 * a second Work Experience block does not exist until Add has been pressed, and
 * its fields cannot be resolved before then.
 *
 * Deliberately simple and deliberately conservative. It resolves from the saved
 * profile through the same canonical questions the rest of the extension uses,
 * and a question it cannot answer gets nothing — which the observer has already
 * classified `UNKNOWN_FACT`, and which the agent will ask about rather than
 * guess at.
 */
export function trustedValuesFor(
  observation: PageObservation,
  profile: Profile,
): Map<string, string> {
  const trusted = new Map<string, string>();
  const personal = profile.personal;
  const address = personal.address;

  for (const element of observation.elements) {
    const intent = element.intent ?? matchCanonicalQuestion(element.label).question;
    const block = element.blockIndex ?? 0;
    const job = profile.experience[block];
    const education = profile.education[block];

    const value = ((): string | undefined => {
      switch (intent) {
        case 'first_name':
          return personal.legalFirstName;
        case 'last_name':
          return personal.legalLastName;
        case 'full_name':
          return [personal.legalFirstName, personal.legalLastName].filter(Boolean).join(' ');
        case 'email':
          return personal.email;
        case 'phone':
          return personal.phone;
        case 'address_line1':
          return address?.line1;
        case 'city':
          return address?.city;
        case 'state':
          // Education blocks have no saved state — see
          // `describeProfileAvailability` — so only the home address answers.
          return element.section === 'education' ? undefined : address?.state;
        case 'postal_code':
          return address?.postalCode;
        case 'country':
          return element.section === 'education' ? undefined : address?.country;
        case 'employer':
          return job?.employer;
        case 'job_title':
          return job?.title;
        case 'employment_start_date':
          return job?.startDate;
        case 'employment_end_date':
          return job?.current ? undefined : job?.endDate;
        case 'employment_type':
          return job?.employmentType;
        case 'reason_for_leaving':
          return job?.reasonForLeaving;
        case 'school':
        case 'institution':
          return education?.institution;
        case 'education_type':
        case 'degree':
          return education?.degree ?? education?.degreeLevel;
        case 'major':
        case 'field_of_study':
        case 'area_of_study':
          return education?.major;
        case 'graduation_date':
          return education?.graduationDate;
        // Answered only from a record that positively states its completion.
        // An entry that says nothing is not evidence of either answer, and
        // guessing "No" because a graduation date is in the future would be
        // stating something the applicant never said.
        case 'graduated':
          return education?.status === 'completed'
            ? 'Yes'
            : education?.status === 'in_progress'
              ? 'No'
              : undefined;
        default:
          return undefined;
      }
    })();

    if (value && value.trim().length > 0) trusted.set(element.elementId, value.trim());
  }
  return trusted;
}

/**
 * Runs the agent over one application.
 *
 * Awaited by the caller, always. The old pipeline's engines could be started
 * and not waited for — which is how a run reported a summary while nine menus
 * were still being driven — and Agent Mode has one execution path precisely so
 * that cannot recur.
 */
export async function runAgentApplication(input: AgentRunInput): Promise<AgentRunResult> {
  const availability = describeProfileAvailability(input.profile);
  const recordCounts = {
    experience: availability.workRecordCount,
    education: availability.educationRecordCount,
  };

  // Resolved once per observation inside the host below, and threaded into the
  // frames so the observer can classify each control's answer policy.
  let latestTrusted = new Map<string, string>();

  const host: AgentLoopHost = {
    runId: input.runId,
    buildId: input.buildId,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.isCancelled ? { isCancelled: input.isCancelled } : {}),
    ...(input.decide ? { decide: input.decide } : {}),
    observe: async () => {
      // The proposed values sent down are keyed by *scan field id*, which the
      // frame knows; the map the loop reasons with is keyed by observation
      // handle, which only the worker knows. Both are rebuilt each cycle.
      const observation = await observeAcrossFrames(
        { tabId: input.tabId, frames: input.frames, runId: input.runId },
        {
          proposedValues: {},
          recordCounts,
          dependencyActive: {},
        },
      );
      latestTrusted = trustedValuesFor(observation, input.profile);
      // The observer classified each control's policy without knowing what the
      // worker could answer, so the classification is refined here, where the
      // trusted values are.
      return {
        ...observation,
        elements: observation.elements.map((element) => {
          const value = latestTrusted.get(element.elementId);
          if (!value) return element;
          // A control the worker can answer is a known fact — unless the
          // observer already ruled otherwise, which it does for protected
          // characteristics and for questions about somebody else. Those
          // rulings are never overturned by having found a value.
          if (element.policy === 'SENSITIVE' || element.policy === 'LEGAL_ACKNOWLEDGMENT') {
            return element;
          }
          return { ...element, policy: 'KNOWN_FACT' as const, proposedValue: value };
        }),
      };
    },
    execute: (call) =>
      executeAcrossFrames({ tabId: input.tabId, frames: input.frames, runId: input.runId }, call),
    trustedValues: () => Promise.resolve(latestTrusted),
  };

  const outcome = await runAgentLoop(host);
  return { status: outcome.status, trace: outcome.trace };
}
