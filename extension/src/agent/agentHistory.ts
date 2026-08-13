import {
  AGENT_ACTION_BUDGET,
  AGENT_MAX_REPEATED_FAILURES,
  agentPendingQuestionSchema,
  logicalFieldKey,
  type AgentDecision,
  type AgentPendingQuestion,
  type AgentStepTrace,
  type PageObservation,
  type ToolExecutionResult,
} from '@internship-agent/shared';

/**
 * What this run has already tried, and what it must therefore stop trying.
 *
 * An observe → decide → act loop has one characteristic failure, and it is not
 * a wrong action: it is the *same* action forever. The page offers a dropdown
 * the agent cannot open; the next observation looks identical to the last one,
 * because nothing changed; the same decision comes back; and the run spends its
 * whole budget opening one control. Nothing about a single cycle can detect
 * that — only the history can.
 *
 * So this records every attempt keyed by what it was trying to do to what, and
 * the loop consults it *before* asking for the next decision. A tool that has
 * failed on an element three times is off the table for that element, which
 * forces the next decision to be something else — and when there is nothing
 * else, to be an honest stop.
 */

export interface AttemptRecord {
  tool: string;
  /** The question as worded, not the handle: handles change every observation. */
  targetLabel: string;
  succeeded: boolean;
}

export class AgentHistory {
  private readonly steps: AgentStepTrace[] = [];
  private readonly failures = new Map<string, number>();
  private readonly successes = new Set<string>();
  /** Actions that reached the page. What the run reports having done. */
  private actions = 0;
  /** Actions proposed, refused ones included. What the budget is spent from. */
  private attempts = 0;
  /** Which controls have been asked about, independent of the wording used. */
  private readonly asked = new Set<string>();
  /**
   * The question queue, as objects rather than sentences.
   *
   * Keyed by logical key so an entry survives re-observation, and carrying an
   * `answeredAt` that only `recordAnswer` can set. The previous version was a
   * `string[]` of question text, which had two consequences: readiness treated
   * membership as resolution, so asking a question resolved it; and there was
   * nowhere to record an answer, because a list of strings cannot hold one.
   */
  private readonly pending = new Map<string, AgentPendingQuestion>();

  /** A key that survives re-observation, because handles do not. */
  private key(tool: string, label: string): string {
    return `${tool}::${label.toLowerCase().trim()}`;
  }

  record(step: AgentStepTrace, decision: AgentDecision, execution?: ToolExecutionResult): void {
    this.steps.push(step);
    if (decision.kind === 'ACTION' && decision.action) {
      // Two different counts, and conflating them was wrong.
      //
      // `attempts` bounds the run: a decider that keeps proposing a refused
      // action must still burn budget, or a loop of refusals never ends.
      //
      // `actions` is what the run *reports having done to the page*, and a
      // refused action did nothing to the page. Counting it there would put the
      // agent back in the business of reporting work it did not do — which is
      // the whole family of failure this repair exists to close.
      this.attempts += 1;
      if (step.executed) this.actions += 1;
      const key = this.key(decision.action.tool, step.targetLabel);
      // `=== 'VERIFIED'`, not "anything but NOT_VERIFIED". The difference is
      // `VERIFICATION_FAILED` — a control the page was read back on and found
      // *not* to hold the answer — and admitting that to the success set would
      // let the run stop retrying a field it had demonstrably failed to fill.
      if (execution?.executed && step.verification === 'VERIFIED') {
        this.successes.add(key);
        this.failures.delete(key);
      } else {
        this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
      }
    }
    if (decision.kind === 'ASK_USER' && decision.question) {
      // Recorded separately from the question text, and this separation is not
      // tidiness — it is a bug fix.
      //
      // "Have we already asked about this control" used to be answered by
      // searching the question list for the control's *label*, which worked
      // only because every asker happened to use the bare label as the
      // question. The moment one of them asked something more useful — "From
      // Date asks for MM/DD/YYYY and your profile records July 2021. What exact
      // date should be used?" — the search stopped matching, the control looked
      // unasked on every cycle, and the loop asked about it forever.
      //
      // So the two facts are stored as two things: what the applicant is shown,
      // and which control it was about. The second is keyed on the control's
      // identity rather than on any wording.
      this.asked.add(this.askKey(step.targetLabel, step.targetSection, step.targetBlockIndex));
      // Queued as an outstanding question, and it stays outstanding. Asking is
      // not answering — the whole live failure was those two being the same
      // event — so nothing here can set `answeredAt`.
      const key = logicalFieldKey({
        label: step.targetLabel,
        section: step.targetSection,
        blockIndex: step.targetBlockIndex,
      });
      if (!this.pending.has(key)) {
        this.pending.set(
          key,
          agentPendingQuestionSchema.parse({
            logicalKey: key,
            label: step.targetLabel.slice(0, 200),
            section: step.targetSection.slice(0, 120),
            ...(step.targetBlockIndex === undefined ? {} : { blockIndex: step.targetBlockIndex }),
            question: decision.question.slice(0, 500),
            outcome: 'USER_INPUT_REQUIRED',
            askedAt: new Date().toISOString(),
            ...(decision.errorCode ? { errorCode: decision.errorCode } : {}),
          }),
        );
      }
    }
  }

