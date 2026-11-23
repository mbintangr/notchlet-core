import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkflowError } from './errors.js';
import { stableId } from './ids.js';
import { atomicWriteJson } from './paths.js';

export const BACKLOG_SIDECAR = 'backlog.json';
export const BACKLOG_SCHEMA_VERSION = 2;

export type BacklogItemType = 'EPIC' | 'STORY' | 'TASK' | 'SUBTASK';
export type BacklogRemoteStatus = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE';
export type BacklogPriorityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type BacklogOrigin = 'local' | 'import' | 'migrate';
export type NodeSyncState = 'unlinked' | 'pending-create' | 'linked' | 'diverged';
export type LocalNodeStatus = 'open' | 'in_progress' | 'in_review' | 'done';

export interface BacklogNodeDetails {
  itemType: BacklogItemType;
  title: string;
  slug: string;
  origin: BacklogOrigin;
}

export interface BacklogPlanningDetails {
  priorityLevel?: BacklogPriorityLevel;
  storyPoints?: number;
  startDate?: string;
  dueDate?: string;
  description?: string;
}

export interface BacklogPlatformDetails {
  productId?: string;
  itemId?: number;
  key?: string;
  parentItemId?: number | null;
  remoteStatus?: BacklogRemoteStatus;
  remoteUpdatedAt?: string;
  remoteTitle?: string;
  remoteDescriptionSha256?: string;
  descriptionRevision?: number;
  priorityLevel?: BacklogPriorityLevel;
  storyPoints?: number;
  startDate?: string;
  dueDate?: string;
}

export interface BacklogSyncDetails {
  state: NodeSyncState;
  remoteChangeId?: string;
  snapshotRevision?: number;
  lastPushedRevision?: number;
  lastError?: string;
  lastPushedTitle?: string;
  lastPushedDescriptionSha256?: string;
  lastPushedPriorityLevel?: BacklogPriorityLevel;
  lastPushedStoryPoints?: number;
  lastPushedStartDate?: string;
  lastPushedDueDate?: string;
}

export interface BacklogMetaDetails {
  createdAt: string;
  updatedAt: string;
  lastWriter?: string;
}

export interface BacklogSidecar {
  schemaVersion: 2;
  node: BacklogNodeDetails;
  platform: BacklogPlatformDetails;
  sync: BacklogSyncDetails;
  planning?: BacklogPlanningDetails;
  meta: BacklogMetaDetails;
}

const ITEM_TYPES: BacklogItemType[] = ['EPIC', 'STORY', 'TASK', 'SUBTASK'];
const REMOTE_STATUSES: BacklogRemoteStatus[] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
const PRIORITY_LEVELS: BacklogPriorityLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const ORIGINS: BacklogOrigin[] = ['local', 'import', 'migrate'];
const SYNC_STATES: NodeSyncState[] = ['unlinked', 'pending-create', 'linked', 'diverged'];
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ITEM_TYPE_RANK: Record<BacklogItemType, number> = { EPIC: 1, STORY: 2, TASK: 3, SUBTASK: 4 };

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function schemaError(message: string): never {
  throw new WorkflowError('invalid_schema', message, 'Correct the backlog sidecar fields to match schema version 1 or 2 and try again.');
}

function exactKeys(value: JsonRecord, allowed: string[], required: string[], label: string): void {
  for (const key of required) if (!(key in value)) schemaError(`${label} is missing required field "${key}".`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) schemaError(`${label} has unsupported field "${key}".`);
}

function stringField(value: JsonRecord, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) schemaError(`${label}.${key} must be a non-empty string.`);
  return field;
}

function optionalString(value: JsonRecord, key: string, label: string): string | undefined {
  if (value[key] === undefined) return undefined;
  return stringField(value, key, label);
}

function optionalDescription(value: JsonRecord, key: string, label: string): string | undefined {
  const field = optionalString(value, key, label);
  if (field !== undefined && Buffer.byteLength(field, 'utf8') > 4000) schemaError(`${label}.${key} must be no larger than 4000 UTF-8 bytes.`);
  return field;
}

