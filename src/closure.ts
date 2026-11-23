import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  artifactRole,
  capabilityContribution,
  classifyArtifactDrift,
  coverageReport,
  evaluateState,
  GENERATED_ARTIFACT_MARKER,
  inspectChangeArtifacts,
  inspectPlan,
  mutateChange,
  parseAcceptanceScenario,
  parseChange,
  parseRequirement,
  readArchivedChange,
  readiness,
  renderChangeArtifacts,
  WorkflowError,
  writeChangeArtifacts,
  type AcceptanceScenario,
  type ArtifactRole,
  type ArtifactStatus,
  type ArtifactStatusValue,
  type CapabilityContribution,
  type Change,
  type CoverageEvidenceInput,
  type CoverageReport,
  type Issue,
  type RemoteDeliveryStatus,
  type Requirement,
  type VerificationStatus,
} from './index.js';
import { archiveEvidenceArtifacts, evaluateVerificationFacets, readEvidence, summarizeSourceBinding, verificationRecovery, type EvidenceAttachment, type EvidenceCapture, type EvidenceOutcome, type SourceBindingSummary, type VerificationFacets } from './evidence.js';
import { canParent, readBacklogSidecar, type BacklogSidecar } from './backlog.js';
import { changeRefHash, mergeMoveDirectory, normalizeRelativePath, resolveChangeLocation, scanChangeDirectories, type ChangeDirectoryEntry } from './paths.js';

export interface CapabilityEntry<T> {
  value: T;
  provenance: { changeId: string; revision: number; acceptedAt: string; rationale: string };
}

export interface CapabilityBaseline {
  schemaVersion: 1;
  name: string;
  revision: number;
  requirements: CapabilityEntry<Requirement>[];
  scenarios: CapabilityEntry<AcceptanceScenario>[];
}

export interface ClosureBlocker {
  code: string;
  message: string;
  recovery: string;
  recoveryTool?: { tool: string; arguments: Record<string, unknown> };
}

export interface CapabilityPreview {
  contribution: CapabilityContribution;
  baselineName: string;
  baselineRevision?: number;
  delta: Change['capabilityDelta'];
  additions: Requirement[];
  updates: Requirement[];
  removals: string[];
  preservedRequirementIds: string[];
  preservedScenarioIds: string[];
  mergedRequirements: CapabilityEntry<Requirement>[];
  mergedScenarios: CapabilityEntry<AcceptanceScenario>[];
  readiness: { ready: boolean; blockers: Issue[] };
  artifacts: ArtifactStatus[];
  verification: { status: VerificationStatus; basis: 'git' | 'artifact' | 'mixed' | 'none'; missing: string[]; failed: string[]; stale: string[]; unknown: string[]; current: string[]; recovery?: string };
  sourceBinding: SourceBindingSummary;
  /** Present when a rollup node has blank intent and outcome, so closure would record no narrative. */
  narrative?: { status: 'blank'; message: string; recovery: string };
  localClosure: { ready: boolean; blockerCount: number };
  remoteDelivery: { status: RemoteDeliveryStatus };
  coverage: CoverageReport;
  blockers: ClosureBlocker[];
}

function facetsCurrentEvidence(facets: VerificationFacets): CoverageEvidenceInput[] {
  const currentIds = new Set(facets.checks.filter(check => check.status === 'current' && check.evidenceId).map(check => check.evidenceId!));
  return facets.records.filter(record => currentIds.has(record.id) && record.outcome === 'passed').map(record => ({
    evidenceId: record.id,
    ...(record.requirementIds.length ? { requirementIds: record.requirementIds } : {}),
    ...(record.scenarioIds?.length ? { scenarioIds: record.scenarioIds } : {}),
    ...(record.taskIds.length ? { taskIds: record.taskIds } : {}),
    ...(record.checkIds?.length ? { checkIds: record.checkIds } : {}),
  }));
}

export interface ClosureEvidenceItem {
  evidenceId: string;
  status: 'current' | 'superseded';
  outcome: EvidenceOutcome;
  summary: string;
  capturedAt: string;
  provenance: string;
  requirementIds: string[];
  scenarioIds: string[];
  taskIds: string[];
  checkIds: string[];
  capture?: EvidenceCapture;
  attachments: EvidenceAttachment[];
}

export interface ClosureManifestArtifact {
  artifact: string;
  path: string;
  role: ArtifactRole;
  status: ArtifactStatusValue;
  sha256?: string;
  bytes?: number;
}

export interface RollupDescendantCounts {
  nodes: number;
  leaves: number;
  requirements: number;
  checks: number;
  currentEvidence: number;
  tasks: { total: number; completed: number };
}

export interface ClosureChildRecord {
  changeId: string;
  relativePath: string;
  closedAt: string;
  closureSha256: string;
  contribution: CapabilityContribution;
  verification: {
    status: VerificationStatus;
    basis: 'git' | 'artifact' | 'mixed' | 'none';
    sourceBound?: boolean;
    evidenceId?: string;
  };
}

export type ClosureIntegrityIssueCode =
  | 'closure_manifest_missing'
  | 'closure_manifest_invalid'
  | 'child_closure_missing'
  | 'child_closure_invalid'
  | 'child_closure_hash_mismatch'
  | 'child_closure_unrecorded'
  | 'child_change_missing'
  | 'child_not_archived';

export interface ClosureIntegrityIssue {
  code: ClosureIntegrityIssueCode;
  message: string;
  recovery: string;
  parentRelativePath: string;
  childRelativePath?: string;
  recordedSha256?: string;
  actualSha256?: string;
}

export interface ClosureIntegrityReport {
  relativePath: string;
  changeId: string;
  archived: boolean;
  /** False for active changes: their closure manifest is historical, not a live rollup contract. */
  authoritative: boolean;
  manifestPath: string;
  manifestPresent: boolean;
  checkedChildren: number;
  issues: ClosureIntegrityIssue[];
  valid: boolean;
}

export interface ClosureManifest {
  schemaVersion: 1;
  changeId: string;
  changeName: string;
  mode: Change['mode'];
  closedAt: string;
  /** Authored narrative at close: what the change intended and what it delivered. */
  narrative?: { intent: string; outcome: string };
  revision: number;
  contentRevision?: number;
  contribution: CapabilityContribution;
  capability: {
    name: string;
    baselineWritten?: boolean;
    baselineRevision?: number;
    resultingRevision?: number;
    rationale?: string;
    deltaOperations: number;
  };
  verification: {
    status: VerificationStatus;
    basis: 'git' | 'artifact' | 'mixed' | 'none';
    evidenceId?: string;
    current: string[];
    failed: string[];
    stale: string[];
    unknown: string[];
    missing: string[];
    sourceBound?: boolean;
  };
  /** Source basis at close, including whether application source was bound and any acknowledgement. */
  sourceBinding?: SourceBindingSummary & { acceptedArtifactBasis: boolean };
  tasks: { total: number; completed: number; ids: string[] };
  checks: { total: number; ids: string[] };
  requirements: { total: number; ids: string[] };
  scenarios: number;
  coverage: CoverageReport;
  artifacts: ClosureManifestArtifact[];
  /** Whether closure refreshed lifecycle-only artifact content before archiving. */
  artifactRefresh?: 'generated-state' | 'none';
  plan?: {
    status: 'unlinked' | 'current' | 'drifted' | 'missing';
    path?: string;
    recordedSha256?: string;
    currentSha256?: string;
    contractSha256?: string;
    validation: 'ok' | 'invalid' | 'not_applicable';
    validationError?: string;
    acceptedDrift: boolean;
    checkedAt: string;
  };
  rollup?: { children: ClosureChildRecord[]; descendants?: RollupDescendantCounts };
  evidence: {
    records: number;
    current: number;
    superseded: number;
    attachments: number;
    items: ClosureEvidenceItem[];
    logs: Array<{ evidenceId: string; path: string; sha256?: string; bytes?: number }>;
  };
  remoteDelivery: { status: RemoteDeliveryStatus };
}

export type CloseInterruptionPoint = 'journal-prepared' | 'baseline-written' | 'change-archived';
export interface CloseOptions {
  /** Required for standard and delta changes; ignored for quick no-impact changes. */
  expectedBaselineRevision?: number;
  /** Write the optional human-readable closure.md view alongside canonical closure.json. */
  renderMarkdown?: boolean;
  /** Archive even when the source plan drifted, went missing, or no longer validates. */
  acceptPlanDrift?: boolean;
  /** Accept closure when non-Git evidence does not bind application source. */
  acceptArtifactBasis?: boolean;
  injectInterruption?: (point: CloseInterruptionPoint) => void | Promise<void>;
}

interface CloseJournal {
  schemaVersion: 1;
  operationId: string;
  changeId: string;
  /** Relative path under `.notchlet/changes`; absent on legacy flat journals. */
  relativePath?: string;
  baselineName: string;
  expectedBaselineRevision: number;
  expectedBaselineHash: string;
  nextBaseline: CapabilityBaseline;
  phase: 'prepared' | 'baseline-written' | 'change-archived' | 'complete';
}

const workspaceDir = (root: string) => path.join(path.resolve(root), '.notchlet');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateChangeId(id: string): string {
  try { return normalizeRelativePath(id); }
  catch { throw new WorkflowError('invalid_change_id', `Invalid change ID: ${id}`, 'Use a change ID returned by `notchlet change list`.'); }
}

function capabilityName(name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new WorkflowError('invalid_capability_name', 'Capability names must be lowercase kebab-case.', 'Choose a name such as `product-behavior`.');
  }
  return name;
}

