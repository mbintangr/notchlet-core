import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 16;

const EXCLUDED_DIRECTORIES = new Set([
  '.notchlet', '.git', 'node_modules', 'dist', 'build', 'coverage', 'out', '.next', '.turbo',
  '.cache', 'vendor', '__pycache__', '.venv', 'venv', '.ssh', '.aws', '.gnupg', '.azure', '.kube',
  'credentials', 'secrets',
]);
const EXCLUDED_FILES = new Set([
  '.npmrc', '.pypirc', '.netrc', '.htpasswd', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', 'credentials.json', 'secrets', 'secrets.json', 'secret.json',
]);
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore|crt|der)$/i;

/** Select source-like workspace content without hashing metadata, dependencies, environment, or credentials. */
export function isSourceExcluded(relative: string): boolean {
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean).map(part => part.toLowerCase());
  if (!parts.length) return false;
  if (parts.some(part => EXCLUDED_DIRECTORIES.has(part))) return true;
  const name = parts.at(-1)!;
  if (name === 'evidence.jsonl' || name === 'evidence.jsonl.lock') return true;
  if (name === '.env' || name.startsWith('.env.') || name.startsWith('.env-')) return true;
  if (EXCLUDED_FILES.has(name)) return true;
  return SECRET_EXTENSION.test(name);
}

export interface WorkspaceFingerprint {
  algorithm: 'sha256';
  digest: string;
  files: number;
  bytesHashed: number;
  truncated: boolean;
}

/** Fingerprint source content for non-Git workspaces. Only relative paths and hashes are retained in memory. */
export async function fingerprintWorkspace(root: string): Promise<WorkspaceFingerprint> {
  const base = path.resolve(root);
  const hash = createHash('sha256');
  let files = 0;
  let bytesHashed = 0;
  let truncated = false;

  const walk = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) { truncated = true; return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (truncated) return;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (isSourceExcluded(relative)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        hash.update(`${relative}\0symlink:${target}\0`);
        files += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files >= MAX_FILES) { truncated = true; return; }
      const info = await lstat(absolute);
      if (info.size > MAX_FILE_BYTES || bytesHashed + info.size > MAX_TOTAL_BYTES) { truncated = true; continue; }
      const content = await readFile(absolute);
      bytesHashed += content.byteLength;
      hash.update(`${relative}\0${content.byteLength}\0`);
      hash.update(content);
      hash.update('\0');
      files += 1;
    }
  };

  await walk(base, '', 0);
  return { algorithm: 'sha256', digest: hash.digest('hex'), files, bytesHashed, truncated };
}