function optionalInteger(value: JsonRecord, key: string, label: string): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) schemaError(`${label}.${key} must be a non-negative integer.`);
  return field;
}

function optionalNumber(value: JsonRecord, key: string, label: string): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) schemaError(`${label}.${key} must be a non-negative number.`);
  return field;
}

function optionalSha256(value: JsonRecord, key: string, label: string): string | undefined {
  const field = optionalString(value, key, label);
  if (field !== undefined && !SHA256_PATTERN.test(field)) schemaError(`${label}.${key} must be a lowercase SHA-256 digest.`);
  return field;
}

function enumField<T extends string>(value: JsonRecord, key: string, allowed: readonly T[], label: string): T {
  const field = value[key];
  if (typeof field !== 'string' || !(allowed as readonly string[]).includes(field)) schemaError(`${label}.${key} must be one of ${allowed.join(', ')}.`);
  return field as T;
}

function optionalEnum<T extends string>(value: JsonRecord, key: string, allowed: readonly T[], label: string): T | undefined {
  return value[key] === undefined ? undefined : enumField(value, key, allowed, label);
}

function optionalDate(value: JsonRecord, key: string, label: string): string | undefined {
  const field = optionalString(value, key, label);
  if (field !== undefined && Number.isNaN(Date.parse(field))) schemaError(`${label}.${key} must be a date-time string.`);
  return field;
}

function parsePlanning(input: unknown): BacklogPlanningDetails {
  if (!record(input)) schemaError('backlog.planning must be an object.');
  exactKeys(input, ['priorityLevel', 'storyPoints', 'startDate', 'dueDate', 'description'], [], 'backlog.planning');
  return {
    ...(optionalEnum(input, 'priorityLevel', PRIORITY_LEVELS, 'backlog.planning') === undefined ? {} : { priorityLevel: optionalEnum(input, 'priorityLevel', PRIORITY_LEVELS, 'backlog.planning') }),
    ...(optionalNumber(input, 'storyPoints', 'backlog.planning') === undefined ? {} : { storyPoints: optionalNumber(input, 'storyPoints', 'backlog.planning') }),
    ...(optionalDate(input, 'startDate', 'backlog.planning') === undefined ? {} : { startDate: optionalDate(input, 'startDate', 'backlog.planning') }),
    ...(optionalDate(input, 'dueDate', 'backlog.planning') === undefined ? {} : { dueDate: optionalDate(input, 'dueDate', 'backlog.planning') }),
    ...(optionalDescription(input, 'description', 'backlog.planning') === undefined ? {} : { description: optionalDescription(input, 'description', 'backlog.planning') }),
  };
}

