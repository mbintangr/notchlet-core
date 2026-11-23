import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectGitContext, type GitContextResult } from './git-context.js';
import { fingerprintWorkspace, type WorkspaceFingerprint } from './source-files.js';
import { parseChange, WorkflowError, type Change } from './index.js';
import { resolveChangeLocation } from './paths.js';

export type EvidenceKind = 'check' | 'note' | 'artifact';
export type EvidenceOutcome = 'passed' | 'failed' | 'informational';
export type EvidenceProvenance = 'recorded' | 'imported' | 'locally-observed';
export type EvidenceAttachmentKind = 'screenshot' | 'dom' | 'text' | 'json' | 'other';
export interface EvidenceAttachment {
  name: string;
  /** Path relative to the change directory. */
  path: string;
  sha256: string;
  bytes: number;
  mediaType?: string;
  kind?: EvidenceAttachmentKind;
  description?: string;
  /** How the asset was produced; browser captures record the URL and browser used. */
  provenance?: { tool: 'browser-capture'; url: string; browser: string; capturedAt: string };
}
export interface SetupPreflightEnvironment {
  status: 'passed' | 'failed';
  /** Workspace-relative file or directory paths that setup must reproduce. */
  statePaths: string[];
  added: string[];
  removed: string[];
  changed: string[];
  firstExitCode: number | null;
  secondExitCode: number | null;
  durationMs: number;
  /** Setup-specific remediation when the preflight failed. */
  recovery?: string;
  /** Operational note, such as the state left behind by the second setup run. */
  note?: string;
}
export interface EvidenceEnvironment {
  platform: string;
  nodeVersion: string;
  cwd: string;
  /** Environment variables declared by the change for deterministic runs. */
  environment?: Record<string, string>;
  setupCommand?: string;
  teardownCommand?: string;
  /** Result of running setup twice and comparing declared state paths. */
  setupPreflight?: SetupPreflightEnvironment;
  /** Ambient variables withheld from command checks because verify owned the served process. */
  commandIsolation?: string[];
}
export interface EvidenceCapture {
  url: string;
  browser: string;
  capturedAt: string;
  viewport?: { width: number; height: number };
  title?: string;
  fullPage?: boolean;
  wait?: { settleMs: number; waitFor?: string; waitedMs: number; matched: boolean };
  console?: { messages: Array<{ type: string; text: string }>; errors: string[] };
}
export interface EvidenceRecord {
  schemaVersion: 1; id: string; kind: EvidenceKind; outcome: EvidenceOutcome; summary: string;
  command?: string; requirementIds: string[]; scenarioIds?: string[]; taskIds: string[]; checkIds?: string[]; capturedAt: string; provenance: EvidenceProvenance;
  changeRevision: number; contentRevision?: number; artifactHash: string; /** Version 2 content fingerprint that ignores derived Markdown views. */ verificationFingerprint?: string; fingerprintVersion?: 2; git: GitContextResult;
  /** Bounded source-content fingerprint for workspaces without Git. */
  source?: WorkspaceFingerprint;
  environment?: EvidenceEnvironment;
  capture?: EvidenceCapture;
  logPath?: string; logHash?: string; logBytes?: number; attachments?: EvidenceAttachment[];
}
export type EvidenceWriteInput = Omit<EvidenceRecord, 'schemaVersion'|'id'|'capturedAt'|'changeRevision'|'contentRevision'|'artifactHash'|'git'|'source'|'provenance'> & { provenance: 'recorded' | 'imported'; id?: string; capturedAt?: string };
export interface EvidenceAttachmentInput { path: string; name?: string; kind?: EvidenceAttachmentKind; description?: string; provenance?: EvidenceAttachment['provenance']; }
export interface EvidenceFreshness { status: 'fresh' | 'stale' | 'unknown'; basis: 'git' | 'artifact'; /** Whether the recorded evidence binds application source, not only change artifacts. */ sourceBound?: boolean; reasons: string[]; independentlyVerified: boolean; }
export interface SourceBindingSummary {
  basis: 'git' | 'artifact' | 'mixed' | 'none';
  /** True when every current check observes source through Git or a workspace fingerprint. */
  bound: boolean;
  currentChecks: number;
  gitChecks: number;
  workspaceChecks: number;
  unboundChecks: number;
}
export type CheckFacetStatus = 'missing' | 'failed' | 'stale' | 'unknown' | 'current';
export interface CheckFacet { checkId: string; status: CheckFacetStatus; evidenceId?: string; freshness?: EvidenceFreshness; }
export interface VerificationFacets {
  missing: string[]; failed: string[]; stale: string[]; unknown: string[]; current: string[];
  independentlyVerified: boolean;
  checks: CheckFacet[];
  records: EvidenceRecord[];
}
export interface EvidenceScopeInput { requirementIds?: string[]; scenarioIds?: string[]; taskIds?: string[]; }
export interface EvidenceScope { checkIds: string[]; requirementIds: string[]; scenarioIds?: string[]; taskIds: string[]; }
export interface EvidenceFilter { checkId?: string; requirementId?: string; taskId?: string; stale?: boolean; failed?: boolean; }
export interface EvidenceListing { record: EvidenceRecord; freshness: EvidenceFreshness; recovery?: string; }
export interface TaskEvidenceStatus {
  taskId: string;
  status: 'current' | 'stale' | 'unknown' | 'failed' | 'missing';
  evidenceId?: string;
  freshness?: EvidenceFreshness;
  checkIds: string[];
  recovery: string;
}

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
async function changeDir(root: string, id: string): Promise<string> {
  try { return (await resolveChangeLocation(root, id, { scope: 'active' })).directory; }
  catch (error) {
    if (error instanceof WorkflowError && (error.code === 'invalid_change_path' || error.code === 'path_budget_exceeded')) throw new Error(`Invalid change ID: ${id}`);
    throw error;
  }
}
async function readableChangeDir(root: string, id: string): Promise<string> {
  return (await resolveChangeLocation(root, id, { scope: 'merged' })).directory;
}
const DERIVED_VIEWS = new Set(['tasks.json', 'tasks.md', 'proposal.json', 'proposal.md', 'spec.json', 'spec.md']);
function changeContent(change: Change): unknown {
  return {
    schemaVersion: change.schemaVersion, id: change.id, name: change.name, mode: change.mode,
    intent: change.intent, outcome: change.outcome, requirements: change.requirements,
    acceptanceScenarios: change.acceptanceScenarios, designDecisions: change.designDecisions,
    checks: change.checks, tasks: change.tasks.map(({ status: _status, ...task }) => task),
    artifacts: change.artifacts, baselineRevision: change.baselineRevision,
    capabilityName: change.capabilityName, capabilityImpact: change.capabilityImpact,
    capabilityRationale: change.capabilityRationale, capabilityDelta: change.capabilityDelta,
    workingDirectory: change.workingDirectory, readyTimeoutMs: change.readyTimeoutMs, readyIntervalMs: change.readyIntervalMs,
    environment: change.environment, setupCommand: change.setupCommand, teardownCommand: change.teardownCommand, coveragePolicy: change.coveragePolicy,
  };
}
/**
 * Version 2 evidence fingerprint computed from artifact contents instead of the filesystem,
 * so remote evaluators (the delivery service) can verify freshness against a sync package.
 */
