import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkflowError } from './errors.js';
import { stableId } from './ids.js';

export const MAX_CHANGE_SEGMENT = 64;
export const MAX_CHANGE_RELATIVE_PATH = 180;
export const MAX_CHANGE_DEPTH = 8;

const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SEGMENTS = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);
const RESERVED_CHARACTERS = /[<>:"|?*\u0000-\u001f]/;

export type ChangeScope = 'active' | 'archive';
export type ChangeScopeOption = ChangeScope | 'merged';

export interface ChangeLocation {
  relativePath: string;
  directory: string;
  id: string;
  name?: string;
  scope: ChangeScope;
}

export interface ChangeDirectoryEntry {
  relativePath: string;
  directory: string;
  scope: ChangeScope;
}

export interface ScanChangeOptions {
  scope?: ChangeScopeOption;
  maxDepth?: number;
}

export interface ResolveChangeOptions {
  scope?: ChangeScopeOption;
}

export function sanitizePathSegment(value: string): string {
  const slug = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const trimmed = slug.slice(0, MAX_CHANGE_SEGMENT).replace(/-+$/g, '');
  return trimmed || 'change';
}

export function validatePathSegment(segment: string): string {
  if (!segment || segment.length > MAX_CHANGE_SEGMENT || !SEGMENT_PATTERN.test(segment) || RESERVED_SEGMENTS.has(segment) || RESERVED_CHARACTERS.test(segment)) {
    throw new WorkflowError('invalid_change_path', `Invalid change path segment: ${segment}`, 'Use lowercase letters, numbers, and hyphens; avoid Windows reserved names.');
  }
  return segment;
}

/** Validate and normalize a change reference that uses `/` separators. Names with spaces are not paths. */
export function normalizeRelativePath(reference: string): string {
  const value = reference.trim().replace(/\\/g, '/');
  if (!value) throw new WorkflowError('invalid_change_path', 'Change path is empty.', 'Pass a change ID, name, or relative path.');
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new WorkflowError('invalid_change_path', `Change path must be relative: ${reference}`, 'Use a path relative to `.notchlet/changes`.');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new WorkflowError('invalid_change_path', `Change path is not normalized: ${reference}`, 'Remove empty, `.` and `..` segments.');
  }
  if (segments.length > MAX_CHANGE_DEPTH) {
    throw new WorkflowError('path_budget_exceeded', `Change path has ${segments.length} segments (maximum ${MAX_CHANGE_DEPTH}).`, 'Shorten the backlog hierarchy.');
  }
  for (const segment of segments) validatePathSegment(segment);
  const relative = segments.join('/');
  if (relative.length > MAX_CHANGE_RELATIVE_PATH) {
    throw new WorkflowError('path_budget_exceeded', `Change path is ${relative.length} characters (maximum ${MAX_CHANGE_RELATIVE_PATH}).`, 'Shorten the node names or move the workspace closer to the drive root.');
  }
  return relative;
}

export const validateChangeRef = normalizeRelativePath;

/** Build the relative directory for a node: `<key>-<slug>` when a platform key exists, else `<slug>`. */
export function composeNodeDirectory(input: { key?: string; slug: string; parentRelativePath?: string }): string {
  const slug = sanitizePathSegment(input.slug);
  const key = input.key ? sanitizePathSegment(input.key) : undefined;
  let leaf = key ? `${key}-${slug}` : slug;
  if (leaf.length > MAX_CHANGE_SEGMENT) leaf = leaf.slice(0, MAX_CHANGE_SEGMENT).replace(/-+$/g, '') || 'change';
  const relative = input.parentRelativePath ? `${normalizeRelativePath(input.parentRelativePath)}/${leaf}` : leaf;
  return normalizeRelativePath(relative);
}

export function changeRefHash(relativePath: string): string {
  return createHash('sha256').update(relativePath).digest('hex').slice(0, 16);
}

export function changesDirectory(root: string, scope: ChangeScope = 'active'): string {
  return path.join(path.resolve(root), '.notchlet', scope === 'active' ? 'changes' : 'archive');
}

