import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectGitContext, type GitContextResult } from './git-context.js';
import { parseChange, type Change } from './index.js';

export type EvidenceKind = 'check' | 'note' | 'artifact';
export type EvidenceOutcome = 'passed' | 'failed' | 'informational';
export type EvidenceProvenance = 'recorded' | 'imported' | 'locally-observed';
export interface EvidenceRecord {
  schemaVersion: 1; id: string; kind: EvidenceKind; outcome: EvidenceOutcome; summary: string;
  command?: string; requirementIds: string[]; taskIds: string[]; checkIds?: string[]; capturedAt: string; provenance: EvidenceProvenance;
  changeRevision: number; artifactHash: string; git: GitContextResult;
}
export type EvidenceWriteInput = Omit<EvidenceRecord, 'schemaVersion'|'id'|'capturedAt'|'changeRevision'|'artifactHash'|'git'|'provenance'> & { provenance: 'recorded' | 'imported'; id?: string; capturedAt?: string };
export interface EvidenceFreshness { status: 'fresh' | 'stale' | 'unknown'; reasons: string[]; independentlyVerified: boolean; }

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function changeDir(root: string, id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid change ID: ${id}`);
  return path.join(path.resolve(root), '.notchlet', 'changes', id);
}
async function artifactHash(dir: string, change: Change): Promise<string> {
  const entries: Array<[string, string]> = [];
  for (const relative of Object.values(change.artifacts).sort()) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Invalid artifact path: ${relative}`);
    try { entries.push([relative, hash(await readFile(path.join(dir, relative)))]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries.push([relative, 'missing']); }
  }
  return hash(JSON.stringify(entries));
}
async function acquire(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.lock`;
  for (let i = 0; i < 200; i++) {
    try { await writeFile(lock, `${process.pid}\n`, { flag: 'wx' }); return () => rm(lock, { force: true }); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw e;
      if (code === 'EPERM') {
        try { await lstat(lock); } catch (statError) { if ((statError as NodeJS.ErrnoException).code === 'ENOENT') throw e; throw statError; }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error('Timed out acquiring evidence store lock.');
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  if (!value || typeof value !== 'object') throw new Error('Evidence record must be an object.');
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== 1 || typeof r.id !== 'string' || !r.id || !['check','note','artifact'].includes(String(r.kind)) || !['passed','failed','informational'].includes(String(r.outcome)) || typeof r.summary !== 'string' || !r.summary.trim() || !Array.isArray(r.requirementIds) || !r.requirementIds.every(x => typeof x === 'string') || !Array.isArray(r.taskIds) || !r.taskIds.every(x => typeof x === 'string') || (r.checkIds !== undefined && (!Array.isArray(r.checkIds) || !r.checkIds.every(x => typeof x === 'string' && x.length > 0) || new Set(r.checkIds).size !== r.checkIds.length || (r.checkIds.length > 0 && r.kind !== 'check'))) || typeof r.capturedAt !== 'string' || !Number.isFinite(Date.parse(r.capturedAt)) || !['recorded','imported','locally-observed'].includes(String(r.provenance)) || !Number.isInteger(r.changeRevision) || typeof r.artifactHash !== 'string' || !r.git || typeof r.git !== 'object' || (r.command !== undefined && typeof r.command !== 'string')) throw new Error('Invalid evidence record schema.');
  return r as unknown as EvidenceRecord;
}

export async function readEvidence(root: string, id: string): Promise<EvidenceRecord[]> {
  const file = path.join(changeDir(root, id), 'evidence.jsonl');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const change = parseChange(await readFile(path.join(changeDir(root, id), 'tasks.json'), 'utf8'));
  const checkIds = new Set(change.checks.map(check => check.id));
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const record = parseEvidenceRecord(JSON.parse(line));
    if (record.checkIds?.some(checkId => !checkIds.has(checkId))) throw new Error('Evidence references an unknown check ID.');
    return record;
  });
}

/** Appends user-supplied evidence; command is descriptive only and is never run. */
export async function appendEvidence(root: string, changeId: string, input: EvidenceWriteInput): Promise<EvidenceRecord> {
  const dir = changeDir(root, changeId); const change = parseChange(await readFile(path.join(dir, 'tasks.json'), 'utf8'));
  if (change.id !== changeId) throw new Error('Change ID does not match its directory.');
  const reqs = new Set(change.requirements.map(x => x.id)), tasks = new Set(change.tasks.map(x => x.id));
  if (input.requirementIds.some(x => !reqs.has(x))) throw new Error('Evidence references an unknown requirement ID.');
  if (input.taskIds.some(x => !tasks.has(x))) throw new Error('Evidence references an unknown task ID.');
  const checks = new Set(change.checks.map(x => x.id));
  if (input.checkIds?.some(x => !checks.has(x))) throw new Error('Evidence references an unknown check ID.');
  if (input.provenance !== 'recorded' && input.provenance !== 'imported') throw new Error('Evidence ingestion accepts only recorded or imported provenance.');
  const file = path.join(dir, 'evidence.jsonl'); await mkdir(dir, { recursive: true }); const release = await acquire(file);
  try {
    const existing = await readEvidence(root, changeId); const record = parseEvidenceRecord({ ...input, schemaVersion: 1, id: input.id ?? randomUUID(), capturedAt: input.capturedAt ?? new Date().toISOString(), changeRevision: change.revision ?? 0, artifactHash: await artifactHash(dir, change), git: await inspectGitContext(root) });
    if (existing.some(item => item.id === record.id)) throw new Error(`Evidence ID already exists: ${record.id}`);
    // Rewrite under lock with atomic replacement to avoid partial concurrent appends.
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, [...existing, record].map(item => JSON.stringify(item)).join('\n') + '\n', { flag: 'wx' });
    await rename(temp, file); return record;
  } finally { await release(); }
}

export async function evaluateEvidenceFreshness(root: string, changeId: string, evidence: EvidenceRecord): Promise<EvidenceFreshness> {
  const reasons: string[] = [];
  const dir = changeDir(root, changeId); const change = parseChange(await readFile(path.join(dir, 'tasks.json'), 'utf8'));
  if ((change.revision ?? 0) !== evidence.changeRevision || await artifactHash(dir, change) !== evidence.artifactHash) reasons.push('Relevant change artifacts or revision changed.');
  const current = await inspectGitContext(root);
  const unknownReasons: string[] = [];
  if (!current.isRepository || !evidence.git.isRepository) unknownReasons.push('Git repository observation is unavailable.');
  else if (current.tracked.truncated || current.untracked.truncated || evidence.git.tracked.truncated || evidence.git.untracked.truncated) unknownReasons.push('Git fingerprint was truncated.');
  else if (current.repository.head !== evidence.git.repository.head || current.tracked.digest !== evidence.git.tracked.digest || current.untracked.digest !== evidence.git.untracked.digest) reasons.push('Git worktree or HEAD changed.');
  return { status: reasons.length ? 'stale' : unknownReasons.length ? 'unknown' : 'fresh', reasons: [...reasons, ...unknownReasons], independentlyVerified: false };
}
