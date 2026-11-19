import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface NormalizedRemote { host: string; owner: string; repo: string; }
export interface GitFingerprint { algorithm: 'sha256'; digest: string; files: number; bytesHashed: number; truncated: boolean; }
export interface GitRepositoryIdentity {
  topLevel: string;
  gitDir: string;
  commonDir: string;
  isLinkedWorktree: boolean;
  branch: string | null;
  head: string | null;
  remotes: NormalizedRemote[];
}
export type GitContextResult =
  | { available: true; isRepository: true; repository: GitRepositoryIdentity; tracked: GitFingerprint; untracked: GitFingerprint }
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

function excluded(relative: string): boolean {
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  // Evidence is derived from the current change/Git view; hashing the evidence log itself
  // would make every newly recorded item stale immediately after its own append.
  return parts.at(-1) === 'evidence.jsonl' || parts.at(-1) === 'evidence.jsonl.lock' ||
    parts.some((part, index) => part === '.git' || part === 'node_modules' || ['dist', 'build', 'coverage', 'out', '.next', '.turbo'].includes(part)) ||
    parts.some(part => part.startsWith('.env')) || parts.some((part, index) => part === '.local' && parts[index - 1] === '.notchlet');
}

async function fingerprint(root: string, paths: string[]): Promise<GitFingerprint> {
  const hash = createHash('sha256');
  let files = 0, bytesHashed = 0, truncated = paths.length > MAX_FILES;
  const ordered = paths.filter(file => !excluded(file)).sort((a, b) => a.localeCompare(b, 'en'));
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
    const remoteLines = (await git(topLevel, 'remote', '-v')).split(/\r?\n/);
    const remotes = [...new Map(remoteLines.map(line => line.match(/^\S+\s+(.+?)\s+\(fetch\)$/)).filter(Boolean).map(match => normalizeRemote(match![1])).filter((value): value is NormalizedRemote => Boolean(value)).map(remote => [`${remote.host}/${remote.owner}/${remote.repo}`, remote])).values()].sort((a,b) => `${a.host}/${a.owner}/${a.repo}`.localeCompare(`${b.host}/${b.owner}/${b.repo}`));
    const trackedPaths = (await git(topLevel, 'ls-files', '-z')).split('\0').filter(Boolean);
    const untrackedPaths = (await git(topLevel, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(file => Boolean(file) && !/evidence\.jsonl(?:\.lock)?$/.test(file.replace(/\\/g, '/')));
    return { available: true, isRepository: true, repository: { topLevel, gitDir, commonDir, isLinkedWorktree: gitDir !== commonDir, branch, head, remotes }, tracked: await fingerprint(topLevel, trackedPaths), untracked: await fingerprint(topLevel, untrackedPaths) };
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).message ?? '';
    if (/not a git repository/i.test(message) || (error as NodeJS.ErrnoException).code === 'ENOENT') return { available: true, isRepository: false, reason: 'not_a_repository' };
    throw error;
  }
}
