import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
export { inspectGitContext } from './git-context.js';
export type { GitContextResult, GitFingerprint, GitRepositoryIdentity, NormalizedRemote } from './git-context.js';
export { appendEvidence, evaluateEvidenceFreshness, parseEvidenceRecord, readEvidence } from './evidence.js';
export type { EvidenceFreshness, EvidenceKind, EvidenceOutcome, EvidenceProvenance, EvidenceRecord, EvidenceWriteInput } from './evidence.js';
export { closeChange, previewCapabilityClose, recoverCapabilityClose } from './closure.js';
export type { CapabilityBaseline, CapabilityEntry, CapabilityPreview, CloseInterruptionPoint, CloseOptions } from './closure.js';

export const WORKSPACE = '.notchlet';
export const CHANGE_SCHEMA_VERSION = 1;
export const CORE_VERSION = '0.1.0';
export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export interface Requirement { id: string; title: string; description: string; }
export interface AcceptanceScenario { id: string; requirementId: string; when: string; then: string; }
export interface DesignDecision { id: string; decision: string; rationale: string; }
export interface Check { id: string; description: string; }
export interface Task { id: string; title: string; status: TaskStatus; dependencies: string[]; requirementIds: string[]; }
export interface CapabilityDelta { operations: Array<{ operation: 'add' | 'update' | 'remove'; requirementId: string; requirement?: Requirement; scenarios?: AcceptanceScenario[]; rationale: string }>; }
export interface Change { schemaVersion: number; id: string; name: string; createdAt: string; mode: 'quick' | 'standard'; intent: string; outcome: string; requirements: Requirement[]; acceptanceScenarios: AcceptanceScenario[]; designDecisions: DesignDecision[]; checks: Check[]; tasks: Task[]; artifacts: Record<string, string>; revision?: number; baselineRevision?: number; capabilityName?: string; capabilityImpact?: 'none' | 'delta'; capabilityRationale?: string; capabilityDelta?: CapabilityDelta; }
export interface Evidence { schemaVersion: 1; id: string; kind: string; summary: string; recordedAt: string; uri?: string; checkIds?: string[]; }
export interface Instruction { schemaVersion: 1; changeId: string; generatedAt: string; body: string; taskIds: string[]; }
export interface CliError { code: string; message: string; recovery: string; }
export interface CliJsonEnvelope { protocolVersion: 1; command: string; ok: boolean; data: unknown; error: CliError | null; warnings: unknown[]; }

export class WorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly recovery: string) { super(message); this.name = 'WorkflowError'; }
}

