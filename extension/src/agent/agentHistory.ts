import {
  AGENT_ACTION_BUDGET,
  AGENT_MAX_REPEATED_FAILURES,
  type AgentDecision,
  type AgentStepTrace,
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
  private questions: string[] = [];

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
      if (!this.questions.includes(decision.question)) this.questions.push(decision.question);
    }
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
    return this.questions;
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
