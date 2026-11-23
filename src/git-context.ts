import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSourceExcluded } from './source-files.js';

const execFileAsync = promisify(execFile);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface NormalizedRemote { host: string; owner: string; repo: string; }
export interface NamedRemote extends NormalizedRemote { name: string; }
export interface GitFingerprint { algorithm: 'sha256'; digest: string; files: number; bytesHashed: number; truncated: boolean; }
export interface GitRepositoryIdentity {
  topLevel: string;
  gitDir: string;
  commonDir: string;
  isLinkedWorktree: boolean;
  branch: string | null;
  head: string | null;
  /** Tree object for the recorded commit, when the repository has a commit. */
  headTree: string | null;
  remotes: NormalizedRemote[];
  /** Fetch remotes retained with their Git remote name; never includes credentials. */
  remoteDetails: NamedRemote[];
  /** The fetch remote named origin, when present. */
  originRemote?: NormalizedRemote;
}
export type GitContextResult =
  | { available: true; isRepository: true; repository: GitRepositoryIdentity; tracked: GitFingerprint; untracked: GitFingerprint; dirty: boolean }
  | { available: true; isRepository: false; reason: 'not_a_repository' }
  | { available: false; isRepository: false; reason: 'git_unavailable' };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout.trimEnd();
}

function normalizeRemote(input: string): NormalizedRemote | null {
  // Parse URL forms and scp-like SSH forms without retaining userinfo or query data.
  let host: string, repoPath: string;
  try {
    if (/^[^/]+@[^:]+:.+/.test(input)) {
      const match = input.match(/^[^@]+@([^:]+):(.+)$/)!;
      host = match[1]; repoPath = match[2];
    } else {
      const url = new URL(input);
      host = url.hostname;
      repoPath = url.pathname;
    }
  } catch { return null; }
  const parts = repoPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (!host || parts.length < 2) return null;
  return { host: host.toLowerCase(), owner: parts.at(-2)!, repo: parts.at(-1)! };
}

async function fingerprint(root: string, paths: string[]): Promise<GitFingerprint> {
  const hash = createHash('sha256');
  let files = 0, bytesHashed = 0, truncated = false;
  const ordered = paths.filter(file => !isSourceExcluded(file)).sort((a, b) => a.localeCompare(b, 'en'));
  if (ordered.length > MAX_FILES) truncated = true;
  for (const relative of ordered.slice(0, MAX_FILES)) {
    const filePath = path.join(root, relative);
    try {
      const info = await lstat(filePath);
      let content: Buffer;
      if (info.isSymbolicLink()) content = Buffer.from(`symlink:${await readlink(filePath)}`);
      else if (info.isFile() && info.size <= MAX_FILE_BYTES && bytesHashed + info.size <= MAX_TOTAL_BYTES) content = await readFile(filePath);
      else { truncated = true; continue; }
      bytesHashed += content.length;
      hash.update(relative.replace(/\\/g, '/') + '\0' + content.length + '\0');
      hash.update(content);
      hash.update('\0');
      files++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const marker = `deleted:${relative.replace(/\\/g, '/')}`;
        hash.update(marker + '\0'); files++;
      } else throw error;
    }
  }
  return { algorithm: 'sha256', digest: hash.digest('hex'), files, bytesHashed, truncated };
}

/** Inspect Git identity and bounded content fingerprints without returning file contents or credential-bearing URLs. */
/** Cheap repository probe for output that only discloses whether source changes are observed. */
export async function detectObservationBasis(start = process.cwd()): Promise<'git' | 'artifact'> {
  try {
    const cwd = await realpath(path.resolve(start)).catch(() => path.resolve(start));
    await git(cwd, 'rev-parse', '--show-toplevel');
    return 'git';
  } catch { return 'artifact'; }
}

export async function inspectGitContext(start = process.cwd()): Promise<GitContextResult> {
  const cwd = await realpath(path.resolve(start)).catch(() => path.resolve(start));
  try { await git(cwd, '--version'); }
  catch { return { available: false, isRepository: false, reason: 'git_unavailable' }; }
  try {
    const topLevel = await realpath(await git(cwd, 'rev-parse', '--show-toplevel'));
    const gitDir = await realpath(path.resolve(topLevel, await git(topLevel, 'rev-parse', '--absolute-git-dir')));
    const commonRaw = await git(topLevel, 'rev-parse', '--git-common-dir');
    const commonDir = await realpath(path.resolve(topLevel, commonRaw));
    const branch = await git(topLevel, 'branch', '--show-current') || null;
    const head = await git(topLevel, 'rev-parse', '--verify', 'HEAD').catch(() => null);
    const headTree = head ? await git(topLevel, 'rev-parse', '--verify', `${head}^{tree}`).catch(() => null) : null;
    const remoteLines = (await git(topLevel, 'remote', '-v')).split(/\r?\n/);
    const named = remoteLines.map(line => {
      const match = line.match(/^(\S+)\s+(.+?)\s+\(fetch\)$/);
      if (!match) return null;
      const remote = normalizeRemote(match[2]);
      return remote ? { name: match[1], ...remote } : null;
    }).filter((value): value is NamedRemote => Boolean(value));
    const remoteDetails = [...new Map(named.map(remote => [`${remote.name}\0${remote.host}/${remote.owner}/${remote.repo}`, remote])).values()]
      .sort((a, b) => `${a.name}/${a.host}/${a.owner}/${a.repo}`.localeCompare(`${b.name}/${b.host}/${b.owner}/${b.repo}`));
    const remotes = [...new Map(remoteDetails.map(remote => [`${remote.host}/${remote.owner}/${remote.repo}`, { host: remote.host, owner: remote.owner, repo: remote.repo }])).values()]
      .sort((a, b) => `${a.host}/${a.owner}/${a.repo}`.localeCompare(`${b.host}/${b.owner}/${b.repo}`));
    const originRemote = remoteDetails.find(remote => remote.name === 'origin');
    const trackedPaths = (await git(topLevel, 'ls-files', '-z')).split('\0').filter(Boolean);
    const untrackedPaths = (await git(topLevel, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(file => Boolean(file) && !/evidence\.jsonl(?:\.lock)?$/.test(file.replace(/\\/g, '/')));
    const status = await git(topLevel, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--no-renames').catch(() => '');
    const dirty = status.split('\0').filter(Boolean).some(entry => !isSourceExcluded(entry.slice(3)));
    return { available: true, isRepository: true, repository: { topLevel, gitDir, commonDir, isLinkedWorktree: gitDir !== commonDir, branch, head, headTree, remotes, remoteDetails, ...(originRemote === undefined ? {} : { originRemote: { host: originRemote.host, owner: originRemote.owner, repo: originRemote.repo } }) }, tracked: await fingerprint(topLevel, trackedPaths), untracked: await fingerprint(topLevel, untrackedPaths), dirty };
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).message ?? '';
    if (/not a git repository/i.test(message) || (error as NodeJS.ErrnoException).code === 'ENOENT') return { available: true, isRepository: false, reason: 'not_a_repository' };
    throw error;
  }
}
