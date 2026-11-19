import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseAcceptanceScenario,
  parseChange,
  parseRequirement,
  readiness,
  WorkflowError,
  type AcceptanceScenario,
  type Change,
  type Requirement,
} from './index.js';
import { evaluateEvidenceFreshness, readEvidence } from './evidence.js';

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

export interface CapabilityPreview {
  baselineName: string;
  baselineRevision: number;
  delta: Change['capabilityDelta'];
  additions: Requirement[];
  updates: Requirement[];
  removals: string[];
  preservedRequirementIds: string[];
  preservedScenarioIds: string[];
  mergedRequirements: CapabilityEntry<Requirement>[];
  mergedScenarios: CapabilityEntry<AcceptanceScenario>[];
  blockers: Array<{ code: string; message: string }>;
}

export type CloseInterruptionPoint = 'journal-prepared' | 'baseline-written' | 'change-archived';
export interface CloseOptions {
  expectedBaselineRevision: number;
  injectInterruption?: (point: CloseInterruptionPoint) => void | Promise<void>;
}

interface CloseJournal {
  schemaVersion: 1;
  operationId: string;
  changeId: string;
  baselineName: string;
  expectedBaselineRevision: number;
  expectedBaselineHash: string;
  nextBaseline: CapabilityBaseline;
  phase: 'prepared' | 'baseline-written' | 'change-archived' | 'complete';
}

const workspaceDir = (root: string) => path.join(path.resolve(root), '.notchlet');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateChangeId(id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new WorkflowError('invalid_change_id', `Invalid change ID: ${id}`, 'Use a change ID returned by `notchlet change list`.');
  }
  return id;
}

function capabilityName(name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new WorkflowError('invalid_capability_name', 'Capability names must be lowercase kebab-case.', 'Choose a name such as `product-behavior`.');
  }
  return name;
}