export function directoryForRelative(root: string, scope: ChangeScope, relativePath: string): string {
  return path.join(changesDirectory(root, scope), ...normalizeRelativePath(relativePath).split('/'));
}

async function isChangeDirectory(directory: string): Promise<boolean> {
  try { await access(path.join(directory, 'tasks.json')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
}

async function pathExists(target: string): Promise<boolean> {
  try { await access(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
}

/** Recursively find change nodes. Implicit container directories have no `tasks.json` and are skipped as results. */
export async function scanChangeDirectories(root: string, options: ScanChangeOptions = {}): Promise<ChangeDirectoryEntry[]> {
  const scopeOption = options.scope ?? 'active';
  const scopes: ChangeScope[] = scopeOption === 'merged' ? ['active', 'archive'] : [scopeOption];
  const maxDepth = Math.min(options.maxDepth ?? MAX_CHANGE_DEPTH, MAX_CHANGE_DEPTH);
  const results: ChangeDirectoryEntry[] = [];
  for (const scope of scopes) {
    const base = changesDirectory(root, scope);
    const walk = async (directory: string, relativePath: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return; throw error; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'evidence') continue;
        const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const childDirectory = path.join(directory, entry.name);
        if (await isChangeDirectory(childDirectory)) results.push({ relativePath: childRelative, directory: childDirectory, scope });
        await walk(childDirectory, childRelative, depth + 1);
      }
    };
    await walk(base, '', 0);
  }
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.scope.localeCompare(b.scope));
}

function tryNormalize(reference: string): string | null {
  try { return normalizeRelativePath(reference); }
  catch { return null; }
}

async function readIdentity(directory: string, relativePath: string): Promise<{ id: string; name?: string }> {
  const fallback = relativePath.split('/').pop() ?? relativePath;
  try {
    const value = JSON.parse(await readFile(path.join(directory, 'tasks.json'), 'utf8')) as Record<string, unknown>;
    return {
      id: typeof value.id === 'string' && value.id ? value.id : fallback,
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
    };
  } catch { return { id: fallback }; }
}

async function locationFor(relativePath: string, directory: string, scope: ChangeScope): Promise<ChangeLocation> {
  const identity = await readIdentity(directory, relativePath);
  return { relativePath, directory, scope, ...identity };
}

function ambiguousChange(reference: string, candidates: ChangeLocation[]): WorkflowError {
  const listed = candidates.map(candidate => `${candidate.relativePath} (${candidate.scope})`).join(', ');
  return new WorkflowError('ambiguous_change', `Change reference "${reference}" matches multiple changes: ${listed}.`, 'Use the relative path shown by `notchlet change list` to disambiguate.');
}

/**
 * Resolve a change by exact relative path, unique ID, or unique name.
 * Exact paths win; otherwise an ID match must be unique, then a name match, then a case-insensitive fallback.
 */
export async function resolveChangeLocation(root: string, reference: string, options: ResolveChangeOptions = {}): Promise<ChangeLocation> {
  const raw = reference.trim();
  if (!raw) throw new WorkflowError('invalid_change_path', 'Change reference is empty.', 'Pass a change ID, name, or relative path.');
  const scopeOption = options.scope ?? 'active';
  const scopes: ChangeScope[] = scopeOption === 'merged' ? ['active', 'archive'] : [scopeOption];
  const pathRef = /[\\/]/.test(raw) ? normalizeRelativePath(raw) : tryNormalize(raw);

  if (pathRef) {
    for (const scope of scopes) {
      const directory = directoryForRelative(root, scope, pathRef);
      if (await isChangeDirectory(directory)) return locationFor(pathRef, directory, scope);
    }
  }

  const entries: Array<ChangeDirectoryEntry> = [];
  for (const scope of scopes) entries.push(...await scanChangeDirectories(root, { scope }));
  if (!entries.length) {
    throw new WorkflowError('change_not_found', `Change not found: ${raw}`, scopeOption === 'archive' ? 'List archived changes with `notchlet change list --archived`.' : 'List changes with `notchlet change list` and use an existing change ID.');
  }
  const locations = await Promise.all(entries.map(entry => locationFor(entry.relativePath, entry.directory, entry.scope)));

  if (pathRef) {
    const exact = locations.filter(candidate => candidate.relativePath === pathRef);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw ambiguousChange(raw, exact);
  }

  for (const match of [
    (candidate: ChangeLocation) => candidate.id === raw,
    (candidate: ChangeLocation) => candidate.name === raw,
    (candidate: ChangeLocation) => candidate.id.toLowerCase() === raw.toLowerCase(),
    (candidate: ChangeLocation) => candidate.name?.toLowerCase() === raw.toLowerCase(),
  ]) {
    const matches = locations.filter(match);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw ambiguousChange(raw, matches);
  }

  throw new WorkflowError('change_not_found', `Change not found: ${raw}`, 'List changes with `notchlet change list` and use an existing change ID or relative path.');
}

export async function changeDirectoryFor(root: string, reference: string): Promise<string> {
  return (await resolveChangeLocation(root, reference, { scope: 'active' })).directory;
}

export async function archiveDirectoryFor(root: string, reference: string): Promise<string> {
  return (await resolveChangeLocation(root, reference, { scope: 'archive' })).directory;
}

export async function mergedLocation(root: string, reference: string): Promise<ChangeLocation> {
  return resolveChangeLocation(root, reference, { scope: 'merged' });
}

/** Return a free relative path, suffixing the leaf with `-2`, `-3`, ... on case-insensitive collisions. */
export async function uniqueNodeDirectory(root: string, relativePath: string): Promise<string> {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split('/');
  const leaf = segments.pop()!;
  const prefix = segments.join('/');
  const existing = await scanChangeDirectories(root, { scope: 'merged' });
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidateLeaf = attempt === 0 ? leaf : `${leaf}-${attempt + 1}`;
    const candidate = prefix ? `${prefix}/${candidateLeaf}` : candidateLeaf;
    if (candidate.length > MAX_CHANGE_RELATIVE_PATH) {
      throw new WorkflowError('path_budget_exceeded', `Change path is ${candidate.length} characters (maximum ${MAX_CHANGE_RELATIVE_PATH}).`, 'Shorten the node names or move the workspace closer to the drive root.');
    }
    if (await pathExists(directoryForRelative(root, 'active', candidate)) || await pathExists(directoryForRelative(root, 'archive', candidate))) continue;
    const lowered = candidate.toLowerCase();
    if (existing.some(entry => entry.relativePath.toLowerCase() === lowered)) continue;
    return candidate;
  }
  throw new WorkflowError('path_budget_exceeded', `Unable to allocate a unique change path for ${normalized}.`, 'Choose a different change name.');
}