export function evidenceFingerprint(change: Change, contents: Record<string, string | undefined>): string {
  const entries: Array<[string, string]> = [];
  for (const relative of Object.values(change.artifacts).sort()) {
    if (DERIVED_VIEWS.has(relative)) continue;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Invalid artifact path: ${relative}`);
    const content = contents[relative];
    entries.push([relative, content === undefined ? 'missing' : hash(content)]);
  }
  return hash(JSON.stringify({ content: changeContent(change), entries }));
}

async function artifactHash(dir: string, change: Change, version: 1 | 2 = 2): Promise<string> {
  if (version === 2) {
    const contents: Record<string, string | undefined> = {};
    for (const relative of Object.values(change.artifacts)) {
      if (DERIVED_VIEWS.has(relative)) continue;
      try { contents[relative] = await readFile(path.join(dir, relative), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return evidenceFingerprint(change, contents);
  }
  const entries: Array<[string, string]> = [];
  for (const relative of Object.values(change.artifacts).sort()) {
    // State and progress-derived or rendered views are excluded: the model content below carries
    // authored content, so task progress and re-rendering must not invalidate evidence.
    if (relative === 'tasks.md') continue;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Invalid artifact path: ${relative}`);
    try { entries.push([relative, hash(await readFile(path.join(dir, relative)))]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries.push([relative, 'missing']); }
  }
  return hash(JSON.stringify({ content: changeContent(change), entries }));
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function acquire(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.lock`;
  let lastError: NodeJS.ErrnoException | undefined;
  let epermRetries = 0;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await writeFile(lock, `${process.pid}\n`, { flag: 'wx' }); return () => rm(lock, { force: true }); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw e;
      lastError = e as NodeJS.ErrnoException;
      if (code === 'EEXIST') epermRetries = 0;
      // Windows reports EPERM when a concurrently released lock is still delete-pending;
      // retry with bounded backoff so transient hand-offs recover but persistent denial fails.
      else if (++epermRetries > 30) throw e;
      await sleep(code === 'EPERM' ? Math.min(4 * 2 ** Math.min(epermRetries, 4), 40) : 10);
    }
  }
  throw lastError ?? new Error('Timed out acquiring evidence store lock.');
}

function validAttachmentProvenance(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const provenance = value as Record<string, unknown>;
  return provenance.tool === 'browser-capture' && typeof provenance.url === 'string' && typeof provenance.browser === 'string' && typeof provenance.capturedAt === 'string' && Number.isFinite(Date.parse(provenance.capturedAt));
}
function validAttachment(value: unknown): value is EvidenceAttachment {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Record<string, unknown>;
  return typeof attachment.name === 'string' && Boolean(attachment.name)
    && typeof attachment.path === 'string' && Boolean(attachment.path) && !path.isAbsolute(attachment.path) && !attachment.path.split(/[\\/]/).includes('..')
    && typeof attachment.sha256 === 'string' && /^[a-f0-9]{64}$/.test(attachment.sha256)
    && Number.isInteger(attachment.bytes) && (attachment.bytes as number) >= 0
    && (attachment.mediaType === undefined || typeof attachment.mediaType === 'string')
    && (attachment.kind === undefined || ['screenshot', 'dom', 'text', 'json', 'other'].includes(String(attachment.kind)))
    && (attachment.description === undefined || typeof attachment.description === 'string')
    && (attachment.provenance === undefined || validAttachmentProvenance(attachment.provenance));
}
function validSetupPreflight(value: unknown): value is SetupPreflightEnvironment {
  if (!value || typeof value !== 'object') return false;
  const preflight = value as Record<string, unknown>;
  const stringList = (item: unknown) => Array.isArray(item) && item.every(entry => typeof entry === 'string');
  const exitCode = (item: unknown) => item === null || (Number.isInteger(item) && (item as number) >= 0);
  return (preflight.status === 'passed' || preflight.status === 'failed')
    && stringList(preflight.statePaths) && stringList(preflight.added) && stringList(preflight.removed) && stringList(preflight.changed)
    && exitCode(preflight.firstExitCode) && exitCode(preflight.secondExitCode)
    && Number.isInteger(preflight.durationMs) && (preflight.durationMs as number) >= 0
    && (preflight.recovery === undefined || typeof preflight.recovery === 'string')
    && (preflight.note === undefined || typeof preflight.note === 'string');
}
function validEnvironment(value: unknown): value is EvidenceEnvironment {
  if (!value || typeof value !== 'object') return false;
  const environment = value as Record<string, unknown>;
  return typeof environment.platform === 'string' && typeof environment.nodeVersion === 'string' && typeof environment.cwd === 'string'
    && (environment.environment === undefined || (environment.environment !== null && typeof environment.environment === 'object' && Object.values(environment.environment as Record<string, unknown>).every(item => typeof item === 'string')))
    && (environment.setupCommand === undefined || typeof environment.setupCommand === 'string')
    && (environment.teardownCommand === undefined || typeof environment.teardownCommand === 'string')
    && (environment.setupPreflight === undefined || validSetupPreflight(environment.setupPreflight))
    && (environment.commandIsolation === undefined || (Array.isArray(environment.commandIsolation) && environment.commandIsolation.every(item => typeof item === 'string')));
}
function validCapture(value: unknown): value is EvidenceCapture {
  if (!value || typeof value !== 'object') return false;
  const capture = value as Record<string, unknown>;
  return typeof capture.url === 'string' && Boolean(capture.url) && typeof capture.browser === 'string' && Boolean(capture.browser) && typeof capture.capturedAt === 'string' && Number.isFinite(Date.parse(capture.capturedAt))
    && (capture.title === undefined || typeof capture.title === 'string')
    && (capture.viewport === undefined || (typeof capture.viewport === 'object' && capture.viewport !== null && Number.isInteger((capture.viewport as Record<string, unknown>).width) && Number.isInteger((capture.viewport as Record<string, unknown>).height)));
}
function validWorkspaceFingerprint(value: unknown): value is WorkspaceFingerprint {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return source.algorithm === 'sha256' && typeof source.digest === 'string' && /^[a-f0-9]{64}$/.test(source.digest)
    && Number.isInteger(source.files) && (source.files as number) >= 0
    && Number.isInteger(source.bytesHashed) && (source.bytesHashed as number) >= 0
    && typeof source.truncated === 'boolean';
}
export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  if (!value || typeof value !== 'object') throw new Error('Evidence record must be an object.');
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== 1 || typeof r.id !== 'string' || !r.id || !['check','note','artifact'].includes(String(r.kind)) || !['passed','failed','informational'].includes(String(r.outcome)) || typeof r.summary !== 'string' || !r.summary.trim() || !Array.isArray(r.requirementIds) || !r.requirementIds.every(x => typeof x === 'string') || (r.scenarioIds !== undefined && (!Array.isArray(r.scenarioIds) || !r.scenarioIds.every(x => typeof x === 'string' && x.length > 0) || new Set(r.scenarioIds).size !== r.scenarioIds.length)) || !Array.isArray(r.taskIds) || !r.taskIds.every(x => typeof x === 'string') || (r.checkIds !== undefined && (!Array.isArray(r.checkIds) || !r.checkIds.every(x => typeof x === 'string' && x.length > 0) || new Set(r.checkIds).size !== r.checkIds.length)) || typeof r.capturedAt !== 'string' || !Number.isFinite(Date.parse(r.capturedAt)) || !['recorded','imported','locally-observed'].includes(String(r.provenance)) || !Number.isInteger(r.changeRevision) || (r.contentRevision !== undefined && (!Number.isInteger(r.contentRevision) || (r.contentRevision as number) < 0)) || typeof r.artifactHash !== 'string' || (r.verificationFingerprint !== undefined && (typeof r.verificationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.verificationFingerprint))) || (r.fingerprintVersion !== undefined && r.fingerprintVersion !== 2) || (r.source !== undefined && !validWorkspaceFingerprint(r.source)) || !r.git || typeof r.git !== 'object' || (r.environment !== undefined && !validEnvironment(r.environment)) || (r.capture !== undefined && !validCapture(r.capture)) || (r.command !== undefined && typeof r.command !== 'string') || (r.logPath !== undefined && (typeof r.logPath !== 'string' || !r.logPath.trim())) || (r.logHash !== undefined && (typeof r.logHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.logHash))) || (r.logBytes !== undefined && (!Number.isInteger(r.logBytes) || (r.logBytes as number) < 0)) || ((r.logPath === undefined) !== (r.logHash === undefined)) || (r.attachments !== undefined && (!Array.isArray(r.attachments) || !r.attachments.every(validAttachment)))) throw new Error('Invalid evidence record schema.');
  return r as unknown as EvidenceRecord;
}

export async function readEvidence(root: string, id: string): Promise<EvidenceRecord[]> {
  const dir = await readableChangeDir(root, id);
  const file = path.join(dir, 'evidence.jsonl');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const change = parseChange(await readFile(path.join(dir, 'tasks.json'), 'utf8'));
  const checkIds = new Set(change.checks.map(check => check.id));
  const scenarioIds = new Set(change.acceptanceScenarios.map(scenario => scenario.id));
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const record = parseEvidenceRecord(JSON.parse(line));
    if (record.checkIds?.some(checkId => !checkIds.has(checkId))) throw new Error('Evidence references an unknown check ID.');
    if (record.scenarioIds?.some(scenarioId => !scenarioIds.has(scenarioId))) throw new Error('Evidence references an unknown acceptance scenario ID.');
    return record;
  });
}

/** Appends user-supplied evidence; command is descriptive only and is never run. */
export async function appendEvidence(root: string, changeId: string, input: EvidenceWriteInput): Promise<EvidenceRecord> {
  const dir = await changeDir(root, changeId); const change = parseChange(await readFile(path.join(dir, 'tasks.json'), 'utf8'));
  const reqs = new Set(change.requirements.map(x => x.id)), tasks = new Set(change.tasks.map(x => x.id));
  if (input.requirementIds.some(x => !reqs.has(x))) throw new Error('Evidence references an unknown requirement ID.');
  const scenarios = new Set(change.acceptanceScenarios.map(x => x.id));
  if (input.scenarioIds?.some(x => !scenarios.has(x))) throw new Error('Evidence references an unknown acceptance scenario ID.');
  if (input.taskIds.some(x => !tasks.has(x))) throw new Error('Evidence references an unknown task ID.');
  const checks = new Set(change.checks.map(x => x.id));
  if (input.checkIds?.some(x => !checks.has(x))) throw new Error('Evidence references an unknown check ID.');
  if (input.provenance !== 'recorded' && input.provenance !== 'imported') throw new Error('Evidence ingestion accepts only recorded or imported provenance.');
  const file = path.join(dir, 'evidence.jsonl'); await mkdir(dir, { recursive: true }); const release = await acquire(file);
  try {
    const fingerprint = await artifactHash(dir, change);
    const existing = await readEvidence(root, changeId);
    const git = await inspectGitContext(root);
    const source = git.isRepository ? undefined : await fingerprintWorkspace(root);
    // Parsing verifies that every attachment path stays inside the change directory.
    const record = parseEvidenceRecord({ ...input, schemaVersion: 1, id: input.id ?? randomUUID(), capturedAt: input.capturedAt ?? new Date().toISOString(), changeRevision: change.revision ?? 0, ...(change.contentRevision === undefined ? {} : { contentRevision: change.contentRevision }), artifactHash: fingerprint, verificationFingerprint: fingerprint, fingerprintVersion: 2, git, ...(source === undefined ? {} : { source }) });
    if (existing.some(item => item.id === record.id)) throw new Error(`Evidence ID already exists: ${record.id}`);
    // Rewrite under lock with atomic replacement to avoid partial concurrent appends.
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, [...existing, record].map(item => JSON.stringify(item)).join('\n') + '\n', { flag: 'wx' });
    await rename(temp, file); return record;
  } finally { await release(); }
}

const ATTACHMENT_LIMIT_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_TOTAL_LIMIT_BYTES = 32 * 1024 * 1024;
function mediaTypeFor(name: string): string | undefined {
  const extension = path.extname(name).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.log': 'text/plain' } as Record<string, string>)[extension];
}
function defaultAttachmentKind(mediaType: string | undefined): EvidenceAttachmentKind {
  if (mediaType?.startsWith('image/')) return 'screenshot';
  if (mediaType === 'application/json') return 'json';
  if (mediaType === 'text/html') return 'dom';
  if (mediaType?.startsWith('text/')) return 'text';
  return 'other';
}
/** Copy evidence assets into the change directory so they travel with archive and sync. */
export async function stageEvidenceAttachments(root: string, changeId: string, evidenceId: string, inputs: EvidenceAttachmentInput[]): Promise<EvidenceAttachment[]> {
  if (!/^[a-zA-Z0-9-]+$/.test(evidenceId)) throw new WorkflowError('invalid_evidence_id', `Invalid evidence ID: ${evidenceId}`, 'Use an alphanumeric or hyphenated evidence ID.');
  if (!inputs.length) return [];
  const directory = path.join(await changeDir(root, changeId), 'evidence', evidenceId);
  await mkdir(directory, { recursive: true });
  const staged: EvidenceAttachment[] = [];
  let total = 0;
  const used = new Set<string>();
  for (const input of inputs) {
    const source = path.resolve(input.path);
    const info = await stat(source).catch(() => undefined);
    if (!info?.isFile()) throw new WorkflowError('attachment_not_found', `Attachment file not found: ${input.path}`, 'Provide a readable file path for --attach.');
    if (info.size > ATTACHMENT_LIMIT_BYTES) throw new WorkflowError('attachment_too_large', `Attachment ${input.path} exceeds ${ATTACHMENT_LIMIT_BYTES} bytes.`, 'Attach a smaller file or record a summary instead.');
    total += info.size;
    if (total > ATTACHMENT_TOTAL_LIMIT_BYTES) throw new WorkflowError('attachment_total_too_large', `Attachments exceed ${ATTACHMENT_TOTAL_LIMIT_BYTES} bytes in total.`, 'Attach fewer or smaller files.');
    const original = path.basename(input.name ?? source);
    const safe = original.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'attachment';
    let name = safe;
    for (let index = 2; used.has(name); index++) name = `${path.basename(safe, path.extname(safe))}-${index}${path.extname(safe)}`;
    used.add(name);
    const destination = path.join(directory, name);
    await copyFile(source, destination);
    const bytes = await readFile(destination);
    const mediaType = mediaTypeFor(name);
    staged.push({
      name,
      path: ['evidence', evidenceId, name].join('/'),
      sha256: hash(bytes),
      bytes: bytes.byteLength,
      ...(mediaType === undefined ? {} : { mediaType }),
      kind: input.kind ?? defaultAttachmentKind(mediaType),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    });
  }
  return staged;
}

/** Resolve a change-relative evidence asset for active or archived changes. */
export async function evidenceAssetPath(root: string, changeId: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new WorkflowError('invalid_artifact_path', `Invalid evidence asset path: ${relative}`, 'Evidence assets must stay inside the change directory.');
  return path.join(await readableChangeDir(root, changeId), relative);
}

/** Move verification logs referenced outside the change into archive-local evidence storage. */
export async function archiveEvidenceArtifacts(root: string, changeId: string): Promise<{ records: number; relocated: string[]; missing: string[] }> {
  const directory = await changeDir(root, changeId);
  const file = path.join(directory, 'evidence.jsonl');
  let records: EvidenceRecord[];
  try { records = await readEvidence(root, changeId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: 0, relocated: [], missing: [] }; throw error; }
  const relocated: string[] = [], missing: string[] = [];
  let changed = false;
  for (const record of records) {
    if (!record.logPath || record.logPath.startsWith('evidence/')) continue;
    const source = path.resolve(root, record.logPath);
    const info = await stat(source).catch(() => undefined);
    if (!info?.isFile()) { missing.push(record.logPath); continue; }
    const name = `${record.id.slice(0, 8)}-${path.basename(record.logPath)}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const relative = ['evidence', 'logs', name].join('/');
    await mkdir(path.join(directory, 'evidence', 'logs'), { recursive: true });
    await copyFile(source, path.join(directory, relative));
    record.logPath = relative;
    relocated.push(relative);
    changed = true;
  }
  if (changed) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, records.map(record => JSON.stringify(record)).join('\n') + '\n', { flag: 'wx' });
    await rename(temporary, file);
  }
  return { records: records.length, relocated, missing };
}