function paths(root: string, id: string, name: string) {
  const base = workspaceDir(root);
  return {
    baseline: path.join(base, 'capabilities', `${capabilityName(name)}.yaml`),
    change: path.join(base, 'changes', id),
    archive: path.join(base, 'archive', id),
    journal: path.join(base, '.local', 'close', `${id}.json`),
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
  validateChangeId(id);
  const file = path.join(workspaceDir(root), 'changes', id, 'tasks.json');
  return parseChange(await readFile(file, 'utf8'));
}

async function assess(root: string, change: Change, artifactContents: Record<string, string> = {}): Promise<CapabilityPreview> {
  const name = capabilityName(change.capabilityName ?? change.id);
  const fileSet = paths(root, change.id, name);
  const baseline = await readBaseline(fileSet.baseline, name);
  const blockers: CapabilityPreview['blockers'] = [];
  const delta = change.capabilityDelta;

  if (change.baselineRevision === undefined) {
    blockers.push({ code: 'baseline_revision_missing', message: 'Capture the capability baseline revision in the change before closure.' });
  } else if (change.baselineRevision !== baseline.revision) {
    blockers.push({ code: 'baseline_revision_conflict', message: `Change records baseline revision ${change.baselineRevision}, but the current baseline is ${baseline.revision}.` });
  }
  if (change.mode === 'quick' && !(change.capabilityImpact === 'none' && change.capabilityRationale?.trim()) && !(change.capabilityImpact === 'delta' && delta?.operations.length)) {
    blockers.push({ code: 'capability_impact_required', message: 'Quick changes must declare capabilityImpact none with a rationale or provide an explicit capability delta.' });
  }
  if (change.capabilityImpact === 'none' && !change.capabilityRationale?.trim()) {
    blockers.push({ code: 'capability_rationale_required', message: 'A no-impact declaration requires a rationale.' });
  }
  if (change.capabilityImpact === 'delta' && !delta?.operations.length) {
    blockers.push({ code: 'capability_delta_required', message: 'Declare at least one explicit capability delta operation.' });
  }

  const baselineRequirements = new Map(baseline.requirements.map(entry => [entry.value.id, entry.value]));
  const additions: Requirement[] = [];
  const updates: Requirement[] = [];
  const removals: string[] = [];
  const touched = new Set<string>();
  for (const operation of delta?.operations ?? []) {
    if (touched.has(operation.requirementId)) {
      blockers.push({ code: 'duplicate_capability_operation', message: `Capability delta repeats requirement ${operation.requirementId}.` });
      continue;
    }
    touched.add(operation.requirementId);
    const existing = baselineRequirements.get(operation.requirementId);
    if (operation.operation === 'add') {
      if (existing || !operation.requirement || operation.requirement.id !== operation.requirementId) {
        blockers.push({ code: 'invalid_capability_add', message: `Add operation for ${operation.requirementId} must introduce a new matching requirement.` });
      } else additions.push(operation.requirement);
    } else if (operation.operation === 'update') {
      if (!existing || !operation.requirement || operation.requirement.id !== operation.requirementId) {
        blockers.push({ code: 'invalid_capability_update', message: `Update operation for ${operation.requirementId} requires an existing requirement and matching replacement.` });
      } else updates.push(operation.requirement);
    } else if (!existing) {
      blockers.push({ code: 'invalid_capability_remove', message: `Cannot remove unknown requirement ${operation.requirementId}.` });
    } else removals.push(operation.requirementId);

    if (operation.operation !== 'remove') {
      for (const scenario of operation.scenarios ?? []) {
        if (scenario.requirementId !== operation.requirementId) blockers.push({ code: 'scenario_requirement_mismatch', message: `Scenario ${scenario.id} does not belong to ${operation.requirementId}.` });
      }
    }
  }

  const changeRequirementIds = new Set(change.requirements.map(requirement => requirement.id));
  for (const requirement of change.requirements) {
    const baselineRequirement = baselineRequirements.get(requirement.id);
    const operation = delta?.operations.find(item => item.requirementId === requirement.id);
    if (!baselineRequirement && !touched.has(requirement.id)) {
      blockers.push({ code: 'undeclared_capability_delta', message: `Requirement ${requirement.id} is not in the baseline or explicit delta.` });
    } else if (baselineRequirement && JSON.stringify(baselineRequirement) !== JSON.stringify(requirement) && !operation) {
      blockers.push({ code: 'undeclared_capability_delta', message: `Requirement ${requirement.id} changed without an explicit capability delta.` });
    } else if (operation && operation.operation !== 'remove' && JSON.stringify(operation.requirement) !== JSON.stringify(requirement)) {
      blockers.push({ code: 'capability_delta_mismatch', message: `Requirement ${requirement.id} does not match its declared delta.` });
    }
  }
  for (const operation of delta?.operations ?? []) {
    if (operation.operation === 'remove' && changeRequirementIds.has(operation.requirementId)) {
      blockers.push({ code: 'capability_delta_mismatch', message: `Removed requirement ${operation.requirementId} is still present in the change requirements.` });
    }
  }

  const baselineScenarios = new Map(baseline.scenarios.map(entry => [entry.value.id, entry.value]));
  const changeScenarioIds = new Set(change.acceptanceScenarios.map(scenario => scenario.id));
  for (const scenario of change.acceptanceScenarios) {
    const baselineScenario = baselineScenarios.get(scenario.id);
    const operation = delta?.operations.find(item => item.requirementId === scenario.requirementId);
    if (!baselineScenario && !touched.has(scenario.requirementId)) {
      blockers.push({ code: 'undeclared_scenario_delta', message: `Scenario ${scenario.id} is not in the baseline or explicit delta.` });
    } else if (baselineScenario && JSON.stringify(baselineScenario) !== JSON.stringify(scenario) && !operation) {
      blockers.push({ code: 'undeclared_scenario_delta', message: `Scenario ${scenario.id} changed without an explicit capability delta.` });
    } else if (operation?.scenarios && !operation.scenarios.some(item => item.id === scenario.id && JSON.stringify(item) === JSON.stringify(scenario))) {
      blockers.push({ code: 'capability_delta_mismatch', message: `Scenario ${scenario.id} does not match its declared delta.` });
    }
  }
  for (const operation of delta?.operations ?? []) {
    for (const scenario of operation.scenarios ?? []) {
      if (!changeScenarioIds.has(scenario.id)) blockers.push({ code: 'capability_delta_mismatch', message: `Delta scenario ${scenario.id} is missing from change acceptance scenarios.` });
    }
  }

  const preservedRequirementIds = baseline.requirements.map(entry => entry.value.id).filter(id => !touched.has(id));
  const acceptedAt = 'pending-close';
  const mergedRequirements = new Map(baseline.requirements.map(entry => [entry.value.id, entry]));
  const mergedScenarios = new Map(baseline.scenarios.map(entry => [entry.value.id, entry]));
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
  const preservedScenarioIds = baseline.scenarios
    .filter(entry => !affectedScenarioRequirements.has(entry.value.requirementId))
    .map(entry => entry.value.id);

  if (!Object.keys(artifactContents).length) {
    for (const relative of Object.values(change.artifacts)) {
      try { artifactContents[relative] = await readFile(path.join(fileSet.change, relative), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const readinessResult = readiness(change, artifactContents);
  blockers.push(...readinessResult.blockers.map(issue => ({ code: `readiness_${issue.code}`, message: issue.message })));
  if (!change.tasks.length || change.tasks.some(task => task.status !== 'completed')) {
    blockers.push({ code: 'tasks_incomplete', message: 'All change tasks must be completed before local closure.' });
  }
  if (!change.checks.length) blockers.push({ code: 'acceptance_missing', message: 'At least one required acceptance check must be declared and current.' });

  const evidence = await readEvidence(root, change.id);
  for (const check of change.checks) {
    const matching = evidence.filter(record => record.kind === 'check' && record.outcome === 'passed' && record.checkIds?.includes(check.id) &&
      (!record.requirementIds.length || record.requirementIds.some(id => changeRequirementIds.has(id))));
    let current = false;
    for (const record of matching) {
      if ((await evaluateEvidenceFreshness(root, change.id, record)).status === 'fresh') { current = true; break; }
    }
    if (!current) blockers.push({ code: 'acceptance_not_current', message: `Required check ${check.id} has no current passed evidence explicitly linked to it.` });
  }

  return {
    baselineName: name,
    baselineRevision: baseline.revision,
    delta,
    additions,
    updates,
    removals,
    preservedRequirementIds,
    preservedScenarioIds,
    mergedRequirements: [...mergedRequirements.values()],
    mergedScenarios: [...mergedScenarios.values()],
    blockers,
  };
}

export async function previewCapabilityClose(root: string, changeId: string, artifactContents: Record<string, string> = {}): Promise<CapabilityPreview> {
  return assess(root, await readChange(root, changeId), artifactContents);
}

async function readJournal(file: string): Promise<CloseJournal | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as CloseJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function recoverUnlocked(root: string, changeId: string): Promise<{ recovered: boolean; archived: boolean; baselineRevision?: number }> {
  const journalPath = paths(root, changeId, changeId).journal;
  const journal = await readJournal(journalPath);
  if (!journal) return { recovered: false, archived: false };
  if (journal.schemaVersion !== 1 || journal.changeId !== changeId || typeof journal.baselineName !== 'string' ||
    !['prepared', 'baseline-written', 'change-archived', 'complete'].includes(journal.phase) ||
    !Number.isInteger(journal.expectedBaselineRevision) || typeof journal.expectedBaselineHash !== 'string' ||
    !journal.nextBaseline || journal.nextBaseline.schemaVersion !== 1 || journal.nextBaseline.name !== journal.baselineName ||
    journal.nextBaseline.revision !== journal.expectedBaselineRevision + 1 || !Array.isArray(journal.nextBaseline.requirements) || !Array.isArray(journal.nextBaseline.scenarios)) {
    throw new WorkflowError('invalid_close_journal', 'Close journal is invalid.', 'Inspect the journal before retrying closure.');
  }

  const fileSet = paths(root, changeId, journal.baselineName);
  if (journal.phase === 'prepared') {
    const current = await readBaseline(fileSet.baseline, journal.baselineName);
    if (current.revision === journal.expectedBaselineRevision && hash(current) === journal.expectedBaselineHash) {
      await atomicJson(fileSet.baseline, journal.nextBaseline);
    } else if (current.revision !== journal.nextBaseline.revision || hash(current) !== hash(journal.nextBaseline)) {
      throw new WorkflowError('baseline_revision_conflict', 'Capability baseline changed while close recovery was pending.', 'Reconcile the baseline and change before retrying close.');
    }
    journal.phase = 'baseline-written';
    await atomicJson(fileSet.journal, journal);
  }
  if (journal.phase === 'baseline-written') {
    await mkdir(path.dirname(fileSet.archive), { recursive: true });
    try { await rename(fileSet.change, fileSet.archive); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await stat(fileSet.archive); } catch { throw error; }
    }
    journal.phase = 'change-archived';
    await atomicJson(fileSet.journal, journal);
  }
  if (journal.phase === 'change-archived') {
    journal.phase = 'complete';
    await atomicJson(fileSet.journal, journal);
  }
  return { recovered: true, archived: true, baselineRevision: journal.nextBaseline.revision };
}

export async function recoverCapabilityClose(root: string, changeId: string): Promise<{ recovered: boolean; archived: boolean; baselineRevision?: number }> {
  validateChangeId(changeId);
  const journalPath = paths(root, changeId, changeId).journal;
  const journal = await readJournal(journalPath);
  if (!journal) return { recovered: false, archived: false };
  const fileSet = paths(root, changeId, journal.baselineName);
  const release = await acquireLock(fileSet.lock);
  try { return await recoverUnlocked(root, changeId); }
  finally { await release(); }
}

export async function closeChange(root: string, changeId: string, options: CloseOptions): Promise<{ archived: true; baselineRevision: number; preview: CapabilityPreview }> {
  validateChangeId(changeId);
  const journalPath = paths(root, changeId, changeId).journal;
  const journal = await readJournal(journalPath);
  const existing = journal ? null : await readChange(root, changeId);
  const baselineName = journal?.baselineName ?? existing?.capabilityName ?? changeId;
  const fileSet = paths(root, changeId, baselineName);
  const release = await acquireLock(fileSet.lock);
  try {
    const recovery = await recoverUnlocked(root, changeId);
    if (recovery.archived) {
      const preview = await previewCapabilityClose(root, changeId).catch(() => ({
        baselineName,
        baselineRevision: recovery.baselineRevision!,
        delta: undefined,
        blockers: [],
        preservedRequirementIds: [],
        preservedScenarioIds: [],
        mergedRequirements: [],
        mergedScenarios: [],
        additions: [],
        updates: [],
        removals: [],
      }));
      return { archived: true, baselineRevision: recovery.baselineRevision!, preview };
    }

    const change = await readChange(root, changeId);
    const baseline = await readBaseline(fileSet.baseline, change.capabilityName ?? changeId);
    const preview = await assess(root, change);
    if (baseline.revision !== options.expectedBaselineRevision || change.baselineRevision !== baseline.revision) {
      throw new WorkflowError('baseline_revision_conflict', `Capability baseline revision changed: expected ${options.expectedBaselineRevision}, found ${baseline.revision}.`, 'Reload the baseline and change, review the capability delta, and preview closure again.');
    }
    if (preview.blockers.length) {
      throw new WorkflowError('closure_blocked', `Local closure is blocked: ${preview.blockers.map(blocker => blocker.code).join(', ')}.`, 'Resolve the listed acceptance and capability blockers, then run close --preview again.');
    }

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
      name: change.capabilityName ?? changeId,
      revision,
      requirements: [...requirements.values()],
      scenarios: [...scenarios.values()],
    };
    const closeJournal: CloseJournal = {
      schemaVersion: 1,
      operationId: randomUUID(),
      changeId,
      baselineName: nextBaseline.name,
      expectedBaselineRevision: baseline.revision,
      expectedBaselineHash: hash(baseline),
      nextBaseline,
      phase: 'prepared',
    };
    await atomicJson(fileSet.journal, closeJournal);
    await options.injectInterruption?.('journal-prepared');
    await atomicJson(fileSet.baseline, nextBaseline);
    closeJournal.phase = 'baseline-written';
    await atomicJson(fileSet.journal, closeJournal);
    await options.injectInterruption?.('baseline-written');
    await mkdir(path.dirname(fileSet.archive), { recursive: true });
    await rename(fileSet.change, fileSet.archive);
    closeJournal.phase = 'change-archived';
    await atomicJson(fileSet.journal, closeJournal);
    await options.injectInterruption?.('change-archived');
    closeJournal.phase = 'complete';
    await atomicJson(fileSet.journal, closeJournal);
    return { archived: true, baselineRevision: revision, preview };
  } finally {
    await release();
  }
}