/** Walk up to the workspace root marker instead of assuming a fixed directory depth. */
export async function workspaceRootForChangeFile(file: string): Promise<string> {
  let current = path.dirname(path.resolve(file));
  while (true) {
    try { if ((await stat(path.join(current, '.notchlet', 'workspace.json'))).isFile()) return current; }
    catch { /* keep walking */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(path.dirname(file), '..', '..', '..');
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 4) { await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1))); continue; }
      throw error;
    }
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try { await renameWithRetry(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/**
 * Move `source` into `destination`, merging directory trees.
 * Identical file contents at the same relative path are deduplicated; conflicting contents fail with `archive_conflict`.
 */
export async function mergeMoveDirectory(source: string, destination: string): Promise<void> {
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkflowError('archive_conflict', `Source directory is missing: ${source}`, 'Refresh the workspace and retry.');
    throw error;
  }
  await mkdir(destination, { recursive: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new WorkflowError('archive_conflict', `Refusing to merge symbolic link: ${entry.name}`, 'Remove the symbolic link and retry.');
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      if (await pathExists(to)) await mergeMoveDirectory(from, to);
      else await renameWithRetry(from, to);
      continue;
    }
    if (!(await pathExists(to))) { await renameWithRetry(from, to); continue; }
    const [incoming, existing] = await Promise.all([readFile(from), readFile(to)]);
    if (incoming.equals(existing)) { await rm(from, { force: true }); continue; }
    throw new WorkflowError('archive_conflict', `Archive conflict at ${to}`, 'Inspect both files, keep the correct content, and retry the close or restore.');
  }
  await rm(source, { recursive: true, force: true });
}
