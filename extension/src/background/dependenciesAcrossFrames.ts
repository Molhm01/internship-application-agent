import {
  dependencyDirectiveSchema,
  dependencyRunCompleteSchema,
  describeDependency,
  resolveIntendedAnswer,
  summarizeDependencyRun,
  type ApprovedAnswer,
  type CompanyRelationship,
  type DependencyDirective,
  type DependencyRunSummary,
  type DependencyTrace,
  type DetectedField,
  type Profile,
} from '@internship-agent/shared';
import {
  buildDependencyGraph,
  orderDependencies,
  type GraphField,
} from '../dependencies/dependencyGraph.js';
import { sendToFrame, type FrameTarget } from './frames.js';

/**
 * The Dependency Engine, across every frame of an application.
 *
 * The worker holds two things the page cannot: the applicant's facts, and the
 * graph. It decides what depends on what, what each dependent question means,
 * what its answer is, and — the part that did not exist before — what order the
 * edges run in. The frame fingerprints, waits, rescans and drives.
 *
 * ## Why the graph lives here
 *
 * A dependency is a relationship between two *questions*, and a question's
 * identity comes from the scan: its canonical key, its frame, and which
 * repeating block it sits in. That is worker knowledge. A frame asked to work
 * out "which Country produces this State's options" would have to guess from
 * proximity, and on a page with two education blocks proximity is exactly what
 * gets it wrong.
 */

export interface DependencyRunInput {
  tabId: number;
  frames: readonly FrameTarget[];
  runId: string;
  profile: Profile;
  approvedAnswers: readonly ApprovedAnswer[];
  companyName: string;
  companyRelationship?: CompanyRelationship | undefined;
  /** The latest scan's fields, per frame. */
  fieldsByFrame: ReadonlyMap<number, readonly DetectedField[]>;
}

export interface DependencyRunOutcome {
  edges: readonly DependencyTrace[];
  summary: DependencyRunSummary;
  unreachableFrames: readonly number[];
}

/**
 * A scanned field, reduced to what the graph reasons about.
 *
 * The block id is synthesised from the repeating section and the record index
 * rather than read off the page, because it exists to *separate* — education
 * block 0's controls from block 1's — and two controls are in the same block
 * exactly when those two facts agree.
 */
export function toGraphFields(fields: readonly DetectedField[], frameId: number): GraphField[] {
  return fields.map((field): GraphField => {
    // The section the scanner put the control in, not one guessed from its
    // canonical key. An Education block's country control is classified as
    // plain `country` — deriving its section from that key would place it with
    // the applicant's own address and pair it with the wrong State.
    const section = field.section;
    const recordIndex = field.recordIndex ?? 0;
    return {
      nodeId: field.id,
      intent: field.canonicalKey ?? '',
      label: field.label || field.question || '',
      frameId,
      ...(section ? { repeaterKind: section } : {}),
      ...(section ? { blockId: `${section}:block:${recordIndex}` } : {}),
      ...(field.recordIndex === undefined ? {} : { recordIndex: field.recordIndex }),
      ...(field.dependsOn
        ? {
            conditionalParentNodeId: field.dependsOn.fieldId,
            conditionalParentValue: field.dependsOn.value,
          }
        : {}),
      ...(field.disabled === true ? { disabled: true } : {}),
    };
  });
}

/**
 * Turns the ordered graph into instructions, resolving each dependent's answer.
 *
 * The answer comes from `resolveIntendedAnswer` — the same resolver the Dropdown
 * Engine uses, given the same inputs — so a dependent control and an independent
 * one holding the same question can never be answered differently. A dependent
 * question nobody can answer gets an empty `intendedAnswer`, which the frame
 * reads as "open it, record the choices, select nothing".
 */