function paths(root: string, relativePath: string, name: string) {
  const base = workspaceDir(root);
  const segments = normalizeRelativePath(relativePath).split('/');
  return {
    baseline: path.join(base, 'capabilities', `${capabilityName(name)}.yaml`),
    change: path.join(base, 'changes', ...segments),
    archive: path.join(base, 'archive', ...segments),
    journal: path.join(base, '.local', 'close', relativePath.includes('/') ? `${changeRefHash(relativePath)}.json` : `${relativePath}.json`),
    lock: path.join(base, '.local', 'close', `baseline-${capabilityName(name)}.lock`),
  };
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await writeFile(file, `${process.pid}\n`, { flag: 'wx' });
      return () => rm(file, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      try {
        const owner = Number((await readFile(file, 'utf8')).trim());
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
              await rm(file, { force: true });
              continue;
            }
          }
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if ((readError as NodeJS.ErrnoException).code !== 'EPERM') throw readError;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error('Timed out acquiring capability close lock.');
}

async function readBaseline(file: string, name: string): Promise<CapabilityBaseline> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.name !== name || !Number.isInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.requirements) || !Array.isArray(value.scenarios)) {
      throw new Error('Invalid capability baseline.');
    }

    const parseEntry = <T>(raw: unknown, parse: (value: unknown) => T): CapabilityEntry<T> => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid capability baseline entry.');
      const entry = raw as Record<string, unknown>;
      const provenance = entry.provenance as Record<string, unknown> | undefined;
      if (!provenance || typeof provenance !== 'object' || typeof provenance.changeId !== 'string' || !provenance.changeId ||
        !Number.isInteger(provenance.revision) || typeof provenance.acceptedAt !== 'string' || !Number.isFinite(Date.parse(provenance.acceptedAt)) ||
        typeof provenance.rationale !== 'string' || !provenance.rationale.trim()) {
        throw new Error('Invalid capability baseline provenance.');
      }
      return {
        value: parse(entry.value),
        provenance: {
          changeId: provenance.changeId,
          revision: provenance.revision as number,
          acceptedAt: provenance.acceptedAt,
          rationale: provenance.rationale,
        },
      };
    };

    const requirements = value.requirements.map(entry => parseEntry(entry, parseRequirement));
    const scenarios = value.scenarios.map(entry => parseEntry(entry, parseAcceptanceScenario));
    if (new Set(requirements.map(entry => entry.value.id)).size !== requirements.length || new Set(scenarios.map(entry => entry.value.id)).size !== scenarios.length) {
      throw new Error('Capability baseline contains duplicate IDs.');
    }
    const requirementIds = new Set(requirements.map(entry => entry.value.id));
    if (scenarios.some(entry => !requirementIds.has(entry.value.requirementId))) throw new Error('Capability baseline scenario references an unknown requirement.');
    return { schemaVersion: 1, name, revision: value.revision as number, requirements, scenarios };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, name, revision: 0, requirements: [], scenarios: [] };
    throw error;
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, file);
}

async function readChange(root: string, id: string): Promise<Change> {
  const location = await resolveChangeLocation(root, validateChangeId(id), { scope: 'active' });
  return parseChange(await readFile(path.join(location.directory, 'tasks.json'), 'utf8'));
}

function observationBasis(facets: VerificationFacets): 'git' | 'artifact' | 'mixed' | 'none' {
  const bases = facets.checks.filter(facet => facet.status === 'current' && facet.freshness).map(facet => facet.freshness!.basis);
  if (!bases.length) return 'none';
  if (bases.includes('artifact')) return bases.includes('git') ? 'mixed' : 'artifact';
  return 'git';
}

/** Read the local sync journal to distinguish an unconfigured remote from an unsynced one. */
async function remoteDeliveryStatus(root: string, changeId: string, relativePath: string, revision: number): Promise<RemoteDeliveryStatus> {
  const syncDirectory = path.join(path.resolve(root), '.notchlet', '.local', 'sync');
  for (const name of [`${changeRefHash(relativePath)}.json`, `${changeId}.json`]) {
    try {
      const state = JSON.parse(await readFile(path.join(syncDirectory, name), 'utf8')) as { remoteId?: unknown; baseRevision?: unknown; baseHash?: unknown };
      if (typeof state.remoteId !== 'string' && typeof state.remoteId !== 'number') return 'not_configured';
      return typeof state.baseRevision === 'number' && state.baseRevision >= revision && typeof state.baseHash === 'string' && /^[a-f0-9]{64}$/.test(state.baseHash)
        ? 'delivered'
        : 'not_delivered';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return 'unknown';
    }
  }
  return 'not_configured';
}

function hasSubstantiveContent(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('<!--')).length > 0;
}