export function parseBacklogSidecar(input: unknown): BacklogSidecar {
  if (!record(input)) schemaError('Backlog sidecar must be an object.');
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) {
    throw new WorkflowError('unsupported_version', `Backlog sidecar schema version ${String(input.schemaVersion)} is not supported.`, 'Use backlog schema version 1 or 2.');
  }
  const version = input.schemaVersion;
  exactKeys(input, version === 2 ? ['schemaVersion', 'node', 'platform', 'sync', 'planning', 'meta'] : ['schemaVersion', 'node', 'platform', 'sync', 'meta'], ['schemaVersion', 'node', 'platform', 'sync', 'meta'], 'backlog');

  if (!record(input.node)) schemaError('backlog.node must be an object.');
  exactKeys(input.node, ['itemType', 'title', 'slug', 'origin'], ['itemType', 'title', 'slug', 'origin'], 'backlog.node');
  const node: BacklogNodeDetails = {
    itemType: enumField(input.node, 'itemType', ITEM_TYPES, 'backlog.node'),
    title: stringField(input.node, 'title', 'backlog.node'),
    slug: stringField(input.node, 'slug', 'backlog.node'),
    origin: enumField(input.node, 'origin', ORIGINS, 'backlog.node'),
  };

  if (!record(input.platform)) schemaError('backlog.platform must be an object.');
  const platformKeys = ['productId', 'itemId', 'key', 'parentItemId', 'remoteStatus', 'remoteUpdatedAt'];
  const platformExtended = ['remoteTitle', 'remoteDescriptionSha256', 'descriptionRevision', 'priorityLevel', 'storyPoints', 'startDate', 'dueDate'];
  exactKeys(input.platform, version === 2 ? [...platformKeys, ...platformExtended] : platformKeys, [], 'backlog.platform');
  const platform: BacklogPlatformDetails = {
    ...(optionalString(input.platform, 'productId', 'backlog.platform') === undefined ? {} : { productId: optionalString(input.platform, 'productId', 'backlog.platform') }),
    ...(optionalInteger(input.platform, 'itemId', 'backlog.platform') === undefined ? {} : { itemId: optionalInteger(input.platform, 'itemId', 'backlog.platform') }),
    ...(optionalString(input.platform, 'key', 'backlog.platform') === undefined ? {} : { key: optionalString(input.platform, 'key', 'backlog.platform') }),
    ...(input.platform.parentItemId === undefined ? {} : { parentItemId: input.platform.parentItemId === null ? null : optionalInteger(input.platform, 'parentItemId', 'backlog.platform') }),
    ...(optionalEnum(input.platform, 'remoteStatus', REMOTE_STATUSES, 'backlog.platform') === undefined ? {} : { remoteStatus: optionalEnum(input.platform, 'remoteStatus', REMOTE_STATUSES, 'backlog.platform') }),
    ...(optionalDate(input.platform, 'remoteUpdatedAt', 'backlog.platform') === undefined ? {} : { remoteUpdatedAt: optionalDate(input.platform, 'remoteUpdatedAt', 'backlog.platform') }),
    ...(version === 1 ? {} : {
      ...(optionalString(input.platform, 'remoteTitle', 'backlog.platform') === undefined ? {} : { remoteTitle: optionalString(input.platform, 'remoteTitle', 'backlog.platform') }),
      ...(optionalSha256(input.platform, 'remoteDescriptionSha256', 'backlog.platform') === undefined ? {} : { remoteDescriptionSha256: optionalSha256(input.platform, 'remoteDescriptionSha256', 'backlog.platform') }),
      ...(optionalInteger(input.platform, 'descriptionRevision', 'backlog.platform') === undefined ? {} : { descriptionRevision: optionalInteger(input.platform, 'descriptionRevision', 'backlog.platform') }),
      ...(optionalEnum(input.platform, 'priorityLevel', PRIORITY_LEVELS, 'backlog.platform') === undefined ? {} : { priorityLevel: optionalEnum(input.platform, 'priorityLevel', PRIORITY_LEVELS, 'backlog.platform') }),
      ...(optionalNumber(input.platform, 'storyPoints', 'backlog.platform') === undefined ? {} : { storyPoints: optionalNumber(input.platform, 'storyPoints', 'backlog.platform') }),
      ...(optionalDate(input.platform, 'startDate', 'backlog.platform') === undefined ? {} : { startDate: optionalDate(input.platform, 'startDate', 'backlog.platform') }),
      ...(optionalDate(input.platform, 'dueDate', 'backlog.platform') === undefined ? {} : { dueDate: optionalDate(input.platform, 'dueDate', 'backlog.platform') }),
    }),
  };
  if (platform.key !== undefined && !KEY_PATTERN.test(platform.key)) schemaError('backlog.platform.key must look like "NA-12".');
  if (platform.itemId !== undefined && platform.productId === undefined) schemaError('backlog.platform.productId is required when itemId is present.');

  if (!record(input.sync)) schemaError('backlog.sync must be an object.');
  const syncKeys = ['state', 'remoteChangeId', 'snapshotRevision', 'lastPushedRevision', 'lastError'];
  const syncExtended = ['lastPushedTitle', 'lastPushedDescriptionSha256', 'lastPushedPriorityLevel', 'lastPushedStoryPoints', 'lastPushedStartDate', 'lastPushedDueDate'];
  exactKeys(input.sync, version === 2 ? [...syncKeys, ...syncExtended] : syncKeys, ['state'], 'backlog.sync');
  const sync: BacklogSyncDetails = {
    state: enumField(input.sync, 'state', SYNC_STATES, 'backlog.sync'),
    ...(optionalString(input.sync, 'remoteChangeId', 'backlog.sync') === undefined ? {} : { remoteChangeId: optionalString(input.sync, 'remoteChangeId', 'backlog.sync') }),
    ...(optionalInteger(input.sync, 'snapshotRevision', 'backlog.sync') === undefined ? {} : { snapshotRevision: optionalInteger(input.sync, 'snapshotRevision', 'backlog.sync') }),
    ...(optionalInteger(input.sync, 'lastPushedRevision', 'backlog.sync') === undefined ? {} : { lastPushedRevision: optionalInteger(input.sync, 'lastPushedRevision', 'backlog.sync') }),
    ...(optionalString(input.sync, 'lastError', 'backlog.sync') === undefined ? {} : { lastError: optionalString(input.sync, 'lastError', 'backlog.sync') }),
    ...(version === 1 ? {} : {
      ...(optionalString(input.sync, 'lastPushedTitle', 'backlog.sync') === undefined ? {} : { lastPushedTitle: optionalString(input.sync, 'lastPushedTitle', 'backlog.sync') }),
      ...(optionalSha256(input.sync, 'lastPushedDescriptionSha256', 'backlog.sync') === undefined ? {} : { lastPushedDescriptionSha256: optionalSha256(input.sync, 'lastPushedDescriptionSha256', 'backlog.sync') }),
      ...(optionalEnum(input.sync, 'lastPushedPriorityLevel', PRIORITY_LEVELS, 'backlog.sync') === undefined ? {} : { lastPushedPriorityLevel: optionalEnum(input.sync, 'lastPushedPriorityLevel', PRIORITY_LEVELS, 'backlog.sync') }),
      ...(optionalNumber(input.sync, 'lastPushedStoryPoints', 'backlog.sync') === undefined ? {} : { lastPushedStoryPoints: optionalNumber(input.sync, 'lastPushedStoryPoints', 'backlog.sync') }),
      ...(optionalDate(input.sync, 'lastPushedStartDate', 'backlog.sync') === undefined ? {} : { lastPushedStartDate: optionalDate(input.sync, 'lastPushedStartDate', 'backlog.sync') }),
      ...(optionalDate(input.sync, 'lastPushedDueDate', 'backlog.sync') === undefined ? {} : { lastPushedDueDate: optionalDate(input.sync, 'lastPushedDueDate', 'backlog.sync') }),
    }),
  };
  const linked = sync.state === 'linked' || sync.state === 'diverged';
  if (linked && platform.itemId === undefined) schemaError('backlog.platform.itemId is required when sync.state is linked or diverged.');
  if (!linked && platform.itemId !== undefined) schemaError('backlog.platform.itemId must be absent unless sync.state is linked or diverged.');

  const planning = version === 2 && input.planning !== undefined ? parsePlanning(input.planning) : undefined;

  if (!record(input.meta)) schemaError('backlog.meta must be an object.');
  exactKeys(input.meta, ['createdAt', 'updatedAt', 'lastWriter'], ['createdAt', 'updatedAt'], 'backlog.meta');
  const createdAt = stringField(input.meta, 'createdAt', 'backlog.meta');
  const updatedAt = stringField(input.meta, 'updatedAt', 'backlog.meta');
  for (const field of [createdAt, updatedAt]) if (Number.isNaN(Date.parse(field))) schemaError('backlog.meta timestamps must be date-time strings.');
  const meta: BacklogMetaDetails = {
    createdAt,
    updatedAt,
    ...(optionalString(input.meta, 'lastWriter', 'backlog.meta') === undefined ? {} : { lastWriter: optionalString(input.meta, 'lastWriter', 'backlog.meta') }),
  };

  return { schemaVersion: BACKLOG_SCHEMA_VERSION, node, platform, sync, ...(planning === undefined ? {} : { planning }), meta };
}