  /**
   * The applicant answered one of the questions.
   *
   * The *only* way an entry leaves the outstanding queue. There is deliberately
   * no agent-side path to this: a run that could mark its own questions
   * answered would be the live failure with an extra step.
   */
  recordAnswer(logicalKey: string): boolean {
    const question = this.pending.get(logicalKey);
    if (!question || question.answeredAt.length > 0) return false;
    this.pending.set(logicalKey, { ...question, answeredAt: new Date().toISOString() });
    return true;
  }

  /** Every question this run raised, answered ones included. */
  allQuestions(): readonly AgentPendingQuestion[] {
    return [...this.pending.values()];
  }

  /** The questions still waiting on the applicant. */
  unansweredQuestions(): readonly AgentPendingQuestion[] {
    return [...this.pending.values()].filter((entry) => entry.answeredAt.length === 0);
  }

  /** Logical keys the applicant has answered, for the readiness predicate. */
  answeredKeys(): string[] {
    return [...this.pending.values()]
      .filter((entry) => entry.answeredAt.length > 0)
      .map((entry) => entry.logicalKey);
  }

  /**
   * Associate user-entered page values with the exact questions they answer.
   *
   * The page is the durable handoff between runs: the agent pauses, the user
   * fills one control, and the next fresh observation proves which logical
   * field changed without retaining the answer itself. Only that one queue
   * entry is marked answered; every other question remains pending.
   */
  reconcileAnswers(observation: PageObservation): number {
    const answeredOnPage = new Set(
      observation.elements
        .filter(
          (element) =>
            element.visible && !element.disabled && element.currentValue.trim().length > 0,
        )
        .map((element) => logicalFieldKey(element)),
    );
    let reconciled = 0;
    for (const question of this.unansweredQuestions()) {
      if (!answeredOnPage.has(question.logicalKey)) continue;
      if (this.recordAnswer(question.logicalKey)) reconciled += 1;
    }
    return reconciled;
  }

  /**
   * Whether this run has already put a question to the applicant about this
   * control.
   *
   * Keyed on label, section and block index together, because a page with three
   * Work Experience blocks has three controls labelled "End Date" and they are
   * three different questions. Keying on the label alone would ask about the
   * first and silently skip the other two.
   */
  askedAbout(target: {
    label: string;
    section?: string;
    blockIndex?: number | undefined;
  }): boolean {
    return this.asked.has(this.askKey(target.label, target.section ?? '', target.blockIndex));
  }

  private askKey(label: string, section: string, blockIndex: number | undefined): string {
    return `${section}::${label}::${blockIndex ?? ''}`;
  }

  /**
   * True when this tool has failed on this control often enough to stop.
   *
   * Keyed on the *label* rather than the element handle. A handle is minted per
   * observation and would make every retry look like a first attempt, which is
   * precisely how a loop hides from a counter that is watching the wrong thing.
   */
  exhausted(tool: string, label: string): boolean {
    return (this.failures.get(this.key(tool, label)) ?? 0) >= AGENT_MAX_REPEATED_FAILURES;
  }

  /**
   * The controls this run tried and could not settle.
   *
   * Distinct from work still to do. A field the agent attempted three times and
   * could not apply is *finished* as far as the agent is concerned — it is now
   * the applicant's — and counting it as pending work would deadlock readiness
   * forever on any control the page will not accept.
   */
  exhaustedLabels(): string[] {
    const labels = new Set<string>();
    for (const [key, count] of this.failures) {
      if (count < AGENT_MAX_REPEATED_FAILURES) continue;
      const label = key.split('::')[1];
      if (label) labels.add(label);
    }
    return [...labels];
  }

  /** True when this control has already been answered successfully this run. */
  settled(tool: string, label: string): boolean {
    return this.successes.has(this.key(tool, label));
  }

  /** Whether the run may take another action at all. */
  budgetExhausted(): boolean {
    return this.attempts >= AGENT_ACTION_BUDGET;
  }

  actionCount(): number {
    return this.actions;
  }

  openQuestions(): readonly string[] {
    return this.unansweredQuestions().map((entry) => entry.question);
  }

  all(): readonly AgentStepTrace[] {
    return this.steps;
  }

  /** How many steps ended with the page's own state confirming the write. */
  verifiedCount(): number {
    return this.steps.filter((step) => step.verification === 'VERIFIED').length;
  }

  /**
   * How many times the agent actually pressed something that would submit.
   *
   * Reported by the loop, which is the only side that knows whether the control
   * an executed action targeted was marked `finalSubmit` in the observation it
   * came from. Counted rather than asserted, so a finished run states it about
   * itself and a test can read it — and so that a bug making the safety layer
   * permissive shows up as a number instead of passing silently.
   */
  private submitPresses = 0;

  /** Called by the loop when an *executed* action targeted a submitting control. */
  recordSubmitPress(): void {
    this.submitPresses += 1;
  }

  submitActionCount(): number {
    return this.submitPresses;
  }
}
