import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseChange, WorkflowError, type Change } from './index.js';
import { canParent, deriveLocalNodeStatus, readBacklogSidecar, type BacklogSidecar, type LocalNodeStatus } from './backlog.js';
import { scanChangeDirectories, type ChangeDirectoryEntry, type ChangeScope } from './paths.js';

export interface ChangeTreeNode {
  relativePath: string;
  id: string;
  name: string;
  directory: string;
  scope: ChangeScope;
  closed: boolean;
  change: Change;
  backlog: BacklogSidecar | null;
  status: LocalNodeStatus;
  children: ChangeTreeNode[];
}

export interface TreeWarning {
  code: string;
  message: string;
  recovery: string;
}

export interface TreeCounts {
  total: number;
  open: number;
  inProgress: number;
  inReview: number;
  done: number;
  leaves: number;
  archived: number;
}

export interface ChangeTree {
  roots: ChangeTreeNode[];
  nodes: ChangeTreeNode[];
  byPath: Map<string, ChangeTreeNode>;
  warnings: TreeWarning[];
  counts: TreeCounts;
}

export interface TreeClosureBlocker {
  code: string;
  message: string;
  recovery: string;
  recoveryTool?: { tool: string; arguments: Record<string, unknown> };
}

function depthOf(relativePath: string): number {
  return relativePath.split('/').length;
}

function nearestAncestor(relativePath: string, present: Set<string>): string | undefined {
  const segments = relativePath.split('/');
  while (segments.length > 1) {
    segments.pop();
    const candidate = segments.join('/');
    if (present.has(candidate)) return candidate;
  }
  return undefined;
}