export async function evaluateEvidenceFreshness(root: string, changeId: string, evidence: EvidenceRecord): Promise<EvidenceFreshness> {
  const reasons: string[] = [];
  const dir = await readableChangeDir(root, changeId); const change = parseChange(await readFile(path.join(dir, 'tasks.json'), 'utf8'));
  if (evidence.fingerprintVersion === 2) {
    // Fingerprints bind authored model content and non-derived artifacts. Task progress, render
    // revisions, and contentRevision bookkeeping must not produce a false stale result.
    if (await artifactHash(dir, change, 2) !== evidence.verificationFingerprint) reasons.push('Relevant change content or artifacts changed.');
  } else {
    if (await artifactHash(dir, change, 1) !== evidence.artifactHash) reasons.push('Relevant change content or artifacts changed.');
    if (change.contentRevision !== undefined && evidence.contentRevision !== undefined && change.contentRevision !== evidence.contentRevision) reasons.push('Relevant change content revision changed.');
  }
  const current = await inspectGitContext(root);
  if (!current.isRepository) {
    if (!evidence.source) {
      reasons.push('Recorded source fingerprint is unavailable (legacy evidence); freshness covers change artifacts only, so application source is unbound.');
      return { status: reasons.length > 1 ? 'stale' : 'fresh', basis: 'artifact', sourceBound: false, reasons, independentlyVerified: false };
    }
    const unknownReasons: string[] = [];
    if (evidence.source.truncated) {
      unknownReasons.push('Recorded workspace source fingerprint was truncated; source observation is incomplete.');
    } else {
      const source = await fingerprintWorkspace(root);
      if (source.truncated) unknownReasons.push('Workspace source fingerprint is truncated; source observation is incomplete.');
      else if (source.digest !== evidence.source.digest) reasons.push('Workspace source fingerprint changed.');
    }
    return { status: reasons.length ? 'stale' : unknownReasons.length ? 'unknown' : 'fresh', basis: 'artifact', sourceBound: true, reasons: [...reasons, ...unknownReasons], independentlyVerified: false };
  }
  const unknownReasons: string[] = [];
  if (!evidence.git.isRepository) unknownReasons.push('Recorded Git observation is unavailable.');
  else if (current.tracked.truncated || current.untracked.truncated || evidence.git.tracked.truncated || evidence.git.untracked.truncated) unknownReasons.push('Git fingerprint was truncated; source observation is incomplete.');
  else if (current.repository.head !== evidence.git.repository.head || current.tracked.digest !== evidence.git.tracked.digest || current.untracked.digest !== evidence.git.untracked.digest) reasons.push('Git worktree or HEAD changed.');
  return { status: reasons.length ? 'stale' : unknownReasons.length ? 'unknown' : 'fresh', basis: 'git', sourceBound: true, reasons: [...reasons, ...unknownReasons], independentlyVerified: false };
}

