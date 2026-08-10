import type { DependencyNode, DependencyType } from '@internship-agent/shared';

/**
 * Which question produces which other question's answer.
 *
 * This is the thing that did not exist. The run knew that "If other, enter
 * School" belonged to the School dropdown, because the scanner records that edge
 * from the label's own words. It did not know that School belonged to Education
 * State, that Education State belonged to Education Country, or that State
 * belonged to Country — those relationships were nowhere, so nothing could order
 * the work by them, and the ordering that happened was a side effect of a
 * whole-page pass loop running five times and hoping the page settled in between.
 *
 * Everything here is pure: it takes descriptions of controls and returns edges
 * and an order. No DOM, no waiting, no driving — so the claim "State comes after
 * Country, and Education block 1's State comes after Education block 1's
 * Country" can be read in one file and tested without a browser.
 */

/** A control as the graph needs to see it. */
export interface GraphField {
  nodeId: string;
  /** Canonical question key, when the scanner recognised one. */
  intent: string;
  label: string;
  frameId?: number;
  repeaterKind?: string;
  blockId?: string;
  recordIndex?: number;
  /** Set by the scanner for `If yes…` / `If other…` controls. */
  conditionalParentNodeId?: string;
  /** The parent answer that switches a conditional child on. */
  conditionalParentValue?: string;
  /** True when the control is on the page but cannot be used yet. */
  disabled?: boolean;
}

export interface DependencyEdge {
  parent: DependencyNode;
  dependent: DependencyNode;
  dependencyType: DependencyType;
  parentRequiredState?: string;
}

/**
 * The option-refresh chains this engine knows how to drive, parent first.
 *
 * Declared as chains rather than as pairs because that is what they are, and
 * because a pair list cannot express that School comes after State which comes
 * after Country. Each entry is a sequence of canonical intents; consecutive
 * members become one edge.
 *
 * Deliberately a short, closed list. A general "this select looks empty, so
 * something must fill it" rule is what the previous code had, and it cannot say
 * *what* fills it — which is exactly the information needed to wait for the
 * right thing and to order the work.
 */
export const OPTION_REFRESH_CHAINS: ReadonlyArray<readonly string[]> = [
  // The applicant's own address, and any Country → State pair anywhere.
  ['country', 'state'],
  // One education block. Type first: some forms rebuild the whole block around
  // it, and a country chosen before the type is discarded when it does.
  //
  // These are `country` and `state`, not `education_country` and
  // `education_state`, because those are not canonical questions — the scanner
  // classifies an education block's country control as `country` like any
  // other. What keeps it out of the applicant's own Country → State pair is
  // `sameScope`, which requires the section and the record index to agree.
  ['education_type', 'country', 'state', 'school'],
];

/**
 * Intents whose child is revealed rather than repopulated.
 *
 * The wait is different — a subtree gaining a node, not a list gaining options —
 * so the type has to be recorded rather than inferred at wait time.
 */
export const CONTROL_APPEAR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['enrolled_during_internship', 'graduation_date'],
  ['education_status', 'graduation_date'],
];

function nodeOf(field: GraphField): DependencyNode {
  return {
    nodeId: field.nodeId,
    intent: field.intent,
    label: field.label.slice(0, 200),
    ...(field.frameId === undefined ? {} : { frameId: field.frameId }),
    ...(field.repeaterKind === undefined ? {} : { repeaterKind: field.repeaterKind }),
    ...(field.blockId === undefined ? {} : { blockId: field.blockId }),
    ...(field.recordIndex === undefined ? {} : { recordIndex: field.recordIndex }),
  };
}

/**
 * True when two controls are in the same repeating block.
 *
 * The whole of block isolation. Education block 0's Country must produce
 * education block 0's State and nothing else, and two controls are in the same
 * block when they agree on frame, repeater kind, and record index — including
 * agreeing on *not being in one*, which is how the applicant's own Country and
 * State pair up without matching an education block.
 */
export function sameScope(left: GraphField, right: GraphField): boolean {
  return (
    (left.frameId ?? 0) === (right.frameId ?? 0) &&
    (left.repeaterKind ?? '') === (right.repeaterKind ?? '') &&
    (left.recordIndex ?? 0) === (right.recordIndex ?? 0)
  );
}

/**
 * Every dependency the page presents.
 *
 * Two sources, kept separate because they are discovered differently: the
 * conditional edges come from the page's own words, which the scanner has
 * already read, and the option-refresh edges come from the chains above matched
 * against canonical intents within one scope.
 */