export function directivesFor(input: DependencyRunInput): {
  directives: DependencyDirective[];
  nodeCount: number;
  cycleDetected: boolean;
  cyclicEdges: number;
} {
  const directives: DependencyDirective[] = [];
  let nodeCount = 0;
  let cycleDetected = false;
  let cyclicEdges = 0;

  for (const [frameId, fields] of input.fieldsByFrame) {
    const byId = new Map(fields.map((field) => [field.id, field]));
    const graphFields = toGraphFields(fields, frameId);
    const ordered = orderDependencies(buildDependencyGraph(graphFields));
    nodeCount += ordered.nodeIds.length;
    if (ordered.cycleDetected) {
      cycleDetected = true;
      cyclicEdges += ordered.cyclic.length;
    }

    for (const edge of ordered.ordered) {
      const parentField = byId.get(edge.parent.nodeId);
      const dependentField = byId.get(edge.dependent.nodeId);
      if (!parentField || !dependentField) continue;

      const intended = resolveIntendedAnswer({
        canonicalQuestion: dependentField.canonicalKey ?? 'unknown',
        label: dependentField.label || dependentField.question || '',
        sectionContext: dependentField.section ?? '',
        ...(dependentField.recordIndex === undefined
          ? {}
          : { recordIndex: dependentField.recordIndex }),
        profile: input.profile,
        approvedAnswers: input.approvedAnswers,
        companyName: input.companyName,
        ...(input.companyRelationship === undefined
          ? {}
          : { companyRelationship: input.companyRelationship }),
      });

      directives.push(
        dependencyDirectiveSchema.parse({
          parent: edge.parent,
          dependent: edge.dependent,
          dependencyType: edge.dependencyType,
          parentSelector: parentField.selector,
          dependentSelector: dependentField.selector,
          ...(edge.parentRequiredState === undefined
            ? {}
            : { parentRequiredState: edge.parentRequiredState }),
          intendedAnswer: intended.intendedAnswer,
          intendedAnswerSource: intended.source,
          alternativeValues: [...intended.alternativeValues].slice(0, 12),
          ...(intended.searchText ? { searchText: intended.searchText } : {}),
          allowOtherFallback: intended.allowOtherFallback,
          requiresUserConfirmation: intended.requiresUserConfirmation,
          sensitive: intended.sensitive,
        }),
      );
    }
  }

  return { directives, nodeCount, cycleDetected, cyclicEdges };
}

/**
 * Resolves every dependency the page presents.
 *
 * Frames are driven one after another, and directives within a frame in the
 * order the sort produced. Concurrency here would defeat the whole point: the
 * ordering exists so that State is driven after Country has landed, and running
 * both at once restores exactly the race this engine was built to remove.
 */
export async function runDependencyResolution(
  input: DependencyRunInput,
): Promise<DependencyRunOutcome> {
  const started = Date.now();
  const { directives, nodeCount, cycleDetected } = directivesFor(input);
  const edges: DependencyTrace[] = [];
  const unreachable: number[] = [];

  if (directives.length === 0) {
    return {
      edges: [],
      summary: summarizeDependencyRun([], nodeCount, cycleDetected, Date.now() - started),
      unreachableFrames: [],
    };
  }

  const byFrame = new Map<number, DependencyDirective[]>();
  for (const directive of directives) {
    const frameId = directive.dependent.frameId ?? 0;
    byFrame.set(frameId, [...(byFrame.get(frameId) ?? []), directive]);
  }

  for (const [frameId, forFrame] of byFrame) {
    let response: unknown;
    try {
      response = await sendToFrame(input.tabId, frameId, {
        type: 'RUN_DEPENDENCY_RESOLUTION',
        runId: input.runId,
        directives: forFrame,
      });
    } catch {
      // One frame that has gone away fails only its own edges.
      unreachable.push(frameId);
      continue;
    }

    const parsed = dependencyRunCompleteSchema.safeParse(response);
    if (!parsed.success) {
      unreachable.push(frameId);
      continue;
    }
    edges.push(...parsed.data.edges);
  }

  const summary = summarizeDependencyRun(edges, nodeCount, cycleDetected, Date.now() - started);
  if (edges.length > 0) {
    // The one line that answers "did the chain run in order, and where did it
    // stop?". Identities, counts and codes only — never an answer.
    console.info('[agent] dependency engine', edges.map(describeDependency));
  }
  return { edges, summary, unreachableFrames: unreachable };
}