/** Classify every declared check with one freshness policy shared by state, evidence output, and closure. */
export async function evaluateVerificationFacets(root: string, changeId: string, change: Change): Promise<VerificationFacets> {
  let records: EvidenceRecord[] = [];
  try { records = await readEvidence(root, changeId); }
  catch {
    return { missing: change.checks.map(check => check.id), failed: [], stale: [], unknown: [], current: [], independentlyVerified: false, checks: change.checks.map(check => ({ checkId: check.id, status: 'missing' as const })), records };
  }
  const latest = new Map<string, EvidenceRecord>();
  for (const record of records) {
    for (const checkId of record.checkIds ?? []) {
      const previous = latest.get(checkId);
      if (!previous || Date.parse(record.capturedAt) >= Date.parse(previous.capturedAt)) latest.set(checkId, record);
    }
  }
  const facets: CheckFacet[] = [];
  for (const check of change.checks) {
    const record = latest.get(check.id);
    if (!record) { facets.push({ checkId: check.id, status: 'missing' }); continue; }
    const freshness = await evaluateEvidenceFreshness(root, changeId, record);
    const status: CheckFacetStatus = freshness.status === 'stale' ? 'stale'
      : record.outcome === 'failed' ? 'failed'
      : record.outcome === 'passed' ? freshness.status === 'unknown' ? 'unknown' : 'current'
      : 'missing';
    facets.push({ checkId: check.id, status, evidenceId: record.id, freshness });
  }
  const by = (status: CheckFacetStatus) => facets.filter(facet => facet.status === status).map(facet => facet.checkId);
  return { missing: by('missing'), failed: by('failed'), stale: by('stale'), unknown: by('unknown'), current: by('current'), independentlyVerified: false, checks: facets, records };
}