export function buildDependencyGraph(fields: readonly GraphField[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const byId = new Map(fields.map((field) => [field.nodeId, field]));

  // Conditional children. The page said so in its own label — "If yes, …" —
  // and the scanner recorded which control it meant.
  for (const field of fields) {
    const parentId = field.conditionalParentNodeId;
    if (parentId === undefined) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;
    edges.push({
      parent: nodeOf(parent),
      dependent: nodeOf(field),
      dependencyType: 'CONDITIONAL_REQUIRED',
      ...(field.conditionalParentValue === undefined
        ? {}
        : { parentRequiredState: field.conditionalParentValue }),
    });
  }

  /**
   * A control the page's own words have already made somebody's child.
   *
   * "If other, enter School/Institution Name" carries the canonical question
   * `school`, exactly like the School dropdown two rows above it — so an
   * option-refresh chain matching on intent adopts it as a *second* School and
   * drives it, writing the institution into a box that applies only when School
   * says "Other". That is the same class of mistake as the relatives failure,
   * reached from the graph instead of from a label: the form is not asking this
   * question, and the run answered it anyway.
   *
   * A conditional child has exactly one parent, and it is the one the page
   * named.
   */
  const isConditionalChild = (field: GraphField): boolean =>
    field.conditionalParentNodeId !== undefined;

  const byIntentInScope = (intent: string, scope: GraphField): GraphField | undefined =>
    fields.find(
      (candidate) =>
        candidate.intent === intent &&
        !isConditionalChild(candidate) &&
        sameScope(candidate, scope),
    );

  // Option-refresh chains, one edge per consecutive pair, resolved within a
  // single scope so a chain can never step from one education block into another.
  for (const chain of OPTION_REFRESH_CHAINS) {
    for (const field of fields) {
      // Never as a *dependent* either. Its parent is the one the page named.
      if (isConditionalChild(field)) continue;
      const position = chain.indexOf(field.intent);
      if (position <= 0) continue;
      const parentIntent = chain[position - 1];
      if (parentIntent === undefined) continue;
      const parent = byIntentInScope(parentIntent, field);
      if (!parent) continue;
      if (
        edges.some(
          (edge) => edge.dependent.nodeId === field.nodeId && edge.parent.nodeId === parent.nodeId,
        )
      ) {
        continue;
      }
      edges.push({
        parent: nodeOf(parent),
        dependent: nodeOf(field),
        // A control the page has explicitly disabled is waiting to be switched
        // on, not waiting for a longer list. The distinction decides what the
        // watcher watches for.
        dependencyType: field.disabled === true ? 'CONTROL_ENABLE' : 'OPTION_REFRESH',
      });
    }
  }

  for (const [parentIntent, childIntent] of CONTROL_APPEAR_PAIRS) {
    for (const field of fields) {
      if (field.intent !== childIntent) continue;
      const parent = byIntentInScope(parentIntent, field);
      if (!parent) continue;
      if (
        edges.some(
          (edge) => edge.dependent.nodeId === field.nodeId && edge.parent.nodeId === parent.nodeId,
        )
      ) {
        continue;
      }
      edges.push({
        parent: nodeOf(parent),
        dependent: nodeOf(field),
        dependencyType: 'CONTROL_APPEAR',
      });
    }
  }

  return edges;
}

export interface OrderedGraph {
  /** Edges in an order where every parent precedes every child of it. */
  ordered: DependencyEdge[];
  /** Edges dropped because they take part in a cycle. */
  cyclic: DependencyEdge[];
  cycleDetected: boolean;
  nodeIds: string[];
}

/**
 * Orders the edges so a parent is always driven before its children.
 *
 * Kahn's algorithm, and the leftover is the point: a node still holding
 * incoming edges when the queue empties is in a cycle, and its edges are
 * *returned* rather than dropped silently. Two controls that each claim to
 * produce the other's options is a page this engine cannot drive, and saying so
 * is worth more than a stack overflow — the rest of the form still fills.
 */
export function orderDependencies(edges: readonly DependencyEdge[]): OrderedGraph {
  const nodeIds = new Set<string>();
  for (const edge of edges) {
    nodeIds.add(edge.parent.nodeId);
    nodeIds.add(edge.dependent.nodeId);
  }

  const incoming = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, 0);
    children.set(id, []);
  }
  for (const edge of edges) {
    incoming.set(edge.dependent.nodeId, (incoming.get(edge.dependent.nodeId) ?? 0) + 1);
    children.get(edge.parent.nodeId)?.push(edge.dependent.nodeId);
  }

  const queue = [...nodeIds].filter((id) => (incoming.get(id) ?? 0) === 0);
  const rank = new Map<string, number>();
  let next = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    rank.set(id, next);
    next += 1;
    for (const child of children.get(id) ?? []) {
      const remaining = (incoming.get(child) ?? 0) - 1;
      incoming.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }

  const ordered: DependencyEdge[] = [];
  const cyclic: DependencyEdge[] = [];
  for (const edge of edges) {
    if (rank.has(edge.parent.nodeId) && rank.has(edge.dependent.nodeId)) ordered.push(edge);
    else cyclic.push(edge);
  }
  ordered.sort(
    (left, right) =>
      (rank.get(left.dependent.nodeId) ?? 0) - (rank.get(right.dependent.nodeId) ?? 0),
  );

  return { ordered, cyclic, cycleDetected: cyclic.length > 0, nodeIds: [...nodeIds] };
}

/**
 * The node ids that must be settled before this one may be driven.
 *
 * Direct parents only. A grandparent is a parent's parent and is enforced by
 * the ordering, not by re-walking the chain here — which also means a chain of
 * any depth costs the same as a chain of two.
 */
export function parentsOf(edges: readonly DependencyEdge[], nodeId: string): DependencyEdge[] {
  return edges.filter((edge) => edge.dependent.nodeId === nodeId);
}