async function readNode(entry: ChangeDirectoryEntry): Promise<ChangeTreeNode | null> {
  try {
    const change = parseChange(await readFile(path.join(entry.directory, 'tasks.json'), 'utf8'));
    const backlog = await readBacklogSidecar(entry.directory);
    return {
      relativePath: entry.relativePath,
      id: change.id,
      name: change.name,
      directory: entry.directory,
      scope: entry.scope,
      closed: entry.scope === 'archive',
      change,
      backlog,
      status: 'open',
      children: [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Merge active and archived nodes by relative path; active wins when both exist. */
async function mergedEntries(root: string, warnings: TreeWarning[]): Promise<ChangeDirectoryEntry[]> {
  const entries = await scanChangeDirectories(root, { scope: 'merged' });
  const byPath = new Map<string, ChangeDirectoryEntry>();
  for (const entry of entries) {
    const existing = byPath.get(entry.relativePath);
    if (!existing) { byPath.set(entry.relativePath, entry); continue; }
    if (existing.scope === entry.scope) {
      warnings.push({
        code: 'duplicate_path',
        message: `Change path ${entry.relativePath} appears twice in ${entry.scope}.`,
        recovery: 'Keep a single tasks.json per relative path and retry.',
      });
      continue;
    }
    const winner = entry.scope === 'active' ? entry : existing;
    const loser = entry.scope === 'active' ? existing : entry;
    byPath.set(entry.relativePath, winner);
    warnings.push({
      code: 'stale_archive_copy',
      message: `${entry.relativePath} exists in both changes and archive; using the ${winner.scope} copy and ignoring the ${loser.scope} copy.`,
      recovery: `Inspect .notchlet/${loser.scope} for the stale copy of ${entry.relativePath}.`,
    });
  }
  return [...byPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function computeStatus(node: ChangeTreeNode): LocalNodeStatus {
  return deriveLocalNodeStatus({
    closed: node.closed,
    ownTasks: node.change.tasks,
    children: node.children.map(child => computeStatus(child)),
  });
}

export function treeCounts(nodes: ChangeTreeNode[]): TreeCounts {
  const counts: TreeCounts = { total: nodes.length, open: 0, inProgress: 0, inReview: 0, done: 0, leaves: 0, archived: 0 };
  for (const node of nodes) {
    if (node.status === 'open') counts.open += 1;
    else if (node.status === 'in_progress') counts.inProgress += 1;
    else if (node.status === 'in_review') counts.inReview += 1;
    else counts.done += 1;
    if (!node.children.length) counts.leaves += 1;
    if (node.closed) counts.archived += 1;
  }
  return counts;
}

export async function buildChangeTree(root: string): Promise<ChangeTree> {
  const warnings: TreeWarning[] = [];
  const entries = await mergedEntries(root, warnings);
  const byPath = new Map<string, ChangeTreeNode>();
  for (const entry of entries) {
    const node = await readNode(entry);
    if (node) byPath.set(node.relativePath, node);
  }
  const present = new Set(byPath.keys());
  for (const node of [...byPath.values()].sort((left, right) => depthOf(left.relativePath) - depthOf(right.relativePath) || left.relativePath.localeCompare(right.relativePath))) {
    const parentPath = nearestAncestor(node.relativePath, present);
    if (parentPath) byPath.get(parentPath)!.children.push(node);
  }
  for (const node of byPath.values()) node.children.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const nodes = [...byPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  for (const node of nodes) node.status = computeStatus(node);
  const roots = nodes.filter(node => nearestAncestor(node.relativePath, present) === undefined);

  const ids = new Map<string, string[]>();
  for (const node of nodes) ids.set(node.id, [...(ids.get(node.id) ?? []), node.relativePath]);
  for (const [id, paths] of ids) {
    if (paths.length < 2) continue;
    warnings.push({
      code: 'duplicate_change_id',
      message: `Change ID "${id}" is used by ${paths.length} nodes: ${paths.join(', ')}.`,
      recovery: 'Rename duplicate nodes or resolve changes by relative path until the IDs are unique.',
    });
  }

  return { roots, nodes, byPath, warnings, counts: treeCounts(nodes) };
}

export async function buildNode(root: string, reference?: string): Promise<ChangeTreeNode> {
  const tree = await buildChangeTree(root);
  if (reference === undefined) {
    const rootNode = tree.roots[0];
    if (!rootNode) throw new WorkflowError('change_not_found', 'No changes found.', 'Create a change with `notchlet change new` or list changes with `notchlet change list`.');
    return rootNode;
  }
  const normalized = reference.replace(/\\/g, '/').replace(/^\.notchlet\/(changes|archive)\//, '').replace(/^\/+|\/+$/g, '');
  const node = tree.byPath.get(normalized);
  if (node) return node;
  const matches = tree.nodes.filter(candidate => candidate.id === reference || candidate.name === reference || candidate.id.toLowerCase() === reference.toLowerCase() || candidate.name.toLowerCase() === reference.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new WorkflowError('ambiguous_change', `Change reference "${reference}" matches multiple nodes: ${matches.map(candidate => candidate.relativePath).join(', ')}.`, 'Use the relative path shown by `notchlet change tree` to disambiguate.');
  throw new WorkflowError('change_not_found', `Change not found: ${reference}`, 'List changes with `notchlet change tree` and use an existing relative path.');
}

export function flattenTree(tree: ChangeTree | ChangeTreeNode): ChangeTreeNode[] {
  const roots = 'roots' in tree ? tree.roots : [tree];
  const result: ChangeTreeNode[] = [];
  const walk = (node: ChangeTreeNode): void => { result.push(node); for (const child of node.children) walk(child); };
  for (const root of roots) walk(root);
  return result;
}

/** Depth-first next actionable node: the first open leaf, then a parent whose children are all closed. */
export function nextEligibleLeaf(tree: ChangeTree | ChangeTreeNode): ChangeTreeNode | undefined {
  const walk = (node: ChangeTreeNode): ChangeTreeNode | undefined => {
    if (node.closed) return undefined;
    for (const child of node.children) {
      const leaf = walk(child);
      if (leaf) return leaf;
    }
    return node;
  };
  for (const root of 'roots' in tree ? tree.roots : [tree]) {
    const leaf = walk(root);
    if (leaf) return leaf;
  }
  return undefined;
}

export function assertLeafAuthorable(node: ChangeTreeNode, operation = 'author work in'): void {
  if (!node.children.length) return;
  throw new WorkflowError(
    'rollup_node',
    `${node.relativePath} is a rollup node with ${node.children.length} child node${node.children.length === 1 ? '' : 's'}; ${operation} a leaf instead.`,
    `Use \`notchlet change tree ${node.relativePath}\` to pick a leaf, or scaffold one with \`notchlet change new <name> --parent ${node.relativePath} --as ${node.backlog?.node.itemType === 'EPIC' ? 'story' : node.backlog?.node.itemType === 'STORY' ? 'task' : 'subtask'}\`.`,
  );
}

async function closureManifestExists(directory: string): Promise<boolean> {
  try { await access(path.join(directory, 'closure.json')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
}

/** Blockers that prevent closing a rollup node until its direct children are closed in order. */
export async function childClosureBlockers(node: ChangeTreeNode): Promise<TreeClosureBlocker[]> {
  const blockers: TreeClosureBlocker[] = [];
  const parentType = node.backlog?.node.itemType;
  for (const child of node.children) {
    if (!child.closed) {
      blockers.push({
        code: 'child_open',
        message: `Child ${child.relativePath} is still open; close children before their parent.`,
        recovery: `notchlet close ${child.relativePath}`,
      });
    } else if (!(await closureManifestExists(child.directory))) {
      blockers.push({
        code: 'child_closure_missing',
        message: `Child ${child.relativePath} is archived without a closure manifest.`,
        recovery: `Restore and re-close the child: notchlet change restore ${child.relativePath}`,
      });
    }
    const childType = child.backlog?.node.itemType;
    if (parentType && childType && !canParent(parentType, childType)) {
      blockers.push({
        code: 'invalid_child_type',
        message: `${childType} ${child.relativePath} cannot be a direct child of ${parentType} ${node.relativePath}; backlog types must nest EPIC > STORY > TASK > SUBTASK.`,
        recovery: `Move ${child.relativePath} under a ${parentType === 'EPIC' ? 'STORY' : parentType === 'STORY' ? 'TASK' : 'SUBTASK'} node or change its backlog itemType.`,
      });
    }
    const parentItemId = node.backlog?.platform.itemId;
    const childItemId = child.backlog?.platform.itemId;
    if (parentItemId !== undefined && childItemId !== undefined && child.backlog?.platform.parentItemId !== parentItemId) {
      blockers.push({
        code: 'parent_item_mismatch',
        message: `Platform item ${childItemId} for ${child.relativePath} does not record parent ${parentItemId}.`,
        recovery: `Push the tree with \`notchlet sync push ${node.relativePath} --tree\` or correct the platform parent before closing.`,
      });
    }
  }
  return blockers;
}