/** Summarize whether current evidence observes application source in addition to change artifacts. */
export function summarizeSourceBinding(facets: VerificationFacets): SourceBindingSummary {
  const current = facets.checks.filter(facet => facet.status === 'current' && facet.freshness);
  const gitChecks = current.filter(facet => facet.freshness!.basis === 'git').length;
  const workspaceChecks = current.filter(facet => facet.freshness!.basis === 'artifact' && facet.freshness!.sourceBound === true).length;
  const unboundChecks = current.length - gitChecks - workspaceChecks;
  const basis: SourceBindingSummary['basis'] = current.length === 0 ? 'none'
    : gitChecks && (workspaceChecks || unboundChecks) ? 'mixed'
    : gitChecks ? 'git'
    : 'artifact';
  return { basis, bound: current.length > 0 && unboundChecks === 0, currentChecks: current.length, gitChecks, workspaceChecks, unboundChecks };
}

/** Build a runnable recovery command from affected check IDs; it is never executed automatically. */
export function verificationRecovery(changeId: string, checkIds: string[]): string {
  const unique = [...new Set(checkIds)];
  return unique.length ? `notchlet verify ${changeId} --check ${unique.join(',')} --record` : `notchlet verify ${changeId} --record`;
}

export function evidenceRecovery(changeId: string, record: Pick<EvidenceRecord, 'kind' | 'checkIds'>): string {
  return record.kind === 'check' && record.checkIds?.length ? verificationRecovery(changeId, record.checkIds) : `notchlet evidence record --change ${changeId} --file <evidence.json>`;
}