async function manifestExists(directory: string): Promise<boolean> {  try { await access(path.join(directory, 'closure.json')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
}

async function fileExists(file: string): Promise<boolean> {
  try { await access(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
}

/** Archived change ancestors that have no active copy, outermost first. */
async function archivedAncestorChain(root: string, relativePath: string): Promise<string[]> {
  const segments = relativePath.split('/');
  const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
  const result: string[] = [];
  for (const ancestor of ancestors) {
    if (!(await fileExists(path.join(path.resolve(root), '.notchlet', 'archive', ...ancestor.split('/'), 'tasks.json')))) continue;
    if (await fileExists(path.join(path.resolve(root), '.notchlet', 'changes', ...ancestor.split('/'), 'tasks.json'))) continue;
    result.push(ancestor);
  }
  return result;
}

/** Direct structural children, descending through implicit container directories. */
async function directChildEntries(root: string, relativePath: string, withBacklog = true): Promise<Array<ChangeDirectoryEntry & { backlog: BacklogSidecar | null }>> {
  const entries = await scanChangeDirectories(root, { scope: 'merged' });
  const byPath = new Map<string, ChangeDirectoryEntry>();
  for (const entry of entries) {
    const existing = byPath.get(entry.relativePath);
    if (!existing || entry.scope === 'active') byPath.set(entry.relativePath, entry);
  }
  const relativeDepth = relativePath.split('/').length;
  const children: ChangeDirectoryEntry[] = [];
  for (const entry of byPath.values()) {
    if (!entry.relativePath.startsWith(`${relativePath}/`)) continue;
    const segments = entry.relativePath.split('/');
    let nestedUnderAnotherNode = false;
    while (segments.length - 1 > relativeDepth) {
      segments.pop();
      const ancestor = segments.join('/');
      if (ancestor === relativePath) break;
      if (byPath.has(ancestor)) { nestedUnderAnotherNode = true; break; }
    }
    if (!nestedUnderAnotherNode) children.push(entry);
  }
  return Promise.all(children.map(async entry => ({ ...entry, backlog: withBacklog ? await readBacklogSidecar(entry.directory) : null })));
}

async function assess(root: string, change: Change, artifactContents: Record<string, string> = {}, relativePath = change.id, options: { acceptArtifactBasis?: boolean } = {}): Promise<CapabilityPreview> {
  const name = capabilityName(change.capabilityName ?? change.id);
  const fileSet = paths(root, relativePath, name);
  const contribution = capabilityContribution(change);
  const baseline = contribution === 'none' ? null : await readBaseline(fileSet.baseline, name);
  const delta = contribution === 'none' ? undefined : change.capabilityDelta;
  const blockers: ClosureBlocker[] = [];
  const tool = (name: string, arguments_: Record<string, unknown>) => ({ tool: name, arguments: arguments_ });
  const add = (code: string, message: string, recovery: string, recoveryTool?: { tool: string; arguments: Record<string, unknown> }) =>
    blockers.push({ code, message, recovery, ...(recoveryTool ? { recoveryTool } : {}) });

  const childEntries = await directChildEntries(root, relativePath);
  const rollup = childEntries.length > 0;
  const parentBacklog = await readBacklogSidecar(fileSet.change);
  for (const child of childEntries) {
    if (child.scope !== 'archive') {
      add('child_open', `Child ${child.relativePath} is still open; close children before their parent.`, `notchlet close ${child.relativePath}`);
    } else if (!(await manifestExists(child.directory))) {
      add('child_closure_missing', `Child ${child.relativePath} is archived without a closure manifest.`, `notchlet change restore ${child.relativePath}`);
    }
    const parentType = parentBacklog?.node.itemType;
    const childType = child.backlog?.node.itemType;
    if (parentType && childType && !canParent(parentType, childType)) {
      add('invalid_child_type', `${childType} ${child.relativePath} cannot be a direct child of ${parentType} ${relativePath}; backlog types must nest EPIC > STORY > TASK > SUBTASK.`, `Move ${child.relativePath} under a valid parent node.`);
    }
    const parentItemId = parentBacklog?.platform.itemId;
    const childItemId = child.backlog?.platform.itemId;
    if (parentItemId !== undefined && childItemId !== undefined && child.backlog?.platform.parentItemId !== parentItemId) {
      add('parent_item_mismatch', `Platform item ${childItemId} for ${child.relativePath} does not record parent ${parentItemId}.`, `Push the tree with \`notchlet sync push ${relativePath} --tree\` or correct the platform parent before closing.`);
    }
  }

  if (contribution !== 'none' && change.baselineRevision === undefined) {
    add('baseline_revision_missing', 'Capture the capability baseline revision in the change before closure.', `notchlet change baseline ${change.id}`, tool('notchlet_change_baseline', { changeId: change.id }));
  } else if (contribution !== 'none' && baseline && change.baselineRevision !== baseline.revision) {
    add('baseline_revision_conflict', `Change records baseline revision ${change.baselineRevision}, but the current baseline is ${baseline.revision}.`, `notchlet change baseline ${change.id}`, tool('notchlet_change_baseline', { changeId: change.id }));
  }
  if (change.mode === 'quick' && contribution !== 'none' && !(change.capabilityImpact === 'delta' && delta?.operations.length)) {
    add('capability_impact_required', 'Quick changes must declare capabilityImpact none with a rationale or provide an explicit capability delta.', `notchlet change update ${change.id} --capability-impact none --capability-rationale "<reason>"`, tool('notchlet_change_update', { changeId: change.id, capabilityImpact: 'none', capabilityRationale: '<reason>' }));
  }
  if (change.capabilityImpact === 'none' && !change.capabilityRationale?.trim()) {
    add('capability_rationale_required', 'A no-impact declaration requires a rationale.', `notchlet change update ${change.id} --capability-rationale "<reason>"`, tool('notchlet_change_update', { changeId: change.id, capabilityRationale: '<reason>' }));
  }
  if (change.capabilityImpact === 'delta' && !delta?.operations.length) {
    add('capability_delta_required', 'Declare at least one explicit capability delta operation.', `notchlet change delta ${change.id} add --requirement <requirement-id> --rationale "<reason>"`, tool('notchlet_change_delta', { changeId: change.id, operation: 'add', requirementId: '<requirement-id>', rationale: '<reason>' }));
  }

  const baselineRequirements = new Map((baseline?.requirements ?? []).map(entry => [entry.value.id, entry.value]));
  const additions: Requirement[] = [];
  const updates: Requirement[] = [];
  const removals: string[] = [];
  const touched = new Set<string>();
  for (const operation of delta?.operations ?? []) {
    if (touched.has(operation.requirementId)) {
      add('duplicate_capability_operation', `Capability delta repeats requirement ${operation.requirementId}.`, `notchlet change delta ${change.id} delete --requirement ${operation.requirementId}`, tool('notchlet_change_delta', { changeId: change.id, operation: 'delete', requirementId: operation.requirementId }));
      continue;
    }
    touched.add(operation.requirementId);
    const existing = baselineRequirements.get(operation.requirementId);
    if (operation.operation === 'add') {
      if (existing || !operation.requirement || operation.requirement.id !== operation.requirementId) {
        add('invalid_capability_add', `Add operation for ${operation.requirementId} must introduce a new matching requirement.`, `notchlet change delta ${change.id} delete --requirement ${operation.requirementId}`, tool('notchlet_change_delta', { changeId: change.id, operation: 'delete', requirementId: operation.requirementId }));
      } else additions.push(operation.requirement);
    } else if (operation.operation === 'update') {
      if (!existing || !operation.requirement || operation.requirement.id !== operation.requirementId) {
        add('invalid_capability_update', `Update operation for ${operation.requirementId} requires an existing requirement and matching replacement.`, `notchlet change delta ${change.id} delete --requirement ${operation.requirementId}`, tool('notchlet_change_delta', { changeId: change.id, operation: 'delete', requirementId: operation.requirementId }));
      } else updates.push(operation.requirement);
    } else if (!existing) {
      add('invalid_capability_remove', `Cannot remove unknown requirement ${operation.requirementId}.`, `notchlet change delta ${change.id} delete --requirement ${operation.requirementId}`, tool('notchlet_change_delta', { changeId: change.id, operation: 'delete', requirementId: operation.requirementId }));
    } else removals.push(operation.requirementId);

    if (operation.operation !== 'remove') {
      for (const scenario of operation.scenarios ?? []) {
        if (scenario.requirementId !== operation.requirementId) {
          add('scenario_requirement_mismatch', `Scenario ${scenario.id} does not belong to ${operation.requirementId}.`, `notchlet change delta ${change.id} update --requirement ${operation.requirementId} --rationale "<reason>"`, tool('notchlet_change_delta', { changeId: change.id, operation: 'update', requirementId: operation.requirementId, rationale: '<reason>' }));
        }
      }
    }
  }

  if (contribution !== 'none') {
    const changeRequirementIds = new Set(change.requirements.map(requirement => requirement.id));
    for (const requirement of change.requirements) {
      const baselineRequirement = baselineRequirements.get(requirement.id);
      const operation = delta?.operations.find(item => item.requirementId === requirement.id);
      if (!baselineRequirement && !touched.has(requirement.id)) {
        add('undeclared_capability_delta', `Requirement ${requirement.id} is not in the baseline or explicit delta.`, `notchlet change delta ${change.id} add --requirement ${requirement.id} --rationale "<reason>"`, tool('notchlet_change_delta', { changeId: change.id, operation: 'add', requirementId: requirement.id, rationale: '<reason>' }));
      } else if (baselineRequirement && JSON.stringify(baselineRequirement) !== JSON.stringify(requirement) && !operation) {
        add('undeclared_capability_delta', `Requirement ${requirement.id} changed without an explicit capability delta.`, `notchlet change delta ${change.id} update --requirement ${requirement.id} --rationale "<reason>"`, tool('notchlet_change_delta', { changeId: change.id, operation: 'update', requirementId: requirement.id, rationale: '<reason>' }));
      } else if (operation && operation.operation !== 'remove' && JSON.stringify(operation.requirement) !== JSON.stringify(requirement)) {
        add('capability_delta_mismatch', `Requirement ${requirement.id} does not match its declared delta.`, `notchlet change delta ${change.id} delete --requirement ${requirement.id}`, tool('notchlet_change_delta', { changeId: change.id, operation: 'delete', requirementId: requirement.id }));
      }
    }
    for (const operation of delta?.operations ?? []) {
      if (operation.operation === 'remove' && changeRequirementIds.has(operation.requirementId)) {
        add('capability_delta_mismatch', `Removed requirement ${operation.requirementId} is still present in the change requirements.`, `notchlet change remove ${change.id} requirement ${operation.requirementId}`, tool('notchlet_change_remove', { changeId: change.id, kind: 'requirement', itemId: operation.requirementId }));
      }
    }

    const baselineScenarios = new Map((baseline?.scenarios ?? []).map(entry => [entry.value.id, entry.value]));
    const changeScenarioIds = new Set(change.acceptanceScenarios.map(scenario => scenario.id));
    for (const scenario of change.acceptanceScenarios) {
      const baselineScenario = baselineScenarios.get(scenario.id);
      const operation = delta?.operations.find(item => item.requirementId === scenario.requirementId);
      if (!baselineScenario && !touched.has(scenario.requirementId)) {
        add('undeclared_scenario_delta', `Scenario ${scenario.id} is not in the baseline or explicit delta.`, `notchlet change delta ${change.id} add --requirement ${scenario.requirementId} --rationale "<reason>"`, tool('notchlet_change_delta', { changeId: change.id, operation: 'add', requirementId: scenario.requirementId, rationale: '<reason>' }));
      } else if (baselineScenario && JSON.stringify(baselineScenario) !== JSON.stringify(scenario) && !operation) {
        add('undeclared_scenario_delta', `Scenario ${scenario.id} changed without an explicit capability delta.`, `notchlet change delta ${change.id} update --requirement ${scenario.requirementId} --rationale "<reason>"`, tool('notchlet_change_delta', { changeId: change.id, operation: 'update', requirementId: scenario.requirementId, rationale: '<reason>' }));
      } else if (operation?.scenarios && !operation.scenarios.some(item => item.id === scenario.id && JSON.stringify(item) === JSON.stringify(scenario))) {
        add('capability_delta_mismatch', `Scenario ${scenario.id} does not match its declared delta.`, `notchlet change delta ${change.id} delete --requirement ${scenario.requirementId}`, tool('notchlet_change_delta', { changeId: change.id, operation: 'delete', requirementId: scenario.requirementId }));
      }
    }
    for (const operation of delta?.operations ?? []) {
      for (const scenario of operation.scenarios ?? []) {
        if (!changeScenarioIds.has(scenario.id)) {
          add('capability_delta_mismatch', `Delta scenario ${scenario.id} is missing from change acceptance scenarios.`, `notchlet change delta ${change.id} delete --requirement ${operation.requirementId}`, tool('notchlet_change_delta', { changeId: change.id, operation: 'delete', requirementId: operation.requirementId }));
        }
      }
    }
  }

  const preservedRequirementIds = (baseline?.requirements ?? []).map(entry => entry.value.id).filter(id => !touched.has(id));
  const acceptedAt = 'pending-close';
  const mergedRequirements = new Map((baseline?.requirements ?? []).map(entry => [entry.value.id, entry]));
  const mergedScenarios = new Map((baseline?.scenarios ?? []).map(entry => [entry.value.id, entry]));
  for (const operation of delta?.operations ?? []) {
    if (operation.operation === 'remove') {
      mergedRequirements.delete(operation.requirementId);
      for (const [id, entry] of mergedScenarios) if (entry.value.requirementId === operation.requirementId) mergedScenarios.delete(id);
      continue;
    }
    if (operation.requirement) {
      mergedRequirements.set(operation.requirementId, {
        value: operation.requirement,
        provenance: { changeId: change.id, revision: change.revision ?? 0, acceptedAt, rationale: operation.rationale },
      });
    }
    if (operation.scenarios) {
      for (const [id, entry] of mergedScenarios) if (entry.value.requirementId === operation.requirementId) mergedScenarios.delete(id);
      for (const scenario of operation.scenarios) {
        mergedScenarios.set(scenario.id, {
          value: scenario,
          provenance: { changeId: change.id, revision: change.revision ?? 0, acceptedAt, rationale: operation.rationale },
        });
      }
    }
  }

  const affectedScenarioRequirements = new Set((delta?.operations ?? [])
    .filter(operation => operation.operation === 'remove' || operation.scenarios !== undefined)
    .map(operation => operation.requirementId));
  const preservedScenarioIds = (baseline?.scenarios ?? [])
    .filter(entry => !affectedScenarioRequirements.has(entry.value.requirementId))
    .map(entry => entry.value.id);

  if (!Object.keys(artifactContents).length) {
    for (const relative of Object.values(change.artifacts)) {
      try { artifactContents[relative] = await readFile(path.join(fileSet.change, relative), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const artifacts: ArtifactStatus[] = renderChangeArtifacts(change).map(rendered => {
    const existing = artifactContents[rendered.path];
    const status: ArtifactStatusValue = existing === undefined ? 'missing' : existing === rendered.content ? 'current' : rendered.role === 'canonical' || existing.includes(GENERATED_ARTIFACT_MARKER) ? 'drifted' : 'unmarked';
    const drift = status === 'drifted' && existing !== undefined ? classifyArtifactDrift(rendered, existing) : 'none';
    return { artifact: rendered.artifact, path: rendered.path, role: rendered.role, status, drift };
  });
  for (const artifact of artifacts) {
    if (artifact.status === 'current') continue;
    // Lifecycle-only drift is refreshed automatically during close; it is not an authored blocker.
    if (artifact.status === 'drifted' && artifact.drift === 'generated-state') continue;
    const force = artifact.status === 'unmarked';
    add(
      `artifact_${artifact.status}`,
      `Declared artifact ${artifact.artifact} is ${artifact.status}${artifact.drift ? ` (${artifact.drift} drift)` : ''}; closure requires model-derived artifacts to be current.`,
      `notchlet change render ${change.id} --write${force ? ' --force' : ''}`,
      tool('notchlet_change_render', { changeId: change.id, write: true, ...(force ? { force: true } : {}) }),
    );
  }
  const facets = await evaluateVerificationFacets(root, change.id, change);
  const coverageEvidence = facetsCurrentEvidence(facets);
  const readinessResult = readiness(change, artifactContents, coverageEvidence, { rollup });
  for (const issue of readinessResult.blockers) {
    add(`readiness_${issue.code}`, issue.message, issue.recovery, tool('notchlet_change_get', { changeId: change.id }));
  }
  const incompleteTask = change.tasks.find(task => task.status !== 'completed');
  if (!rollup && !change.tasks.length) {
    add('tasks_incomplete', 'All change tasks must be completed before local closure.', `notchlet change add ${change.id} task --id <task-id> --title "<title>" --requirement <requirement-id>`, tool('notchlet_change_add', { changeId: change.id, kind: 'task', id: '<task-id>', title: '<title>', requirementIds: ['<requirement-id>'] }));
  } else if (!rollup && incompleteTask) {
    add('tasks_incomplete', `Task ${incompleteTask.id} must be completed before local closure.`, `notchlet task complete ${incompleteTask.id} --change ${change.id}`, tool('notchlet_task_transition', { changeId: change.id, taskId: incompleteTask.id, status: 'completed' }));
  }
  if (!rollup && !change.checks.length) {
    add('acceptance_missing', 'At least one required acceptance check must be declared and current.', `notchlet change add ${change.id} check --id <check-id> --description "<description>" --command "<command>"`, tool('notchlet_change_add', { changeId: change.id, kind: 'check', id: '<check-id>', description: '<description>', command: '<command>' }));
  }

  for (const check of change.checks) {
    if (facets.current.includes(check.id)) continue;
    const facet = facets.checks.find(item => item.checkId === check.id);
    add('acceptance_not_current', `Required check ${check.id} is ${facet?.status ?? 'missing'}; only current passed evidence closes a change.`, `notchlet verify ${change.id} --check ${check.id} --record`, tool('notchlet_verify', { changeId: change.id, checkIds: [check.id], record: true }));
  }

  const coverage = coverageReport(change, coverageEvidence);
  if (change.coveragePolicy === 'strict') {
    if (coverage.requirements.uncovered.length) add('coverage_requirement_uncovered', `Strict coverage: requirements ${coverage.requirements.uncovered.join(', ')} are not linked to a check, task, or passing evidence record.`, `notchlet change update ${change.id} check <check-id> --requirement <requirement-id>`, tool('notchlet_change_update', { changeId: change.id, kind: 'check', requirementIds: coverage.requirements.uncovered }));
    if (coverage.scenarios.uncovered.length) add('coverage_scenario_uncovered', `Strict coverage: scenarios ${coverage.scenarios.uncovered.join(', ')} are not linked to a check, task, or passing evidence record.`, `notchlet change update ${change.id} check <check-id> --scenario <scenario-id>`, tool('notchlet_change_update', { changeId: change.id, kind: 'check', scenarioIds: coverage.scenarios.uncovered }));
    if (coverage.tasks.uncovered.length) add('coverage_task_uncovered', `Strict coverage: tasks ${coverage.tasks.uncovered.join(', ')} are not linked to any check or passing evidence record.`, `notchlet change update ${change.id} check <check-id> --task <task-id>`, tool('notchlet_change_update', { changeId: change.id, kind: 'check', taskIds: coverage.tasks.uncovered }));
  }

  const verification = evaluateState(change, {
    missing: facets.missing, failed: facets.failed, stale: facets.stale, unknown: facets.unknown, current: facets.current, coverageEvidence,
  }, artifactContents).verification;
  const sourceBinding = summarizeSourceBinding(facets);
  if (verification.status === 'current' && !sourceBinding.bound && !options.acceptArtifactBasis) {
    add('artifact_basis_unacknowledged', 'Current evidence does not bind application source; closure would claim an artifact-only verification.', `Re-record checks after source binding is available, or pass \`notchlet change close ${change.id} --accept-artifact-basis\` to record the artifact-only decision.`);
  }
  const recoverable = [...facets.missing, ...facets.failed, ...facets.stale, ...facets.unknown];
  const narrativeBlank = rollup && !hasSubstantiveContent(change.intent) && !hasSubstantiveContent(change.outcome);

  return {
    contribution,
    baselineName: name,
    ...(baseline ? { baselineRevision: baseline.revision } : {}),
    delta,
    additions,
    updates,
    removals,
    preservedRequirementIds,
    preservedScenarioIds,
    mergedRequirements: [...mergedRequirements.values()],
    mergedScenarios: [...mergedScenarios.values()],
    readiness: { ready: readinessResult.ready, blockers: readinessResult.blockers },
    artifacts,
    verification: { status: verification.status, basis: observationBasis(facets), missing: facets.missing, failed: facets.failed, stale: facets.stale, unknown: facets.unknown, current: facets.current, ...(recoverable.length ? { recovery: verificationRecovery(change.id, recoverable) } : {}) },
    sourceBinding,
    ...(narrativeBlank ? { narrative: { status: 'blank' as const, message: 'This rollup has blank intent and outcome, so its closure record would carry no narrative.', recovery: `Describe what this node coordinates: notchlet change update ${change.id} --intent "<intent>" --outcome "<outcome>".` } } : {}),
    localClosure: { ready: blockers.length === 0, blockerCount: blockers.length },
    remoteDelivery: { status: await remoteDeliveryStatus(root, change.id, relativePath, change.revision ?? 0) },
    coverage,
    blockers,
  };
}

export async function previewCapabilityClose(root: string, changeId: string, artifactContents: Record<string, string> = {}): Promise<CapabilityPreview> {
  const location = await resolveChangeLocation(root, validateChangeId(changeId), { scope: 'active' });
  return assess(root, await readChange(root, location.relativePath), artifactContents, location.relativePath);
}

async function readJournal(file: string): Promise<CloseJournal | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as CloseJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function findJournal(root: string, changeId: string, relativePath?: string): Promise<{ journal: CloseJournal; file: string } | null> {
  const directory = path.join(workspaceDir(root), '.local', 'close');
  const leaf = changeId.split('/').pop()!;
  const candidates: string[] = [];
  if (relativePath?.includes('/')) candidates.push(path.join(directory, `${changeRefHash(relativePath)}.json`));
  else candidates.push(path.join(directory, `${leaf}.json`));
  for (const file of candidates) {
    const journal = await readJournal(file);
    if (journal) return { journal, file };
  }
  if (!relativePath?.includes('/')) {
    let entries;
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    for (const name of entries.filter(entry => entry.endsWith('.json')).sort()) {
      const journal = await readJournal(path.join(directory, name));
      if (journal && journalMatches(journal, changeId)) return { journal, file: path.join(directory, name) };
    }
  }
  return null;
}

function journalMatches(journal: CloseJournal, changeId: string): boolean {
  return journal.changeId === changeId || journal.relativePath === changeId || journal.changeId === changeId.split('/').pop();
}

async function archiveChangeDirectory(from: string, to: string): Promise<void> {
  try { await mergeMoveDirectory(from, to); }
  catch (error) {
    if (error instanceof WorkflowError && error.code === 'archive_conflict') {
      try { if ((await stat(path.join(to, 'tasks.json'))).isFile()) return; }
      catch { /* report the original conflict */ }
    }
    throw error;
  }
}

async function recoverUnlocked(root: string, changeId: string, relativePath?: string): Promise<{ recovered: boolean; archived: boolean; baselineRevision?: number }> {
  const found = await findJournal(root, changeId, relativePath);
  if (!found) return { recovered: false, archived: false };
  const journal = found.journal;
  if (journal.schemaVersion !== 1 || !journalMatches(journal, changeId) || typeof journal.baselineName !== 'string' ||
    !['prepared', 'baseline-written', 'change-archived', 'complete'].includes(journal.phase) ||
    !Number.isInteger(journal.expectedBaselineRevision) || typeof journal.expectedBaselineHash !== 'string' ||
    !journal.nextBaseline || journal.nextBaseline.schemaVersion !== 1 || journal.nextBaseline.name !== journal.baselineName ||
    journal.nextBaseline.revision !== journal.expectedBaselineRevision + 1 || !Array.isArray(journal.nextBaseline.requirements) || !Array.isArray(journal.nextBaseline.scenarios)) {
    throw new WorkflowError('invalid_close_journal', 'Close journal is invalid.', 'Inspect the journal before retrying closure.');
  }
  const resolvedRelativePath = journal.relativePath ?? (await resolveChangeLocation(root, changeId, { scope: 'merged' })).relativePath;
  const fileSet = paths(root, resolvedRelativePath, journal.baselineName);
  if (journal.phase === 'prepared') {
    const current = await readBaseline(fileSet.baseline, journal.baselineName);
    if (current.revision === journal.expectedBaselineRevision && hash(current) === journal.expectedBaselineHash) {
      await atomicJson(fileSet.baseline, journal.nextBaseline);
    } else if (current.revision !== journal.nextBaseline.revision || hash(current) !== hash(journal.nextBaseline)) {
      throw new WorkflowError('baseline_revision_conflict', 'Capability baseline changed while close recovery was pending.', 'Reconcile the baseline and change before retrying close.');
    }
    journal.phase = 'baseline-written';
    await atomicJson(found.file, journal);
  }
  if (journal.phase === 'baseline-written') {
    await mkdir(path.dirname(fileSet.archive), { recursive: true });
    await archiveChangeDirectory(fileSet.change, fileSet.archive);
    journal.phase = 'change-archived';
    await atomicJson(found.file, journal);
  }
  if (journal.phase === 'change-archived') {
    journal.phase = 'complete';
    await atomicJson(found.file, journal);
  }
  return { recovered: true, archived: true, baselineRevision: journal.nextBaseline.revision };
}

export async function recoverCapabilityClose(root: string, changeId: string): Promise<{ recovered: boolean; archived: boolean; baselineRevision?: number }> {
  const normalized = validateChangeId(changeId);
  const found = await findJournal(root, normalized);
  if (!found) return { recovered: false, archived: false };
  const resolvedRelativePath = found.journal.relativePath ?? (await resolveChangeLocation(root, normalized, { scope: 'merged' })).relativePath;
  const fileSet = paths(root, resolvedRelativePath, found.journal.baselineName);
  const release = await acquireLock(fileSet.lock);
  try { return await recoverUnlocked(root, normalized, resolvedRelativePath); }
  finally { await release(); }
}

function archivedPreview(baselineName: string, baselineRevision?: number): CapabilityPreview {
  return {
    contribution: 'standard',
    baselineName,
    ...(baselineRevision === undefined ? {} : { baselineRevision }),
    delta: undefined,
    additions: [],
    updates: [],
    removals: [],
    preservedRequirementIds: [],
    preservedScenarioIds: [],
    mergedRequirements: [],
    mergedScenarios: [],
    readiness: { ready: true, blockers: [] },
    artifacts: [],
    verification: { status: 'current', basis: 'none', missing: [], failed: [], stale: [], unknown: [], current: [] },
    sourceBinding: { basis: 'none', bound: false, currentChecks: 0, gitChecks: 0, workspaceChecks: 0, unboundChecks: 0 },
    localClosure: { ready: true, blockerCount: 0 },
    remoteDelivery: { status: 'unknown' },
    coverage: { policy: 'advisory', complete: true, requirements: { total: 0, covered: 0, uncovered: [], items: [] }, scenarios: { total: 0, covered: 0, uncovered: [], items: [] }, tasks: { total: 0, covered: 0, uncovered: [], items: [] }, unlinkedChecks: [] },
    blockers: [],
  };
}

async function readChildClosureRecords(root: string, relativePath: string): Promise<{ records: ClosureChildRecord[]; descendants: RollupDescendantCounts }> {
  const children = await directChildEntries(root, relativePath, false);
  const records: ClosureChildRecord[] = [];
  const descendants: RollupDescendantCounts = { nodes: 0, leaves: 0, requirements: 0, checks: 0, currentEvidence: 0, tasks: { total: 0, completed: 0 } };
  for (const child of children) {
    if (child.scope !== 'archive') continue;
    const file = path.join(child.directory, 'closure.json');
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let closure: Record<string, any>;
    try { closure = JSON.parse(text) as Record<string, any>; }
    catch {
      throw new WorkflowError('child_closure_invalid', `Child ${child.relativePath} has an unreadable closure manifest.`, `Restore and re-close the child: notchlet change restore ${child.relativePath}`);
    }
    if (typeof closure.closedAt !== 'string') {
      throw new WorkflowError('child_closure_invalid', `Child ${child.relativePath} closure manifest records no closedAt.`, `Restore and re-close the child: notchlet change restore ${child.relativePath}`);
    }
    const verification = closure.verification as Record<string, unknown> | undefined;
    const status = ['not_applicable', 'missing', 'failed', 'stale', 'unknown', 'current'].includes(String(verification?.status)) ? verification!.status as VerificationStatus : 'unknown';
    const basis = ['git', 'artifact', 'mixed', 'none'].includes(String(verification?.basis)) ? verification!.basis as 'git' | 'artifact' | 'mixed' | 'none' : 'none';
    const sourceBound = typeof verification?.sourceBound === 'boolean' ? verification.sourceBound : undefined;
    const contribution = ['none', 'delta', 'standard'].includes(String(closure.contribution)) ? closure.contribution as CapabilityContribution : 'none';
    const childRollup = closure.rollup as Record<string, any> | undefined;
    const inherited = childRollup?.descendants as RollupDescendantCounts | undefined;
    const ownRequirements = Array.isArray(closure.requirements?.ids) ? closure.requirements.ids.length : Number(closure.requirements?.total) || 0;
    const ownChecks = Array.isArray(closure.checks?.ids) ? closure.checks.ids.length : Number(closure.checks?.total) || 0;
    const ownEvidence = Number(closure.evidence?.current) || 0;
    const ownTasksTotal = Number(closure.tasks?.total) || 0;
    const ownTasksCompleted = Number(closure.tasks?.completed) || 0;
    descendants.nodes += 1 + (inherited?.nodes ?? 0);
    descendants.leaves += childRollup?.children?.length ? (inherited?.leaves ?? 0) : 1;
    descendants.requirements += ownRequirements + (inherited?.requirements ?? 0);
    descendants.checks += ownChecks + (inherited?.checks ?? 0);
    descendants.currentEvidence += ownEvidence + (inherited?.currentEvidence ?? 0);
    descendants.tasks.total += ownTasksTotal + (inherited?.tasks.total ?? 0);
    descendants.tasks.completed += ownTasksCompleted + (inherited?.tasks.completed ?? 0);
    records.push({
      changeId: typeof closure.changeId === 'string' ? closure.changeId : child.relativePath.split('/').at(-1)!,
      relativePath: child.relativePath,
      closedAt: closure.closedAt,
      closureSha256: createHash('sha256').update(text).digest('hex'),
      contribution,
      verification: {
        status,
        basis,
        ...(sourceBound === undefined ? {} : { sourceBound }),
        ...(typeof verification?.evidenceId === 'string' ? { evidenceId: verification.evidenceId } : {}),
      },
    });
  }
  return { records: records.sort((left, right) => left.relativePath.localeCompare(right.relativePath)), descendants };
}

function closureRepairRecovery(top: string, closable: string[], child?: string): string {
  const commands = [`notchlet change restore ${top}`];
  if (child) commands.push(`notchlet change close ${child}`);
  for (const node of closable) commands.push(`notchlet change close ${node}`);
  return `Restore the top archived ancestor, then re-close bottom-up: ${commands.join('; ')}. Restoring a subtree reopens its other children; re-close them as needed before closing ancestors.`;
}

/**
 * Compare an archived node's rollup records with the current archived child closures.
 * Active manifests are historical and explicitly non-authoritative; they are never hash-gated.
 */
export async function inspectClosureIntegrity(root: string, reference: string): Promise<ClosureIntegrityReport> {
  const location = await resolveChangeLocation(root, reference, { scope: 'merged' });
  const manifestPath = path.join(location.directory, 'closure.json');
  const report: ClosureIntegrityReport = {
    relativePath: location.relativePath,
    changeId: location.id,
    archived: location.scope === 'archive',
    authoritative: location.scope === 'archive',
    manifestPath,
    manifestPresent: false,
    checkedChildren: 0,
    issues: [],
    valid: true,
  };
  const add = (issue: ClosureIntegrityIssue): void => { report.issues.push(issue); report.valid = false; };
  const closable = report.archived ? [location.relativePath, ...await archivedAncestorChain(root, location.relativePath)] : [];
  const repair = (child?: string): string => closureRepairRecovery(closable.at(-1) ?? location.relativePath, closable, child);
  const manifestMissing = (): void => add({
    code: 'closure_manifest_missing',
    message: `Archived change ${location.relativePath} has no closure manifest.`,
    recovery: repair(),
    parentRelativePath: location.relativePath,
  });

  let text: string;
  try { text = await readFile(manifestPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      if (report.archived) manifestMissing();
      return report;
    }
    throw error;
  }
  report.manifestPresent = true;
  if (!report.archived) return report;

  let manifest: Record<string, any>;
  try { manifest = JSON.parse(text) as Record<string, any>; }
  catch {
    add({
      code: 'closure_manifest_invalid',
      message: `Closure manifest for ${location.relativePath} is not valid JSON.`,
      recovery: repair(),
      parentRelativePath: location.relativePath,
    });
    return report;
  }
  const rollup = manifest.rollup as Record<string, unknown> | undefined;
  if (manifest.schemaVersion !== 1 || typeof manifest.changeId !== 'string' || typeof manifest.closedAt !== 'string' || (rollup !== undefined && (!rollup || !Array.isArray(rollup.children)))) {
    add({
      code: 'closure_manifest_invalid',
      message: `Closure manifest for ${location.relativePath} is missing required fields or has an invalid rollup shape.`,
      recovery: repair(),
      parentRelativePath: location.relativePath,
    });
    return report;
  }

  const children = await directChildEntries(root, location.relativePath, false);
  const byPath = new Map(children.map(child => [child.relativePath, child]));
  const rawRecords = rollup === undefined ? [] : rollup.children as unknown[];
  const recorded = new Set<string>();
  for (const raw of rawRecords) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      add({
        code: 'closure_manifest_invalid',
        message: `Closure manifest for ${location.relativePath} contains a non-object child record.`,
        recovery: repair(),
        parentRelativePath: location.relativePath,
      });
      continue;
    }
    const record = raw as Record<string, any>;
    const childPath = record.relativePath;
    if (typeof childPath !== 'string' || !childPath.startsWith(`${location.relativePath}/`)) {
      add({
        code: 'closure_manifest_invalid',
        message: `Closure manifest for ${location.relativePath} contains a child record without a valid relativePath.`,
        recovery: repair(),
        parentRelativePath: location.relativePath,
      });
      continue;
    }
    if (recorded.has(childPath)) {
      add({
        code: 'closure_manifest_invalid',
        message: `Closure manifest for ${location.relativePath} records child ${childPath} more than once.`,
        recovery: repair(childPath),
        parentRelativePath: location.relativePath,
        childRelativePath: childPath,
      });
      continue;
    }
    recorded.add(childPath);
    const child = byPath.get(childPath);
    if (!child) {
      add({
        code: 'child_change_missing',
        message: `Recorded child ${childPath} no longer exists in the active or archive tree.`,
        recovery: repair(),
        parentRelativePath: location.relativePath,
        childRelativePath: childPath,
      });
      continue;
    }
    if (child.scope !== 'archive') {
      add({
        code: 'child_not_archived',
        message: `Recorded child ${childPath} is active, so the archived parent closure cannot be verified.`,
        recovery: repair(childPath),
        parentRelativePath: location.relativePath,
        childRelativePath: childPath,
      });
      continue;
    }
    report.checkedChildren += 1;
    const recordedSha256 = record.closureSha256;
    if (typeof recordedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(recordedSha256)) {
      add({
        code: 'closure_manifest_invalid',
        message: `Child record for ${childPath} has no valid closureSha256.`,
        recovery: repair(childPath),
        parentRelativePath: location.relativePath,
        childRelativePath: childPath,
      });
      continue;
    }
    let childText: string;
    try { childText = await readFile(path.join(child.directory, 'closure.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        add({
          code: 'child_closure_missing',
          message: `Child ${childPath} is archived without a closure manifest.`,
          recovery: repair(childPath),
          parentRelativePath: location.relativePath,
          childRelativePath: childPath,
          recordedSha256,
        });
        continue;
      }
      throw error;
    }
    const actualSha256 = createHash('sha256').update(childText).digest('hex');
    let childManifest: Record<string, any>;
    try { childManifest = JSON.parse(childText) as Record<string, any>; }
    catch {
      add({
        code: 'child_closure_invalid',
        message: `Child ${childPath} closure manifest is not valid JSON.`,
        recovery: repair(childPath),
        parentRelativePath: location.relativePath,
        childRelativePath: childPath,
        recordedSha256,
        actualSha256,
      });
      continue;
    }
    if (typeof childManifest.closedAt !== 'string') {
      add({
        code: 'child_closure_invalid',
        message: `Child ${childPath} closure manifest records no closedAt.`,
        recovery: repair(childPath),
        parentRelativePath: location.relativePath,
        childRelativePath: childPath,
        recordedSha256,
        actualSha256,
      });
      continue;
    }
    if (actualSha256 !== recordedSha256) {
      add({
        code: 'child_closure_hash_mismatch',
        message: `Child ${childPath} closure hash changed after ${location.relativePath} was archived.`,
        recovery: repair(childPath),
        parentRelativePath: location.relativePath,
        childRelativePath: childPath,
        recordedSha256,
        actualSha256,
      });
    }
  }
  for (const child of children) {
    if (recorded.has(child.relativePath)) continue;
    if (child.scope === 'archive') {
      add({
        code: 'child_closure_unrecorded',
        message: `Archived child ${child.relativePath} is not recorded in ${location.relativePath}'s rollup.`,
        recovery: repair(child.relativePath),
        parentRelativePath: location.relativePath,
        childRelativePath: child.relativePath,
      });
    } else {
      add({
        code: 'child_not_archived',
        message: `Child ${child.relativePath} is active while parent ${location.relativePath} is archived.`,
        recovery: repair(child.relativePath),
        parentRelativePath: location.relativePath,
        childRelativePath: child.relativePath,
      });
    }
  }
  return report;
}

async function buildClosureManifest(root: string, change: Change, preview: CapabilityPreview, directory: string, relativePath: string, resultingRevision?: number, acceptedPlanDrift = false, artifactRefresh: 'generated-state' | 'none' = 'none', acceptedArtifactBasis = false): Promise<ClosureManifest> {
  const evidence = await readEvidence(root, change.id);
  const plan = await inspectPlan(root, change);
  const facets = await evaluateVerificationFacets(root, change.id, change);
  const { records: rollupChildren, descendants: rollupDescendants } = await readChildClosureRecords(root, relativePath);
  const currentEvidenceIds = new Set(facets.checks.filter(facet => facet.status === 'current' && facet.evidenceId).map(facet => facet.evidenceId!));
  const finalEvidence = evidence.filter(record => currentEvidenceIds.has(record.id)).at(-1) ?? evidence.at(-1);
  const renderStatuses = new Map(preview.artifacts.map(artifact => [artifact.artifact, artifact.status]));
  const artifacts: ClosureManifestArtifact[] = [];
  for (const [artifact, relative] of Object.entries(change.artifacts).sort(([left], [right]) => left.localeCompare(right))) {
    let content: Buffer | undefined;
    try { content = await readFile(path.join(directory, relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Rendered and canonical views report drift against the model; authored, state, and custom
    // files are `present` when they exist because they are inputs rather than render outputs.
    const status: ArtifactStatusValue = renderStatuses.get(artifact) ?? (content ? 'present' : 'missing');
    artifacts.push({
      artifact,
      path: relative,
      role: artifactRole(artifact),
      status,
      ...(content ? { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength } : {}),
    });
  }
  const logs: ClosureManifest['evidence']['logs'] = [];
  for (const record of evidence) {
    if (!record.logPath) continue;
    const content = await readFile(path.join(directory, record.logPath)).catch(() => undefined);
    logs.push({
      evidenceId: record.id,
      path: record.logPath,
      ...(content ? { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength } : {}),
    });
  }
  return {
    schemaVersion: 1,
    changeId: change.id,
    changeName: change.name,
    mode: change.mode,
    closedAt: new Date().toISOString(),
    ...(hasSubstantiveContent(change.intent) || hasSubstantiveContent(change.outcome)
      ? { narrative: { intent: change.intent?.trim() ?? '', outcome: change.outcome?.trim() ?? '' } }
      : {}),
    revision: change.revision ?? 0,
    ...(change.contentRevision === undefined ? {} : { contentRevision: change.contentRevision }),
    contribution: preview.contribution,
    capability: {
      name: preview.baselineName,
      baselineWritten: preview.contribution !== 'none',
      ...(preview.baselineRevision === undefined ? {} : { baselineRevision: preview.baselineRevision }),
      ...(resultingRevision === undefined ? {} : { resultingRevision }),
      ...(change.capabilityRationale === undefined ? {} : { rationale: change.capabilityRationale }),
      deltaOperations: change.capabilityDelta?.operations.length ?? 0,
    },
    verification: {
      status: preview.verification.status,
      basis: preview.verification.basis,
      ...(finalEvidence === undefined ? {} : { evidenceId: finalEvidence.id }),
      current: preview.verification.current,
      failed: preview.verification.failed,
      stale: preview.verification.stale,
      unknown: preview.verification.unknown,
      missing: preview.verification.missing,
      sourceBound: preview.sourceBinding.bound,
    },
    sourceBinding: { ...preview.sourceBinding, acceptedArtifactBasis: acceptedArtifactBasis && !preview.sourceBinding.bound },
    tasks: {
      total: change.tasks.length,
      completed: change.tasks.filter(task => task.status === 'completed').length,
      ids: change.tasks.map(task => task.id),
    },
    checks: { total: change.checks.length, ids: change.checks.map(check => check.id) },
    requirements: { total: change.requirements.length, ids: change.requirements.map(requirement => requirement.id) },
    scenarios: change.acceptanceScenarios.length,
    coverage: preview.coverage,
    artifacts,
    artifactRefresh,
    plan: {
      status: plan.drift.status === 'none' ? 'current' : plan.drift.status,
      ...(change.sourcePlan ? { path: change.sourcePlan.path, recordedSha256: change.sourcePlan.sha256 } : {}),
      ...(plan.currentSha256 ? { currentSha256: plan.currentSha256 } : {}),
      contractSha256: plan.contractSha256,
      validation: plan.validation.status,
      ...(plan.validation.error ? { validationError: plan.validation.error } : {}),
      acceptedDrift: acceptedPlanDrift && (plan.drift.status === 'drifted' || plan.drift.status === 'missing' || plan.validation.status === 'invalid'),
      checkedAt: new Date().toISOString(),
    },
    ...(rollupChildren.length ? { rollup: { children: rollupChildren, descendants: rollupDescendants } } : {}),
    evidence: {
      records: evidence.length,
      current: evidence.filter(record => currentEvidenceIds.has(record.id)).length,
      superseded: evidence.filter(record => !currentEvidenceIds.has(record.id)).length,
      attachments: evidence.reduce((total, record) => total + (record.attachments?.length ?? 0), 0),
      items: evidence.map(record => ({
        evidenceId: record.id,
        status: currentEvidenceIds.has(record.id) ? 'current' : 'superseded',
        outcome: record.outcome,
        summary: record.summary,
        capturedAt: record.capturedAt,
        provenance: record.provenance,
        requirementIds: [...record.requirementIds],
        scenarioIds: [...(record.scenarioIds ?? [])],
        taskIds: [...record.taskIds],
        checkIds: [...(record.checkIds ?? [])],
        ...(record.capture ? { capture: record.capture } : {}),
        attachments: (record.attachments ?? []).map(attachment => ({ ...attachment })),
      })),
      logs,
    },
    remoteDelivery: { status: preview.remoteDelivery.status },
  };
}

const deliveryLabel: Record<RemoteDeliveryStatus, string> = {
  not_configured: 'not configured (no local sync journal)',
  unknown: 'unknown',
  not_delivered: 'not delivered (local sync is behind the closed revision)',
  delivered: 'delivered (local sync covers the closed revision)',
};

/** Current records lead; superseded records follow oldest-first for a readable history. */
function orderEvidenceItems(items: ClosureEvidenceItem[]): ClosureEvidenceItem[] {
  return [...items].sort((left, right) => {
    if (left.status !== right.status) return left.status === 'current' ? -1 : 1;
    return left.capturedAt.localeCompare(right.capturedAt);
  });
}

/** Describe recorded source binding for human-readable closure output. */
function sourceBindingLabel(binding?: ClosureManifest['sourceBinding']): string {
  if (!binding) return 'not recorded';
  const counts = `${binding.gitChecks} git, ${binding.workspaceChecks} workspace fingerprint, ${binding.unboundChecks} unbound current check${binding.unboundChecks === 1 ? '' : 's'}`;
  if (binding.basis === 'git') return `Git (source bound; ${counts})`;
  if (binding.basis === 'artifact') return binding.bound
    ? `artifact basis, workspace fingerprint bound (${counts})`
    : `artifact basis, source unbound${binding.acceptedArtifactBasis ? ' (accepted)' : ' (not accepted)'} (${counts})`;
  if (binding.basis === 'mixed') return binding.bound
    ? `mixed basis, source bound (${counts})`
    : `mixed basis, source partially unbound${binding.acceptedArtifactBasis ? ' (accepted)' : ''} (${counts})`;
  return 'none (no current checks)';
}

/** Render a human-readable closure view from the same manifest that close writes. */
export function renderClosureMarkdown(manifest: ClosureManifest): string {
  const lines = [
    GENERATED_ARTIFACT_MARKER,
    '',
    `# Closure: ${manifest.changeName}`,
    '',
    `- Change: ${manifest.changeId} (revision ${manifest.revision}, mode ${manifest.mode})`,
    `- Closed at: ${manifest.closedAt}`,
    ...(manifest.narrative ? [
      `- Intent: ${manifest.narrative.intent.replace(/\s+/g, ' ') || '(blank)'}`,
      `- Outcome: ${manifest.narrative.outcome.replace(/\s+/g, ' ') || '(blank)'}`,
    ] : []),
    `- Capability contribution: ${manifest.contribution}`,
    manifest.capability.baselineWritten === false
      ? '- Capability baseline: not written (no-impact change)'
      : `- Capability baseline: ${manifest.capability.name}${manifest.capability.resultingRevision === undefined ? '' : ` at revision ${manifest.capability.resultingRevision}`}`,
    `- Verification: ${manifest.verification.status} (${manifest.verification.basis} basis)${manifest.verification.evidenceId ? `; evidence ${manifest.verification.evidenceId}` : ''}`,
    `- Source binding: ${sourceBindingLabel(manifest.sourceBinding)}`,
    `- Tasks: ${manifest.tasks.completed}/${manifest.tasks.total} completed`,
    `- Remote delivery: ${deliveryLabel[manifest.remoteDelivery.status]}`,
    '',
    '## Verification',
    '',
    `- Current: ${manifest.verification.current.join(', ') || '(none)'}`,
    ...(manifest.verification.missing.length ? [`- Missing: ${manifest.verification.missing.join(', ')}`] : []),
    ...(manifest.verification.failed.length ? [`- Failed: ${manifest.verification.failed.join(', ')}`] : []),
    ...(manifest.verification.stale.length ? [`- Stale: ${manifest.verification.stale.join(', ')}`] : []),
    ...(manifest.verification.unknown.length ? [`- Unknown: ${manifest.verification.unknown.join(', ')}`] : []),
    ...(manifest.rollup?.children.length ? [
      '',
      '## Rollup children',
      '',
      ...manifest.rollup.children.map(child => `- ${child.relativePath} (${child.changeId}): ${child.verification.status} (${child.verification.basis} basis${child.verification.sourceBound === undefined ? '' : child.verification.sourceBound ? ', source bound' : ', source unbound'}), contribution ${child.contribution}, closed ${child.closedAt}, closure sha256 ${child.closureSha256}`),
      ...(manifest.rollup.descendants ? [
        '',
        `- Descendants: ${manifest.rollup.descendants.nodes} node${manifest.rollup.descendants.nodes === 1 ? '' : 's'} (${manifest.rollup.descendants.leaves === 1 ? '1 leaf' : `${manifest.rollup.descendants.leaves} leaves`}); requirements ${manifest.rollup.descendants.requirements}, checks ${manifest.rollup.descendants.checks}, current evidence ${manifest.rollup.descendants.currentEvidence}, tasks ${manifest.rollup.descendants.tasks.completed}/${manifest.rollup.descendants.tasks.total} completed`,
      ] : []),
    ] : []),
    '',
    '## Coverage',
    '',
    `- Policy: ${manifest.coverage.policy}`,
    `- Requirements: ${manifest.coverage.requirements.covered}/${manifest.coverage.requirements.total} covered${manifest.coverage.requirements.uncovered.length ? `; uncovered ${manifest.coverage.requirements.uncovered.join(', ')}` : ''}`,
    `- Scenarios: ${manifest.coverage.scenarios.covered}/${manifest.coverage.scenarios.total} covered${manifest.coverage.scenarios.uncovered.length ? `; uncovered ${manifest.coverage.scenarios.uncovered.join(', ')}` : ''}`,
    ...(manifest.coverage.tasks ? [`- Tasks: ${manifest.coverage.tasks.covered}/${manifest.coverage.tasks.total} linked${manifest.coverage.tasks.uncovered.length ? `; unlinked ${manifest.coverage.tasks.uncovered.join(', ')}` : ''}`] : []),
    ...(manifest.coverage.unlinkedChecks.length ? [`- Checks without links: ${manifest.coverage.unlinkedChecks.join(', ')}`] : []),
    '',
    '## Artifacts',
    '',
    ...manifest.artifacts.map(artifact => `- ${artifact.artifact} [${artifact.role}]: ${artifact.status} (${artifact.bytes ?? 0} bytes)`),
    '',
    '## Evidence',
    '',
    `- Records: ${manifest.evidence.records} (${manifest.evidence.current ?? 0} current, ${manifest.evidence.superseded ?? 0} superseded)`,
    `- Attachments: ${manifest.evidence.attachments}`,
    ...(manifest.evidence.items?.length ? ['', '### Records', '', ...orderEvidenceItems(manifest.evidence.items).flatMap(item => {
      const capture = item.capture;
      const context = [
        item.taskIds.length ? `tasks ${item.taskIds.join(', ')}` : '',
        item.requirementIds.length ? `requirements ${item.requirementIds.join(', ')}` : '',
        item.scenarioIds.length ? `scenarios ${item.scenarioIds.join(', ')}` : '',
        item.checkIds.length ? `checks ${item.checkIds.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      const summaryLines = item.summary.split(/\r?\n/).map(line => line.trimEnd());
      const headline = summaryLines[0]?.trim() || item.outcome;
      const detail = summaryLines.slice(1).filter(line => line.trim().length > 0);
      return [
        `- ${item.evidenceId} [${item.status}] ${item.outcome}: ${headline}`,
        `  - Captured: ${item.capturedAt} (${item.provenance})`,
        ...(context ? [`  - Links: ${context}`] : []),
        ...detail.map(line => `  ${line}`),
        ...(capture ? [`  - Capture: ${capture.url} via ${capture.browser}${capture.viewport ? ` at ${capture.viewport.width}x${capture.viewport.height}` : ''}${capture.title ? `; title "${capture.title}"` : ''}`] : []),
        ...item.attachments.map(attachment => `  - Attachment ${attachment.name} [${attachment.kind ?? 'other'}]: ${attachment.path}, ${attachment.bytes} bytes, sha256 ${attachment.sha256}${attachment.provenance ? `; captured from ${attachment.provenance.url} via ${attachment.provenance.browser}` : ''}`),
      ];
    })] : []),
    ...manifest.evidence.logs.map(log => `- Log ${log.evidenceId}: ${log.path} (${log.bytes ?? 0} bytes)`),
    '',
    '## Notes',
    '',
    '- Local closure is a repository fact; it does not imply remote delivery.',
    '- Export the complete package with `notchlet change export ' + manifest.changeId + ' --format json`.',
    '',
  ];
  return lines.join('\n');
}

async function writeClosureView(directory: string, manifest: ClosureManifest, options: { markdown?: boolean } = {}): Promise<void> {
  if (options.markdown) {
    const markdown = renderClosureMarkdown(manifest);
    manifest.artifacts.push({ artifact: 'closure.md', path: 'closure.md', role: 'rendered', status: 'current', sha256: createHash('sha256').update(markdown).digest('hex'), bytes: Buffer.byteLength(markdown, 'utf8') });
    await atomicJson(path.join(directory, 'closure.json'), manifest);
    await writeFile(path.join(directory, 'closure.md'), markdown);
    return;
  }
  await atomicJson(path.join(directory, 'closure.json'), manifest);
}

/** Refresh only lifecycle-only rendered drift; authored drift still blocks closure. */
async function refreshGeneratedArtifacts(root: string, changeId: string): Promise<{ refreshed: boolean; change: Change }> {
  const inspection = await inspectChangeArtifacts(root, changeId);
  const rendered = inspection.artifacts.filter(artifact => artifact.status !== 'present');
  const refreshable = rendered.filter(artifact => artifact.status === 'drifted' && artifact.drift === 'generated-state');
  if (!refreshable.length) return { refreshed: false, change: inspection.change };
  const blocked = rendered.some(artifact => artifact.status !== 'current' && !refreshable.includes(artifact));
  if (blocked) return { refreshed: false, change: inspection.change };
  const written = await writeChangeArtifacts(root, changeId);
  return { refreshed: true, change: written.change };
}

export async function closeChange(root: string, changeId: string, options: CloseOptions = {}): Promise<{ archived: true; baselineRevision?: number; preview: CapabilityPreview; manifestPath: string; contractSha256?: string; artifactRefresh: 'generated-state' | 'none' }> {
  const normalized = validateChangeId(changeId);
  let location;
  try { location = await resolveChangeLocation(root, normalized, { scope: 'active' }); }
  catch (error) {
    if (!(error instanceof WorkflowError) || error.code !== 'change_not_found') throw error;
    const pending = await findJournal(root, normalized);
    if (!pending) throw error;
    location = await resolveChangeLocation(root, pending.journal.relativePath ?? normalized, { scope: 'merged' });
  }
  const found = await findJournal(root, normalized, location.relativePath);
  const journal = found?.journal ?? null;
  const relativePath = journal?.relativePath ?? location.relativePath;
  const existing = journal ? null : await readChange(root, relativePath);
  const baselineName = journal?.baselineName ?? existing?.capabilityName ?? location.id;
  const fileSet = paths(root, relativePath, baselineName);
  const release = await acquireLock(fileSet.lock);
  try {
    const recovery = await recoverUnlocked(root, normalized, relativePath);
    if (recovery.archived) {
      const preview = await previewCapabilityClose(root, relativePath).catch(() => archivedPreview(baselineName, recovery.baselineRevision));
      const archivedChange = await readArchivedChange(root, relativePath).catch(() => undefined);
      return { archived: true, ...(recovery.baselineRevision === undefined ? {} : { baselineRevision: recovery.baselineRevision }), preview, manifestPath: `.notchlet/archive/${relativePath}/closure.json`, artifactRefresh: 'none', ...(archivedChange === undefined ? {} : { contractSha256: (await inspectPlan(root, archivedChange)).contractSha256 }) };
    }

    let change = await readChange(root, relativePath);
    const refresh = await refreshGeneratedArtifacts(root, relativePath);
    change = refresh.change;
    const artifactRefresh: 'generated-state' | 'none' = refresh.refreshed ? 'generated-state' : 'none';
    const preview = await assess(root, change, {}, relativePath, { acceptArtifactBasis: options.acceptArtifactBasis });
    const planInspection = await inspectPlan(root, change);
    const planProblems = [
      ...(planInspection.drift.status === 'drifted' || planInspection.drift.status === 'missing' ? [`source plan is ${planInspection.drift.status}${planInspection.drift.reason ? ` (${planInspection.drift.reason})` : ''}`] : []),
      ...(planInspection.validation.status === 'invalid' ? [`source plan no longer validates: ${planInspection.validation.error ?? 'invalid plan'}`] : []),
    ];
    if (planProblems.length && !options.acceptPlanDrift) {
      throw new WorkflowError('plan_drift_unacknowledged', `Closure is blocked because the source plan provenance is not clean: ${planProblems.join('; ')}.`, 'Re-import the plan, sync the recorded hash with `notchlet change plan sync <change>`, or pass --accept-plan-drift to archive with the drift recorded.');
    }
    const closedBlockers = () => {
      if (preview.blockers.length) {
        throw new WorkflowError('closure_blocked', `Local closure is blocked: ${preview.blockers.map(blocker => blocker.code).join(', ')}.`, 'Resolve the listed acceptance, artifact, and capability blockers, then run close --preview again.');
      }
    };
    if (preview.contribution === 'none') {
      closedBlockers();
      // No-impact closure never reads or writes a capability baseline; archive is the only mutation.
      await archiveEvidenceArtifacts(root, change.id);
      const manifest = await buildClosureManifest(root, change, preview, fileSet.change, relativePath, undefined, options.acceptPlanDrift, artifactRefresh, options.acceptArtifactBasis);
      await writeClosureView(fileSet.change, manifest, { markdown: options.renderMarkdown });
      await mkdir(path.dirname(fileSet.archive), { recursive: true });
      await archiveChangeDirectory(fileSet.change, fileSet.archive);
      return { archived: true, preview, manifestPath: `.notchlet/archive/${relativePath}/closure.json`, contractSha256: planInspection.contractSha256, artifactRefresh };
    }

    const baseline = await readBaseline(fileSet.baseline, baselineName);
    if (change.baselineRevision === undefined) {
      throw new WorkflowError('baseline_revision_missing', 'The change has no recorded capability baseline revision.', `Run \`notchlet change baseline ${changeId}\` before closing.`);
    }
    if (options.expectedBaselineRevision === undefined) {
      throw new WorkflowError('baseline_revision_required', 'Closing a standard or delta change requires the previewed baseline revision.', `Run \`notchlet change close ${changeId} --preview\`, then pass --baseline-revision.`);
    }
    if (baseline.revision !== options.expectedBaselineRevision || change.baselineRevision !== baseline.revision) {
      throw new WorkflowError('baseline_revision_conflict', `Capability baseline revision changed: expected ${options.expectedBaselineRevision}, found ${baseline.revision}.`, 'Reload the baseline and change, review the capability delta, and preview closure again.');
    }
    closedBlockers();

    const revision = baseline.revision + 1;
    const acceptedAt = new Date().toISOString();
    const requirements = new Map(baseline.requirements.map(entry => [entry.value.id, entry]));
    const scenarios = new Map(baseline.scenarios.map(entry => [entry.value.id, entry]));
    for (const operation of change.capabilityDelta?.operations ?? []) {
      if (operation.operation === 'remove') {
        requirements.delete(operation.requirementId);
        for (const [id, entry] of scenarios) if (entry.value.requirementId === operation.requirementId) scenarios.delete(id);
        continue;
      }
      if (operation.requirement) {
        requirements.set(operation.requirementId, {
          value: operation.requirement,
          provenance: { changeId, revision: change.revision ?? 0, acceptedAt, rationale: operation.rationale },
        });
      }
      if (operation.scenarios) {
        for (const [id, entry] of scenarios) if (entry.value.requirementId === operation.requirementId) scenarios.delete(id);
        for (const scenario of operation.scenarios) {
          scenarios.set(scenario.id, {
            value: scenario,
            provenance: { changeId, revision: change.revision ?? 0, acceptedAt, rationale: operation.rationale },
          });
        }
      }
    }

    const nextBaseline: CapabilityBaseline = {
      schemaVersion: 1,
      name: baselineName,
      revision,
      requirements: [...requirements.values()],
      scenarios: [...scenarios.values()],
    };
    const closeJournal: CloseJournal = {
      schemaVersion: 1,
      operationId: randomUUID(),
      changeId: change.id,
      relativePath,
      baselineName: nextBaseline.name,
      expectedBaselineRevision: baseline.revision,
      expectedBaselineHash: hash(baseline),
      nextBaseline,
      phase: 'prepared',
    };
    await archiveEvidenceArtifacts(root, changeId);
    await atomicJson(fileSet.journal, closeJournal);
    await options.injectInterruption?.('journal-prepared');
    await atomicJson(fileSet.baseline, nextBaseline);
    const manifest = await buildClosureManifest(root, change, preview, fileSet.change, relativePath, revision, options.acceptPlanDrift, artifactRefresh, options.acceptArtifactBasis);
    await writeClosureView(fileSet.change, manifest, { markdown: options.renderMarkdown });
    closeJournal.phase = 'baseline-written';
    await atomicJson(fileSet.journal, closeJournal);
    await options.injectInterruption?.('baseline-written');
    await mkdir(path.dirname(fileSet.archive), { recursive: true });
    await archiveChangeDirectory(fileSet.change, fileSet.archive);
    closeJournal.phase = 'change-archived';
    await atomicJson(fileSet.journal, closeJournal);
    await options.injectInterruption?.('change-archived');
    closeJournal.phase = 'complete';
    await atomicJson(fileSet.journal, closeJournal);
    return { archived: true, baselineRevision: revision, preview, manifestPath: `.notchlet/archive/${relativePath}/closure.json`, contractSha256: planInspection.contractSha256, artifactRefresh };
  } finally {
    await release();
    await rmdir(path.dirname(fileSet.journal)).catch(() => undefined);
  }
}

export interface CaptureBaselineOptions {
  capabilityName?: string;
  expectedRevision?: number;
}

/** Record the capability baseline revision that exists at capture time. */
export async function captureCapabilityBaseline(root: string, changeId: string, options: CaptureBaselineOptions = {}): Promise<{ change: Change; baselineName: string; baselineRevision: number }> {
  const normalized = validateChangeId(changeId);
  const location = await resolveChangeLocation(root, normalized, { scope: 'active' });
  const current = await readChange(root, location.relativePath);
  const name = capabilityName(options.capabilityName ?? current.capabilityName ?? current.id);
  const baseline = await readBaseline(paths(root, location.relativePath, name).baseline, name);
  const change = await mutateChange(root, location.relativePath, existing => ({ ...existing, capabilityName: name, baselineRevision: baseline.revision }), { expectedRevision: options.expectedRevision });
  return { change, baselineName: name, baselineRevision: baseline.revision };
}