type JsonRecord = Record<string, unknown>;
function record(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isDateTime(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
function schemaError(message: string): never { throw new WorkflowError('invalid_schema', message, 'Correct the JSON fields to match the version 1 schema and try again.'); }
function exactKeys(value: JsonRecord, allowed: string[], required: string[], label: string): void {
  for (const key of required) if (!(key in value)) schemaError(`${label} is missing required field "${key}".`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) schemaError(`${label} has unsupported field "${key}".`);
}
function stringField(value: JsonRecord, key: string, label: string): string {
  if (typeof value[key] !== 'string' || !value[key].trim()) schemaError(`${label}.${key} must be a non-empty string.`);
  return value[key] as string;
}
function textField(value: JsonRecord, key: string, label: string): string {
  if (typeof value[key] !== 'string') schemaError(`${label}.${key} must be a string.`);
  return value[key] as string;
}
function stringArray(value: JsonRecord, key: string, label: string): string[] {
  if (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string')) schemaError(`${label}.${key} must be an array of strings.`);
  return value[key] as string[];
}
function parseRequirementValue(value: unknown): Requirement {
  if (!record(value)) schemaError('requirement must be an object.');
  exactKeys(value, ['id', 'title', 'description'], ['id', 'title', 'description'], 'requirement');
  return { id: stringField(value, 'id', 'requirement'), title: stringField(value, 'title', 'requirement'), description: stringField(value, 'description', 'requirement') };
}
export function parseRequirement(value: unknown): Requirement { return parseRequirementValue(value); }
function parseTaskValue(value: unknown): Task {
  if (!record(value)) schemaError('task must be an object.');
  exactKeys(value, ['id', 'title', 'status', 'dependencies', 'requirementIds'], ['id', 'title', 'status', 'dependencies', 'requirementIds'], 'task');
  if (!['pending', 'in_progress', 'completed'].includes(String(value.status))) schemaError('task.status must be pending, in_progress, or completed.');
  return { id: stringField(value, 'id', 'task'), title: stringField(value, 'title', 'task'), status: value.status as TaskStatus, dependencies: stringArray(value, 'dependencies', 'task'), requirementIds: stringArray(value, 'requirementIds', 'task') };
}
export function parseTask(value: unknown): Task { return parseTaskValue(value); }
function parseAcceptanceScenarioValue(value: unknown): AcceptanceScenario {
  if (!record(value)) schemaError('acceptance scenario must be an object.');
  exactKeys(value, ['id', 'requirementId', 'when', 'then'], ['id', 'requirementId', 'when', 'then'], 'acceptance scenario');
  return { id: stringField(value, 'id', 'acceptance scenario'), requirementId: stringField(value, 'requirementId', 'acceptance scenario'), when: stringField(value, 'when', 'acceptance scenario'), then: stringField(value, 'then', 'acceptance scenario') };
}
export function parseAcceptanceScenario(value: unknown): AcceptanceScenario { return parseAcceptanceScenarioValue(value); }
function parseDesignDecisionValue(value: unknown): DesignDecision {
  if (!record(value)) schemaError('design decision must be an object.');
  exactKeys(value, ['id', 'decision', 'rationale'], ['id', 'decision', 'rationale'], 'design decision');
  return { id: stringField(value, 'id', 'design decision'), decision: stringField(value, 'decision', 'design decision'), rationale: stringField(value, 'rationale', 'design decision') };
}
export function parseDesignDecision(value: unknown): DesignDecision { return parseDesignDecisionValue(value); }
function parseCheckValue(value: unknown): Check {
  if (!record(value)) schemaError('check must be an object.');
  exactKeys(value, ['id', 'description'], ['id', 'description'], 'check');
  return { id: stringField(value, 'id', 'check'), description: stringField(value, 'description', 'check') };
}
function artifactMap(value: unknown): Record<string, string> {
  if (!record(value) || Object.values(value).some(item => typeof item !== 'string')) schemaError('change.artifacts must be an object whose values are strings.');
  return value as Record<string, string>;
}

/** Parse and structurally validate serialized v1 change metadata. */
export function parseChange(input: string | unknown): Change {
  let value: unknown;
  try { value = typeof input === 'string' ? JSON.parse(input) as unknown : input; }
  catch { throw new WorkflowError('malformed_json', 'Change metadata is not valid JSON.', 'Repair the JSON syntax in tasks.json, then run validate again.'); }
  if (!record(value)) schemaError('change must be a JSON object.');
  if (typeof value.schemaVersion === 'number' && value.schemaVersion !== CHANGE_SCHEMA_VERSION) {
    throw new WorkflowError('unsupported_version', `Change schema version ${value.schemaVersion} is not supported.`, 'Use schema version 1 or migrate the change metadata before reading it.');
  }
  exactKeys(value, ['schemaVersion', 'id', 'name', 'createdAt', 'mode', 'intent', 'outcome', 'requirements', 'acceptanceScenarios', 'designDecisions', 'checks', 'tasks', 'artifacts', 'revision', 'baselineRevision', 'capabilityName', 'capabilityImpact', 'capabilityRationale', 'capabilityDelta'], ['schemaVersion', 'id', 'name', 'createdAt', 'mode', 'intent', 'outcome', 'requirements', 'checks', 'tasks', 'artifacts'], 'change');
  if (value.schemaVersion !== CHANGE_SCHEMA_VERSION) schemaError('change.schemaVersion must be 1.');
  if (value.mode !== 'quick' && value.mode !== 'standard') schemaError('change.mode must be quick or standard.');
  if (!isDateTime(value.createdAt)) schemaError('change.createdAt must be a date-time string.');
  if (!Array.isArray(value.requirements)) schemaError('change.requirements must be an array.');
  if (value.acceptanceScenarios !== undefined && !Array.isArray(value.acceptanceScenarios)) schemaError('change.acceptanceScenarios must be an array when present.');
  if (value.designDecisions !== undefined && !Array.isArray(value.designDecisions)) schemaError('change.designDecisions must be an array when present.');
  if (!Array.isArray(value.checks)) schemaError('change.checks must be an array.');
  if (!Array.isArray(value.tasks)) schemaError('change.tasks must be an array.');
  if (value.revision !== undefined && (!Number.isInteger(value.revision) || (value.revision as number) < 0)) schemaError('change.revision must be a non-negative integer.');
  if (value.baselineRevision !== undefined && (!Number.isInteger(value.baselineRevision) || (value.baselineRevision as number) < 0)) schemaError('change.baselineRevision must be a non-negative integer.');
  if (value.capabilityImpact !== undefined && value.capabilityImpact !== 'none' && value.capabilityImpact !== 'delta') schemaError('change.capabilityImpact must be none or delta.');
  if (value.capabilityRationale !== undefined && typeof value.capabilityRationale !== 'string') schemaError('change.capabilityRationale must be a string.');
  if (value.capabilityName !== undefined && (typeof value.capabilityName !== 'string' || !value.capabilityName.trim())) schemaError('change.capabilityName must be a non-empty string.');
  if (value.capabilityDelta !== undefined && !record(value.capabilityDelta)) schemaError('change.capabilityDelta must be an object.');
  let capabilityDelta: CapabilityDelta | undefined;
  if (value.capabilityDelta !== undefined) {
    exactKeys(value.capabilityDelta as JsonRecord, ['operations'], ['operations'], 'capabilityDelta');
    if (!Array.isArray((value.capabilityDelta as JsonRecord).operations)) schemaError('capabilityDelta.operations must be an array.');
    capabilityDelta = { operations: ((value.capabilityDelta as JsonRecord).operations as unknown[]).map(item => {
      if (!record(item)) schemaError('capability delta operation must be an object.');
      exactKeys(item, ['operation', 'requirementId', 'requirement', 'scenarios', 'rationale'], ['operation', 'requirementId', 'rationale'], 'capability delta operation');
      if (!['add', 'update', 'remove'].includes(String(item.operation))) schemaError('capability delta operation must be add, update, or remove.');
      if (item.requirement !== undefined) item.requirement = parseRequirementValue(item.requirement);
      if (item.scenarios !== undefined) { if (!Array.isArray(item.scenarios)) schemaError('delta scenarios must be an array.'); item.scenarios = item.scenarios.map(parseAcceptanceScenarioValue); }
      return { operation: item.operation as 'add'|'update'|'remove', requirementId: stringField(item, 'requirementId', 'capability delta operation'), ...(item.requirement === undefined ? {} : { requirement: item.requirement as Requirement }), ...(item.scenarios === undefined ? {} : { scenarios: item.scenarios as AcceptanceScenario[] }), rationale: stringField(item, 'rationale', 'capability delta operation') };
    }) };
  }
  return {
    schemaVersion: CHANGE_SCHEMA_VERSION, id: stringField(value, 'id', 'change'), name: stringField(value, 'name', 'change'),
    createdAt: value.createdAt, mode: value.mode, intent: textField(value, 'intent', 'change'), outcome: textField(value, 'outcome', 'change'),
    requirements: value.requirements.map(parseRequirementValue),
    acceptanceScenarios: (value.acceptanceScenarios ?? []).map(parseAcceptanceScenarioValue),
    designDecisions: (value.designDecisions ?? []).map(parseDesignDecisionValue),
    checks: value.checks.map(parseCheckValue), tasks: value.tasks.map(parseTaskValue),
    artifacts: artifactMap(value.artifacts), ...(value.revision === undefined ? {} : { revision: value.revision as number }), ...(value.baselineRevision === undefined ? {} : { baselineRevision: value.baselineRevision as number }), ...(value.capabilityName === undefined ? {} : { capabilityName: value.capabilityName as string }), ...(value.capabilityImpact === undefined ? {} : { capabilityImpact: value.capabilityImpact as 'none'|'delta' }), ...(value.capabilityRationale === undefined ? {} : { capabilityRationale: value.capabilityRationale as string }), ...(capabilityDelta === undefined ? {} : { capabilityDelta }),
  };
}

export function parseEvidence(input: unknown): Evidence {
  if (!record(input)) schemaError('evidence must be an object.');
  exactKeys(input, ['schemaVersion', 'id', 'kind', 'summary', 'recordedAt', 'uri', 'checkIds'], ['schemaVersion', 'id', 'kind', 'summary', 'recordedAt'], 'evidence');
  if (input.schemaVersion !== 1) throw new WorkflowError('unsupported_version', 'Evidence schema version is not supported.', 'Use evidence schema version 1.');
  if (!isDateTime(input.recordedAt)) schemaError('evidence.recordedAt must be a date-time string.');
  if (input.checkIds !== undefined && (!Array.isArray(input.checkIds) || !input.checkIds.every(item => typeof item === 'string' && item.length > 0) || new Set(input.checkIds).size !== input.checkIds.length)) schemaError('evidence.checkIds must be an array of unique non-empty strings.');
  return { schemaVersion: 1, id: stringField(input, 'id', 'evidence'), kind: stringField(input, 'kind', 'evidence'), summary: stringField(input, 'summary', 'evidence'), recordedAt: input.recordedAt, ...(input.uri === undefined ? {} : { uri: stringField(input, 'uri', 'evidence') }), ...(input.checkIds === undefined ? {} : { checkIds: input.checkIds as string[] }) };
}

export function parseInstruction(input: unknown): Instruction {
  if (!record(input)) schemaError('instruction must be an object.');
  exactKeys(input, ['schemaVersion', 'changeId', 'generatedAt', 'body', 'taskIds'], ['schemaVersion', 'changeId', 'generatedAt', 'body', 'taskIds'], 'instruction');
  if (input.schemaVersion !== 1) throw new WorkflowError('unsupported_version', 'Instruction schema version is not supported.', 'Use instruction schema version 1.');
  if (!isDateTime(input.generatedAt)) schemaError('instruction.generatedAt must be a date-time string.');
  return { schemaVersion: 1, changeId: stringField(input, 'changeId', 'instruction'), generatedAt: input.generatedAt, body: stringField(input, 'body', 'instruction'), taskIds: stringArray(input, 'taskIds', 'instruction') };
}

export function parseCliJsonEnvelope(input: unknown): CliJsonEnvelope {
  if (!record(input)) schemaError('CLI JSON envelope must be an object.');
  exactKeys(input, ['protocolVersion', 'command', 'ok', 'data', 'error', 'warnings'], ['protocolVersion', 'command', 'ok', 'data', 'error', 'warnings'], 'CLI JSON envelope');
  if (input.protocolVersion !== 1) throw new WorkflowError('unsupported_version', 'CLI JSON protocol version is not supported.', 'Use protocol version 1.');
  if (typeof input.ok !== 'boolean' || !Array.isArray(input.warnings)) schemaError('CLI envelope ok must be boolean and warnings must be an array.');
  let error: CliError | null = null;
  if (input.error !== null) {
    if (!record(input.error)) schemaError('CLI envelope error must be null or an error object.');
    exactKeys(input.error, ['code', 'message', 'recovery'], ['code', 'message', 'recovery'], 'CLI error');
    error = { code: stringField(input.error, 'code', 'CLI error'), message: stringField(input.error, 'message', 'CLI error'), recovery: stringField(input.error, 'recovery', 'CLI error') };
  }
  if (typeof input.command !== 'string' || !input.command) schemaError('CLI envelope command must be a non-empty string.');
  return { protocolVersion: 1, command: input.command, ok: input.ok, data: input.data, error, warnings: input.warnings };
}

export function stableId(value: string): string {
  const slug = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/g, '');
  return slug || 'change';
}

export async function findWorkspace(start = process.cwd(), explicitRoot?: string): Promise<string | null> {
  if (explicitRoot !== undefined) {
    const candidate = path.resolve(explicitRoot);
    try { if ((await stat(path.join(candidate, WORKSPACE, 'workspace.json'))).isFile()) return candidate; } catch { /* explicit paths never fall back to a parent */ }
    return null;
  }
  let current = path.resolve(start);
  while (true) {
    try { if ((await stat(path.join(current, WORKSPACE, 'workspace.json'))).isFile()) return current; } catch { /* keep walking */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function initWorkspace(root: string): Promise<void> {
  const dir = path.join(path.resolve(root), WORKSPACE);
  await mkdir(dir, { recursive: true });
  const metadata = path.join(dir, 'workspace.json');
  try { await stat(metadata); }
  catch {
    try { await writeFile(metadata, JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  await mkdir(path.join(dir, 'changes'), { recursive: true });
}

export async function scaffold(root: string, name: string, mode: 'quick' | 'standard' = 'standard'): Promise<Change> {
  const id = stableId(name);
  const changes = path.join(root, WORKSPACE, 'changes');
  try { await stat(path.join(root, WORKSPACE, 'workspace.json')); } catch { throw new WorkflowError('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root.'); }
  const dir = path.join(changes, id);
  const stage = await mkdtemp(path.join(changes, '.staging-'));
  const artifacts = mode === 'quick' ? ['proposal.md', 'tasks.json'] : ['proposal.md', 'design.md', 'spec.md', 'tasks.json'];
  const content: Change = { schemaVersion: CHANGE_SCHEMA_VERSION, id, name, createdAt: new Date().toISOString(), mode, intent: '', outcome: '', requirements: [], acceptanceScenarios: [], designDecisions: [], checks: [], tasks: [], artifacts: Object.fromEntries(artifacts.map(a => [a, a])) };
  try {
    for (const artifact of artifacts) {
      const text = artifact === 'tasks.json' ? JSON.stringify(content, null, 2) + '\n' : `# ${name}\n\n<!-- Fill in intent, outcome, requirements, and checks before validation. -->\n\n## Intent\n\n## Outcome\n\n## Requirements\n\n## Checks\n`;
      await writeFile(path.join(stage, artifact), text, { flag: 'wx' });
    }
    try { await rename(stage, dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') throw new WorkflowError('change_exists', `Change already exists: ${id}`, 'Choose a different change name or inspect the existing change.'); throw error; }
  } finally { await rm(stage, { recursive: true, force: true }); }
  return content;
}

export function convertChange(change: Change, mode: 'quick' | 'standard'): Change {
  const artifacts = { ...change.artifacts };
  if (mode === 'standard') {
    artifacts['design.md'] ??= 'design.md';
    artifacts['spec.md'] ??= 'spec.md';
  }
  return { ...change, mode, artifacts };
}

function changeDirectory(root: string, id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new WorkflowError('invalid_change_id', `Invalid change ID: ${id}`, 'Use a change ID returned by `notchlet change list`.');
  return path.join(path.resolve(root), WORKSPACE, 'changes', id);
}

export async function readChange(root: string, id: string): Promise<Change> {
  const file = path.join(changeDirectory(root, id), 'tasks.json');
  try { return parseChange(await readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkflowError('change_not_found', `Change not found: ${id}`, 'List changes with `notchlet change list` and use an existing change ID.');
    throw error;
  }
}

export interface ChangeSummary { id: string; name: string; mode: Change['mode']; taskCount: number; completedTaskCount: number; ready: boolean; }
export async function listChanges(root: string): Promise<ChangeSummary[]> {
  let entries;
  try { entries = await readdir(path.join(path.resolve(root), WORKSPACE, 'changes'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const results: ChangeSummary[] = [];
  for (const entry of entries.filter(item => item.isDirectory() && !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    const change = await readChange(root, entry.name);
    const contents: Record<string, string> = {};
    for (const relative of Object.values(change.artifacts)) {
      try { contents[relative] = await readFile(path.join(root, WORKSPACE, 'changes', entry.name, relative), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    results.push({ id: change.id, name: change.name, mode: change.mode, taskCount: change.tasks.length, completedTaskCount: change.tasks.filter(task => task.status === 'completed').length, ready: readiness(change, contents).ready });
  }
  return results;
}

export async function persistConversion(root: string, id: string, mode: 'quick' | 'standard'): Promise<Change> {
  const dir = changeDirectory(root, id);
  const file = path.join(dir, 'tasks.json');
  const release = await lock(file);
  try {
    let current: Change;
    try { current = parseChange(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkflowError('change_not_found', `Change not found: ${id}`, 'List changes with `notchlet change list` and use an existing change ID.'); throw error; }
    const next = convertChange(current, mode);
    for (const artifact of ['design.md', 'spec.md']) {
      if (current.artifacts[artifact] === undefined && next.artifacts[artifact] !== undefined) {
        try { await writeFile(path.join(dir, next.artifacts[artifact]), `# ${artifact === 'design.md' ? 'Design' : 'Specification'}\n\n`, { flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, file);
    return next;
  } finally { await release(); }
}

export interface Issue { code: string; message: string; recovery: string; }
function hasSubstantiveContent(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('<!--')).length > 0;
}

export function validateChange(change: Change, artifactContents: Record<string, string> = {}): Issue[] {
  const issues: Issue[] = [];
  const issue = (code: string, message: string, recovery = 'Edit the change metadata and run validate again.') => issues.push({ code, message, recovery });
  if (change.schemaVersion !== CHANGE_SCHEMA_VERSION) issue('schema_version', 'Unsupported change schema version.');
  if (!change.name?.trim() || !change.intent?.trim()) issue('missing_intent', 'Change name and intent are required.');
  if (!change.outcome?.trim()) issue('missing_outcome', 'A measurable outcome is required.');
  if (!Array.isArray(change.requirements) || change.requirements.length === 0) issue('missing_requirements', 'At least one requirement is required.');
  if (!Array.isArray(change.checks) || change.checks.length === 0) issue('missing_checks', 'At least one verification check is required.');
  const requirementIds = new Set<string>();
  for (const requirement of change.requirements ?? []) {
    if (!requirement.id?.trim() || !requirement.title?.trim() || !requirement.description?.trim()) issue('invalid_requirement', 'Requirements need an ID, title, and description.');
    if (requirementIds.has(requirement.id)) issue('duplicate_requirement_id', `Duplicate requirement ID: ${requirement.id}`);
    requirementIds.add(requirement.id);
  }
  const checkIds = new Set<string>();
  for (const check of change.checks ?? []) {
    if (!check.id?.trim() || !check.description?.trim()) issue('invalid_check', 'Checks need an ID and description.');
    if (checkIds.has(check.id)) issue('duplicate_check_id', `Duplicate check ID: ${check.id}`);
    checkIds.add(check.id);
  }
  if (change.mode !== 'quick' && change.mode !== 'standard') issue('invalid_mode', 'Mode must be quick or standard.');
  if (change.mode === 'quick' && change.capabilityImpact === undefined) issue('missing_capability_impact', 'Quick changes must explicitly declare capabilityImpact none or delta.');
  if (change.capabilityImpact === 'none' && !change.capabilityRationale?.trim()) issue('missing_capability_rationale', 'A no-impact declaration requires a rationale.');
  if (change.capabilityImpact === 'none' && change.capabilityDelta?.operations.length) issue('conflicting_capability_impact', 'A no-impact declaration cannot include capability delta operations.');
  if (change.capabilityImpact === 'delta' && !change.capabilityDelta?.operations.length) issue('missing_capability_delta', 'A capability-impact declaration requires explicit delta operations.');
  if (change.mode === 'standard') {
    if (change.baselineRevision === undefined) issue('missing_baseline_revision', 'Standard changes must capture the capability baseline revision.');
    if (change.capabilityImpact !== 'none' && (change.capabilityImpact !== 'delta' || !change.capabilityDelta?.operations.length)) issue('missing_capability_delta', 'Standard changes must declare a capability delta or an explicit no-impact rationale.');
  }
  const reqIds = new Set((change.requirements ?? []).map(r => r.id));
  if (change.mode === 'standard') {
    if (!change.artifacts?.['design.md']) issue('missing_design', 'Standard changes require a design artifact.');
    else if (artifactContents[change.artifacts['design.md']] !== undefined && !hasSubstantiveContent(artifactContents[change.artifacts['design.md']])) issue('empty_design', 'The design artifact must contain substantive design content.');
    if (!change.acceptanceScenarios?.length) issue('missing_acceptance_scenarios', 'Standard changes require requirement-linked acceptance scenarios.');
    if (!change.designDecisions?.length || change.designDecisions.some(decision => !decision.decision.trim() || !decision.rationale.trim())) issue('missing_design_decisions', 'Standard changes require at least one design decision with a decision and rationale.');
  }
  const scenarioIds = new Set<string>();
  const scenariosByRequirement = new Set<string>();
  for (const scenario of change.acceptanceScenarios ?? []) {
    if (!scenario.id.trim() || !scenario.when.trim() || !scenario.then.trim()) issue('invalid_acceptance_scenario', 'Acceptance scenarios need an ID and non-empty WHEN and THEN statements.');
    if (scenarioIds.has(scenario.id)) issue('duplicate_scenario_id', `Duplicate acceptance scenario ID: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    if (!reqIds.has(scenario.requirementId)) issue('unknown_scenario_requirement', `Scenario ${scenario.id} references unknown requirement ${scenario.requirementId}.`);
    scenariosByRequirement.add(scenario.requirementId);
  }
  if (change.mode === 'standard') for (const requirement of change.requirements) if (!scenariosByRequirement.has(requirement.id)) issue('uncovered_scenario_requirement', `Requirement ${requirement.id} has no acceptance scenario.`);
  const decisionIds = new Set<string>();
  for (const decision of change.designDecisions ?? []) {
    if (!decision.id.trim() || !decision.decision.trim() || !decision.rationale.trim()) issue('invalid_design_decision', 'Design decisions need an ID, decision, and rationale.');
    if (decisionIds.has(decision.id)) issue('duplicate_design_decision_id', `Duplicate design decision ID: ${decision.id}`);
    decisionIds.add(decision.id);
  }
  const ids = new Set<string>();
  for (const task of change.tasks ?? []) {
    if (ids.has(task.id)) issue('duplicate_task_id', `Duplicate task ID: ${task.id}`);
    ids.add(task.id);
    if (!task.id || !task.title?.trim()) issue('invalid_task', 'Tasks require an ID and title.');
    for (const req of task.requirementIds ?? []) if (!reqIds.has(req)) issue('unknown_requirement', `Task ${task.id} references unknown requirement ${req}.`);
  }
  const tasks = change.tasks ?? [];
  for (const task of tasks) for (const dep of task.dependencies ?? []) if (!ids.has(dep)) issue('unknown_dependency', `${task.id} depends on unknown task ${dep}.`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); const task = tasks.find(t => t.id === id); const cycle = (task?.dependencies ?? []).some(dep => ids.has(dep) && visit(dep)); visiting.delete(id); visited.add(id); return cycle; };
  for (const task of tasks) if (visit(task.id)) { issue('dependency_cycle', `Dependency cycle includes task ${task.id}.`); break; }
  const covered = new Set(tasks.flatMap(task => task.requirementIds ?? []));
  for (const req of change.requirements ?? []) if (!covered.has(req.id)) issue('uncovered_requirement', `Requirement ${req.id} is not covered by a task.`);
  if (tasks.length === 0) issue('missing_tasks', 'At least one task is required.');
  if (!change.artifacts || !change.artifacts['proposal.md']) issue('missing_proposal_artifact', 'proposal.md must be declared.');
  for (const [key, file] of Object.entries(change.artifacts ?? {})) if (!key || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) issue('invalid_artifact_path', `Invalid artifact path: ${file}`);
  return issues;
}

export function readiness(change: Change, artifactContents: Record<string, string> = {}): { ready: boolean; blockers: Issue[] } { const blockers = validateChange(change, artifactContents); return { ready: blockers.length === 0, blockers }; }

export type WorkflowAction = 'plan' | 'revise' | 'implement' | 'verify' | 'resume';
export type VerificationStatus = 'missing' | 'failed' | 'stale' | 'current';
export interface StateEvaluation {
  planning: { status: 'blocked' | 'ready'; blockers: Array<Issue & { source: 'engine' | 'agent_judgment' }> };
  execution: { total: number; pending: number; inProgress: number; completed: number; status: 'pending' | 'in_progress' | 'completed' };
  verification: { status: VerificationStatus; missing: string[]; failed: string[]; stale: string[]; current: string[]; independentlyVerified: boolean };
  localClosure: { closed: boolean; status: 'open' | 'pending_review' | 'closed' };
  remoteDelivery: { status: 'unknown' | 'not_delivered' | 'delivered'; evidence: string[] };
  blockers: Array<{ code: string; message: string; source: 'engine' | 'agent_judgment' }>;
  eligibleTasks: string[];
}

/** Evaluate only facts present in the supplied change/evidence; no clocks, Git, or remote calls are consulted. */
export function evaluateState(change: Change, verification?: { missing?: string[]; failed?: string[]; stale?: string[]; current?: string[]; independentlyVerified?: boolean; remoteDelivery?: { status: 'unknown' | 'not_delivered' | 'delivered'; evidence?: string[] } }, artifactContents: Record<string, string> = {}): StateEvaluation {
  const planBlockers = validateChange(change, artifactContents).map(item => ({ ...item, source: 'engine' as const }));
  const done = new Set(change.tasks.filter(task => task.status === 'completed').map(task => task.id));
  const eligibleTasks = change.tasks.filter(task => task.status !== 'completed' && task.dependencies.every(id => done.has(id))).map(task => task.id);
  const completed = change.tasks.filter(task => task.status === 'completed').length;
  const inProgress = change.tasks.filter(task => task.status === 'in_progress').length;
  const pending = change.tasks.filter(task => task.status === 'pending').length;
  const missing = [...(verification?.missing ?? (change.checks.length ? change.checks.map(check => check.id) : []))];
  const failed = [...(verification?.failed ?? [])];
  const stale = [...(verification?.stale ?? [])];
  const current = [...(verification?.current ?? [])];
  const status: VerificationStatus = failed.length ? 'failed' : stale.length ? 'stale' : missing.length ? 'missing' : 'current';
  const allCompleted = change.tasks.length > 0 && completed === change.tasks.length;
  return {
    planning: { status: planBlockers.length ? 'blocked' : 'ready', blockers: planBlockers },
    execution: { total: change.tasks.length, pending, inProgress, completed, status: allCompleted ? 'completed' : inProgress ? 'in_progress' : 'pending' },
    verification: { status, missing, failed, stale, current, independentlyVerified: verification?.independentlyVerified ?? false },
    localClosure: { closed: allCompleted && status === 'current', status: allCompleted && status === 'current' ? 'closed' : allCompleted ? 'pending_review' : 'open' },
    remoteDelivery: { status: verification?.remoteDelivery?.status ?? 'unknown', evidence: [...(verification?.remoteDelivery?.evidence ?? [])] },
    blockers: planBlockers.map(({ code, message, source }) => ({ code, message, source })),
    eligibleTasks,
  };
}

export function deriveState(change: Change): string {
  const state = evaluateState(change);
  return `Tasks: ${state.execution.completed}/${state.execution.total} completed${state.execution.inProgress ? `, ${state.execution.inProgress} in progress` : ''}. Planning: ${state.planning.status}; verification: ${state.verification.status}; local closure: ${state.localClosure.status}; remote delivery: ${state.remoteDelivery.status}. Completion does not imply verification or delivery.`;
}
export function instructions(change: Change, action: WorkflowAction = 'resume'): string {
  const state = evaluateState(change);
  const guidance: Record<WorkflowAction, string> = {
    plan: 'Clarify intent and measurable outcome, complete requirements and checks, add requirement-linked acceptance scenarios and substantive design decisions where required, then validate readiness.',
    revise: 'Revise only the blocked or outdated planning material and declared artifacts. Preserve completed and in-progress task statuses; re-evaluate readiness after edits.',
    implement: `Implement only dependency-eligible tasks (${state.eligibleTasks.join(', ') || 'none'}). Start a task only after every dependency is completed; record progress without changing unrelated statuses.`,
    verify: `Run the declared checks and record outcomes. Current verification needed: ${state.verification.missing.join(', ') || 'none'}; resolve failed or stale evidence before closure.`,
    resume: `Continue from current progress. Eligible tasks: ${state.eligibleTasks.join(', ') || 'none'}. Inspect blockers and verification before deciding the next action.`,
  };
  return `# Instructions: ${change.name} (${action})\n\n${guidance[action]}\n\n${deriveState(change)}\n\nEngine-enforced facts are derived from declared metadata and supplied evidence; design quality and other agent judgments are not asserted as facts. Never run user commands automatically.\n`;
}

async function lock(file: string): Promise<() => Promise<void>> {
  const lockfile = `${file}.lock`;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await writeFile(lockfile, `${process.pid}\n`, { flag: 'wx' }); return async () => { await rm(lockfile, { force: true }); }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await new Promise(r => setTimeout(r, 25)); }
  }
  throw new Error('Timed out acquiring task state lock.');
}

export async function transitionTask(file: string, taskId: string, status: TaskStatus, expectedRevision: number): Promise<Change> {
  const release = await lock(file);
  try {
    const current = parseChange(await readFile(file, 'utf8'));
    const revision = current.revision ?? 0;
    if (revision !== expectedRevision) throw new WorkflowError('revision_conflict', `Revision conflict: expected ${expectedRevision}, found ${revision}.`, 'Reload the change status and retry the transition with its current revision.');
    const task = current.tasks.find(t => t.id === taskId);
    if (!task) throw new WorkflowError('task_not_found', `Unknown task: ${taskId}`, 'Choose a task ID listed in the change status.');
    if ((status === 'in_progress' || status === 'completed') && task.dependencies.some(id => current.tasks.find(t => t.id === id)?.status !== 'completed')) throw new WorkflowError('dependencies_incomplete', 'Task dependencies must be completed first.', 'Complete the task dependencies, reload status, then retry.');
    task.status = status;
    const next = { ...current, revision: revision + 1 };
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    await rename(temp, file);
    return next;
  } finally { await release(); }
}