/** Resolve evidence scope from executed checks plus check-declared and explicitly selected links. */
export function resolveEvidenceScope(change: Change, executedCheckIds: string[], explicit: EvidenceScopeInput = {}): EvidenceScope {
  const declared = new Map(change.checks.map(check => [check.id, check]));
  const checkIds = [...new Set(executedCheckIds)].filter(id => declared.has(id));
  const requirementIds: string[] = [];
  const scenarioIds: string[] = [];
  const taskIds: string[] = [];
  const add = (target: string[], id: string) => { if (!target.includes(id)) target.push(id); };
  for (const checkId of checkIds) {
    const check = declared.get(checkId)!;
    for (const id of check.requirementIds ?? []) add(requirementIds, id);
    for (const id of check.scenarioIds ?? []) add(scenarioIds, id);
    for (const id of check.taskIds ?? []) add(taskIds, id);
  }
  for (const id of explicit.requirementIds ?? []) add(requirementIds, id);
  for (const id of explicit.scenarioIds ?? []) add(scenarioIds, id);
  for (const id of explicit.taskIds ?? []) add(taskIds, id);
  const knownRequirements = new Set(change.requirements.map(requirement => requirement.id));
  const unknownRequirements = requirementIds.filter(id => !knownRequirements.has(id));
  if (unknownRequirements.length) throw new WorkflowError('unknown_requirement', `Unknown requirement ID(s): ${unknownRequirements.join(', ')}.`, 'Use requirement IDs from `notchlet change show`.');
  const knownScenarios = new Set(change.acceptanceScenarios.map(scenario => scenario.id));
  const unknownScenarios = scenarioIds.filter(id => !knownScenarios.has(id));
  if (unknownScenarios.length) throw new WorkflowError('unknown_scenario', `Unknown acceptance scenario ID(s): ${unknownScenarios.join(', ')}.`, 'Use scenario IDs from `notchlet change show`.');
  const knownTasks = new Set(change.tasks.map(task => task.id));
  const unknownTasks = taskIds.filter(id => !knownTasks.has(id));
  if (unknownTasks.length) throw new WorkflowError('unknown_task', `Unknown task ID(s): ${unknownTasks.join(', ')}.`, 'Use task IDs from `notchlet change show`.');
  return { checkIds, requirementIds, ...(scenarioIds.length ? { scenarioIds } : {}), taskIds };
}