export async function readBacklogSidecar(directory: string): Promise<BacklogSidecar | null> {
  try { return parseBacklogSidecar(JSON.parse(await readFile(path.join(directory, BACKLOG_SIDECAR), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function writeBacklogSidecar(directory: string, sidecar: BacklogSidecar): Promise<void> {
  await atomicWriteJson(path.join(directory, BACKLOG_SIDECAR), sidecar);
}

export function emptyBacklogSidecar(input: { itemType: BacklogItemType; title: string; slug?: string; origin?: BacklogOrigin; productId?: string; lastWriter?: string }): BacklogSidecar {
  const now = new Date().toISOString();
  return {
    schemaVersion: BACKLOG_SCHEMA_VERSION,
    node: { itemType: input.itemType, title: input.title, slug: input.slug ?? stableId(input.title), origin: input.origin ?? 'local' },
    platform: input.productId === undefined ? {} : { productId: input.productId },
    sync: { state: 'unlinked' },
    meta: { createdAt: now, updatedAt: now, ...(input.lastWriter === undefined ? {} : { lastWriter: input.lastWriter }) },
  };
}

export function withLinkedItem(sidecar: BacklogSidecar, platform: { productId: string; itemId: number; key?: string; parentItemId?: number | null; remoteStatus?: BacklogRemoteStatus; remoteUpdatedAt?: string; remoteTitle?: string; remoteDescriptionSha256?: string; descriptionRevision?: number; priorityLevel?: BacklogPriorityLevel; storyPoints?: number; startDate?: string; dueDate?: string; remoteChangeId?: string }, lastWriter?: string): BacklogSidecar {
  const now = new Date().toISOString();
  return {
    ...sidecar,
    platform: {
      ...sidecar.platform,
      productId: platform.productId,
      itemId: platform.itemId,
      ...(platform.key === undefined ? {} : { key: platform.key }),
      ...(platform.parentItemId === undefined ? {} : { parentItemId: platform.parentItemId }),
      ...(platform.remoteStatus === undefined ? {} : { remoteStatus: platform.remoteStatus }),
      ...(platform.remoteUpdatedAt === undefined ? {} : { remoteUpdatedAt: platform.remoteUpdatedAt }),
      ...(platform.remoteTitle === undefined ? {} : { remoteTitle: platform.remoteTitle }),
      ...(platform.remoteDescriptionSha256 === undefined ? {} : { remoteDescriptionSha256: platform.remoteDescriptionSha256 }),
      ...(platform.descriptionRevision === undefined ? {} : { descriptionRevision: platform.descriptionRevision }),
      ...(platform.priorityLevel === undefined ? {} : { priorityLevel: platform.priorityLevel }),
      ...(platform.storyPoints === undefined ? {} : { storyPoints: platform.storyPoints }),
      ...(platform.startDate === undefined ? {} : { startDate: platform.startDate }),
      ...(platform.dueDate === undefined ? {} : { dueDate: platform.dueDate }),
    },
    sync: { ...sidecar.sync, state: 'linked', ...(platform.remoteChangeId === undefined ? {} : { remoteChangeId: platform.remoteChangeId }) },
    meta: { ...sidecar.meta, updatedAt: now, ...(lastWriter === undefined ? {} : { lastWriter }) },
  };
}

export function withObservedPlatform(sidecar: BacklogSidecar, observed: { key?: string; parentItemId?: number | null; remoteStatus?: BacklogRemoteStatus; remoteUpdatedAt?: string; remoteTitle?: string; remoteDescriptionSha256?: string; descriptionRevision?: number; priorityLevel?: BacklogPriorityLevel; storyPoints?: number; startDate?: string; dueDate?: string }, lastWriter?: string): BacklogSidecar {
  return {
    ...sidecar,
    platform: {
      ...sidecar.platform,
      ...(observed.key === undefined ? {} : { key: observed.key }),
      ...(observed.parentItemId === undefined ? {} : { parentItemId: observed.parentItemId }),
      ...(observed.remoteStatus === undefined ? {} : { remoteStatus: observed.remoteStatus }),
      ...(observed.remoteUpdatedAt === undefined ? {} : { remoteUpdatedAt: observed.remoteUpdatedAt }),
      ...(observed.remoteTitle === undefined ? {} : { remoteTitle: observed.remoteTitle }),
      ...(observed.remoteDescriptionSha256 === undefined ? {} : { remoteDescriptionSha256: observed.remoteDescriptionSha256 }),
      ...(observed.descriptionRevision === undefined ? {} : { descriptionRevision: observed.descriptionRevision }),
      ...(observed.priorityLevel === undefined ? {} : { priorityLevel: observed.priorityLevel }),
      ...(observed.storyPoints === undefined ? {} : { storyPoints: observed.storyPoints }),
      ...(observed.startDate === undefined ? {} : { startDate: observed.startDate }),
      ...(observed.dueDate === undefined ? {} : { dueDate: observed.dueDate }),
    },
    meta: { ...sidecar.meta, updatedAt: new Date().toISOString(), ...(lastWriter === undefined ? {} : { lastWriter }) },
  };
}

export function withPlanning(sidecar: BacklogSidecar, planning: BacklogPlanningDetails, lastWriter?: string): BacklogSidecar {
  return {
    ...sidecar,
    planning: { ...(sidecar.planning ?? {}), ...planning },
    meta: { ...sidecar.meta, updatedAt: new Date().toISOString(), ...(lastWriter === undefined ? {} : { lastWriter }) },
  };
}

export function withBaselines(sidecar: BacklogSidecar, baselines: Partial<Pick<BacklogSyncDetails, 'lastPushedTitle' | 'lastPushedDescriptionSha256' | 'lastPushedPriorityLevel' | 'lastPushedStoryPoints' | 'lastPushedStartDate' | 'lastPushedDueDate'>>, lastWriter?: string): BacklogSidecar {
  return {
    ...sidecar,
    sync: { ...sidecar.sync, ...baselines },
    meta: { ...sidecar.meta, updatedAt: new Date().toISOString(), ...(lastWriter === undefined ? {} : { lastWriter }) },
  };
}

export function itemTypeRank(itemType: BacklogItemType): number {
  return ITEM_TYPE_RANK[itemType];
}

/** EPIC > STORY > TASK > SUBTASK; standalone roots have no parent. */
export function canParent(parent: BacklogItemType, child: BacklogItemType): boolean {
  return ITEM_TYPE_RANK[child] === ITEM_TYPE_RANK[parent] + 1;
}

export function deriveLocalNodeStatus(input: { closed: boolean; ownTasks: Array<{ status: 'pending' | 'in_progress' | 'completed' }>; children: LocalNodeStatus[] }): LocalNodeStatus {
  if (input.closed) return 'done';
  if (input.children.length) {
    if (input.children.every(status => status === 'done')) return 'in_review';
    if (input.children.some(status => status !== 'open')) return 'in_progress';
    return 'open';
  }
  if (!input.ownTasks.length) return 'open';
  if (input.ownTasks.every(task => task.status === 'completed')) return 'in_review';
  if (input.ownTasks.some(task => task.status !== 'pending')) return 'in_progress';
  return 'open';
}

export function mapLocalToRemoteStatus(status: LocalNodeStatus): BacklogRemoteStatus {
  return ({ open: 'TODO', in_progress: 'IN_PROGRESS', in_review: 'IN_REVIEW', done: 'DONE' } as const)[status];
}
