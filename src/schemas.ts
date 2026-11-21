import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowError } from './index.js';

const SCHEMA_DIRECTORY = fileURLToPath(new URL('../schemas', import.meta.url));
const NAME_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i;

export interface SchemaListing { name: string; file: string; title?: string; id?: string }

function basenameFor(name: string): string {
  if (!NAME_PATTERN.test(name)) throw new WorkflowError('invalid_schema_name', `Invalid schema name: ${name}`, 'Use a schema name such as plan.v1, closure.v1, or check.v1.');
  return name.endsWith('.json') ? name : `${name}.schema.json`;
}

/** List the JSON schemas shipped with the core package. */
export async function listSchemas(): Promise<SchemaListing[]> {
  const files = (await readdir(SCHEMA_DIRECTORY)).filter(file => file.endsWith('.schema.json')).sort();
  return Promise.all(files.map(async file => {
    const listing: SchemaListing = { name: file.replace(/\.schema\.json$/, ''), file };
    try {
      const schema = JSON.parse(await readFile(path.join(SCHEMA_DIRECTORY, file), 'utf8')) as { title?: string; $id?: string };
      if (schema.title) listing.title = schema.title;
      if (schema.$id) listing.id = schema.$id;
    } catch { /* a malformed shipped schema is still listable */ }
    return listing;
  }));
}

/** Read one shipped schema by name (`plan`, `plan.v1`, or `plan.v1.schema.json`). */
export async function readSchema(name: string): Promise<{ name: string; file: string; schema: Record<string, unknown> }> {
  const primary = basenameFor(name);
  const candidates = [primary, ...(!name.includes('.') ? [`${name}.v1.schema.json`] : [])];
  for (const file of candidates) {
    try {
      const schema = JSON.parse(await readFile(path.join(SCHEMA_DIRECTORY, file), 'utf8')) as Record<string, unknown>;
      return { name: file.replace(/\.schema\.json$/, ''), file, schema };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const available = (await listSchemas()).map(item => item.name).join(', ');
  throw new WorkflowError('schema_not_found', `Schema ${name} is not shipped with Notchlet.`, `Use one of: ${available}.`);
}

export function schemaDirectory(): string { return SCHEMA_DIRECTORY; }