/** List records with freshness and recovery guidance, filtering after freshness evaluation. */
export async function inspectEvidence(root: string, changeId: string, filter: EvidenceFilter = {}): Promise<EvidenceListing[]> {
  const records = await readEvidence(root, changeId);
  const listings: EvidenceListing[] = [];
  for (const record of records) {
    let freshness: EvidenceFreshness = { status: 'unknown', basis: 'artifact', reasons: ['Freshness could not be evaluated.'], independentlyVerified: false };
    try { freshness = await evaluateEvidenceFreshness(root, changeId, record); } catch { /* keep conservative unknown result */ }
    if (filter.checkId !== undefined && !(record.checkIds ?? []).includes(filter.checkId)) continue;
    if (filter.requirementId !== undefined && !record.requirementIds.includes(filter.requirementId)) continue;
    if (filter.taskId !== undefined && !record.taskIds.includes(filter.taskId)) continue;
    if (filter.stale === true && freshness.status !== 'stale') continue;
    if (filter.failed === true && record.outcome !== 'failed') continue;
    const usable = freshness.status === 'fresh' && record.outcome !== 'failed';
    listings.push({ record, freshness, ...(usable ? {} : { recovery: evidenceRecovery(changeId, record) }) });
  }
  return listings;
}

/** Evaluate the latest record that references a task against the shared freshness policy. */
export async function taskEvidenceStatus(root: string, change: Change, taskId: string): Promise<TaskEvidenceStatus> {
  const declaredCheckIds = change.checks.filter(check => check.taskIds?.includes(taskId)).map(check => check.id);
  const taskRecovery = (ids: string[]): string => ids.length
    ? `notchlet verify ${change.id} --check ${[...new Set(ids)].join(',')} --record --task ${taskId}`
    : `notchlet verify ${change.id} --record --task ${taskId}`;
  let records: EvidenceRecord[] = [];
  try { records = await readEvidence(root, change.id); } catch { records = []; }
  const latest = records
    .filter(record => record.taskIds.includes(taskId))
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
    .pop();
  if (!latest) {
    return { taskId, status: 'missing', checkIds: declaredCheckIds, recovery: taskRecovery(declaredCheckIds) };
  }
  const checkIds = latest.checkIds?.length ? latest.checkIds : declaredCheckIds;
  const recovery = latest.kind === 'check' ? taskRecovery(checkIds) : evidenceRecovery(change.id, latest);
  let freshness: EvidenceFreshness;
  try { freshness = await evaluateEvidenceFreshness(root, change.id, latest); }
  catch { freshness = { status: 'unknown', basis: 'artifact', reasons: ['Freshness could not be evaluated.'], independentlyVerified: false }; }
  if (latest.outcome === 'failed') return { taskId, status: 'failed', evidenceId: latest.id, freshness, checkIds, recovery };
  if (latest.outcome !== 'passed') return { taskId, status: 'missing', evidenceId: latest.id, freshness, checkIds, recovery };
  const status: TaskEvidenceStatus['status'] = freshness.status === 'stale' ? 'stale' : freshness.status === 'unknown' ? 'unknown' : 'current';
  return { taskId, status, evidenceId: latest.id, freshness, checkIds, recovery };
}
