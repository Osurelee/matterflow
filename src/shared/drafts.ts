/**
 * M4-03 本机草稿（PRD 7.2、技术设计 5.2、AT-30）。
 *
 * 契约：
 * - 草稿键包含 userId 与 draftId：编辑事项用 `taskId`，新建捕获用 `captureDraftId`，
 *   避免多份记录互相覆盖；读取时校验 userId，防止换账号后串用。
 * - 草稿保存的是「编辑中」的内容（标题、正文、安排、未完成上传标识），
 *   它不是服务端保存，也不构成离线写队列：不自动重放、不冒充同步成功。
 * - 恢复前比较服务器版本：一致则恢复；服务器已前进则保留双方并在界面上让用户选择，
 *   绝不静默覆盖。
 * - 成功保存后清理该事项草稿；退出账号时按 userId 清理全部私有草稿。
 *
 * 本模块不依赖 React；IndexedDB 通过 DraftBackend 注入，便于用内存后端做纯逻辑测试。
 */

export const DRAFT_SCHEMA_VERSION = 1;
export const DRAFT_KEY_PREFIX = 'tasks.draft.v1';
/** 单份草稿上限；超出则不落盘并在界面明说，按技术设计「录音 blob 按实际可用容量保存」的保守起点。 */
export const DRAFT_MAX_BYTES = 256 * 1024;

export type PendingUpload = { kind: 'image' | 'audio' | 'file'; localId: string; note?: string };

export type DraftFields = {
  title: string;
  description: string;
  descriptionFormat: string;
  priority: string;
  plannedDate: string;
  dueDate: string;
  followUpDate: string;
  nextAction: string;
  blockedReason: string;
  pendingUploads: PendingUpload[];
};

export type TaskDraft = DraftFields & {
  schemaVersion: number;
  kind: 'task';
  userId: string;
  taskId: string;
  /** 草稿所基于的服务端版本；保存冲突判断的唯一依据 */
  baseVersion: number;
  updatedAt: string;
};

export type CaptureMediaDraftAsset = {assetId:string;originalName:string;mimeType:string;byteSize:number;kind:'image'|'file'|'audio';contentUrl:string};
export type CaptureDraft = DraftFields & {
  schemaVersion: number;
  kind: 'capture';
  userId: string;
  captureDraftId: string;
  updatedAt: string;
  sourceUrl?:string;
  sourceLabel?:string;
  captureMode?:'single'|'multiple';
  multiText?:string;
  previewRows?:string[];
  captureAudioAssetIds?:string[];
  mediaAssets?:CaptureMediaDraftAsset[];
  spaceId?:string;
  projectId?:string;
};

export type LocalDraft = TaskDraft | CaptureDraft;

/** 「编辑中」的字段，不包含进展/状态原因（那些仍靠离开确认保护）。 */
export const DRAFT_FIELD_KEYS: readonly (keyof DraftFields)[] = [
  'title', 'description', 'descriptionFormat', 'priority', 'plannedDate', 'dueDate', 'followUpDate', 'nextAction', 'blockedReason',
];

export function taskDraftKey(userId: string, taskId: string): string {
  return `${DRAFT_KEY_PREFIX}|${userId}|task|${taskId}`;
}

export function captureDraftKey(userId: string, captureDraftId: string): string {
  return `${DRAFT_KEY_PREFIX}|${userId}|capture|${captureDraftId}`;
}

export function userDraftKeyPrefix(userId: string): string {
  return `${DRAFT_KEY_PREFIX}|${userId}|`;
}

export function draftKeyOf(draft: LocalDraft): string {
  return draft.kind === 'task' ? taskDraftKey(draft.userId, draft.taskId) : captureDraftKey(draft.userId, draft.captureDraftId);
}

/** 只比较用户可编辑的内容字段；未完成上传标识不参与「是否有未提交内容」判断。 */
export function draftFieldsEqual(left: DraftFields, right: DraftFields): boolean {
  return DRAFT_FIELD_KEYS.every((key) => left[key] === right[key]);
}

export function emptyDraftFields(): DraftFields {
  return {
    title: '', description: '', descriptionFormat: 'plaintext', priority: 'none',
    plannedDate: '', dueDate: '', followUpDate: '', nextAction: '', blockedReason: '', pendingUploads: [],
  };
}

export type DraftDecision =
  | { action: 'none' }
  | { action: 'discard'; reason: 'identical' | 'invalid-version' }
  | { action: 'restore'; draft: TaskDraft }
  | { action: 'conflict'; draft: TaskDraft; serverVersion: number };

/**
 * 恢复决策（技术设计 5.2、PRD 7.2）：
 * - 内容与服务端完全一致 → 丢弃（没有可恢复的内容）；
 * - 基准版本等于服务端版本 → 直接恢复；
 * - 服务器已前进（或草稿版本异常） → 冲突，保留双方交给用户决定。
 */
export function decideTaskDraft(input: { draft: TaskDraft | null; serverVersion: number; serverFields: DraftFields }): DraftDecision {
  const { draft } = input;
  if (!draft) return { action: 'none' };
  if (draft.schemaVersion !== DRAFT_SCHEMA_VERSION) return { action: 'discard', reason: 'invalid-version' };
  if (draftFieldsEqual(draft, input.serverFields)) return { action: 'discard', reason: 'identical' };
  if (draft.baseVersion === input.serverVersion) return { action: 'restore', draft };
  return { action: 'conflict', draft, serverVersion: input.serverVersion };
}

export function serializeDraft(draft: LocalDraft): string {
  return JSON.stringify(draft);
}

const DRAFT_STRING_KEYS = ['title', 'description', 'descriptionFormat', 'priority', 'plannedDate', 'dueDate', 'followUpDate', 'nextAction', 'blockedReason'];

function hasDraftFieldShape(record: Record<string, unknown>): boolean {
  if (!DRAFT_STRING_KEYS.every((key) => typeof record[key] === 'string')) return false;
  return Array.isArray(record.pendingUploads) && record.pendingUploads.every((item)=>Boolean(item&&typeof item==='object'&&['image','audio','file'].includes(String((item as Record<string,unknown>).kind))&&typeof (item as Record<string,unknown>).localId==='string'));
}

/** 解析并做归属校验：schemaVersion 不符或 userId 不符一律视为无效草稿（返回 null）。 */
export function parseDraft(raw: string | null, expectedUserId: string): LocalDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== DRAFT_SCHEMA_VERSION) return null;
  if (record.userId !== expectedUserId) return null;
  if (!hasDraftFieldShape(record)) return null;
  const fields = record as unknown as DraftFields;
  if (record.kind === 'task') {
    if (typeof record.taskId !== 'string' || typeof record.baseVersion !== 'number' || typeof record.updatedAt !== 'string') return null;
    return { ...fields, schemaVersion: DRAFT_SCHEMA_VERSION, kind: 'task', userId: expectedUserId, taskId: record.taskId, baseVersion: record.baseVersion, updatedAt: record.updatedAt };
  }
  if (record.kind === 'capture') {
    if (typeof record.captureDraftId !== 'string' || typeof record.updatedAt !== 'string') return null;
    const mediaAssets=Array.isArray(record.mediaAssets)?record.mediaAssets.filter((item)=>item&&typeof item==='object'&&typeof (item as Record<string,unknown>).assetId==='string'&&typeof (item as Record<string,unknown>).originalName==='string'&&typeof (item as Record<string,unknown>).mimeType==='string'&&typeof (item as Record<string,unknown>).byteSize==='number'&&['image','file','audio'].includes(String((item as Record<string,unknown>).kind))&&typeof (item as Record<string,unknown>).contentUrl==='string') as CaptureMediaDraftAsset[]:[];
    const stringArray=(value:unknown)=>Array.isArray(value)&&value.every(item=>typeof item==='string')?value as string[]:[];
    return { ...fields, schemaVersion: DRAFT_SCHEMA_VERSION, kind: 'capture', userId: expectedUserId, captureDraftId: record.captureDraftId, updatedAt: record.updatedAt,
      ...(typeof record.sourceUrl==='string'?{sourceUrl:record.sourceUrl}:{}),...(typeof record.sourceLabel==='string'?{sourceLabel:record.sourceLabel}:{}),...(record.captureMode==='single'||record.captureMode==='multiple'?{captureMode:record.captureMode}:{}),...(typeof record.multiText==='string'?{multiText:record.multiText}:{}),...(Array.isArray(record.previewRows)?{previewRows:stringArray(record.previewRows)}:{}),...(Array.isArray(record.captureAudioAssetIds)?{captureAudioAssetIds:stringArray(record.captureAudioAssetIds)}:{}),...(Array.isArray(record.mediaAssets)?{mediaAssets}:{}),...(typeof record.spaceId==='string'?{spaceId:record.spaceId}:{}),...(typeof record.projectId==='string'?{projectId:record.projectId}:{}) };
  }
  return null;
}

/* -------------------------------------------------- 存储后端 */

export type DraftBackend = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

export function isDraftStorageSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** 浏览器 IndexedDB 后端；打开失败由上层降级为「本机无法保存草稿」。 */
export function createIndexedDbDraftBackend(databaseName = 'tasks-local-drafts', storeName = 'drafts'): DraftBackend {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => { const database = request.result; if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_OPEN_FAILED'));
      request.onblocked = () => reject(new Error('INDEXEDDB_BLOCKED'));
    });
    return opening;
  };
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const database = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = work(transaction.objectStore(storeName));
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_ABORTED'));
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_ERROR'));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_REQUEST_FAILED'));
    });
  };
  return {
    async get(key) { const value = await run<string | undefined>('readonly', (store) => store.get(key)); return value ?? null; },
    async put(key, value) { await run<unknown>('readwrite', (store) => store.put(value, key)); },
    async delete(key) { await run<unknown>('readwrite', (store) => store.delete(key)); },
    async keys() { const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys()); return keys.map((key) => String(key)); },
  };
}

/** 内存后端：测试与「无 IndexedDB」环境的替代实现。 */
export function createMemoryDraftBackend(initial?: Record<string, string>): DraftBackend {
  const table = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async get(key) { return table.has(key) ? table.get(key)! : null; },
    async put(key, value) { table.set(key, value); },
    async delete(key) { table.delete(key); },
    async keys() { return [...table.keys()]; },
  };
}

export type SaveDraftResult = 'saved' | 'too-large' | 'unavailable';

export type DraftStore = {
  save(draft: LocalDraft): Promise<SaveDraftResult>;
  loadTask(userId: string, taskId: string): Promise<TaskDraft | null>;
  loadCapture(userId: string, captureDraftId: string): Promise<CaptureDraft | null>;
  removeTask(userId: string, taskId: string): Promise<void>;
  removeCapture(userId: string, captureDraftId: string): Promise<void>;
  /** 退出账号时清理该账号的全部私有草稿；返回清理条数。 */
  clearUser(userId: string): Promise<number>;
};

export function createDraftStore(backend: DraftBackend): DraftStore {
  const guard = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await work(); } catch { return fallback; }
  };
  return {
    async save(draft) {
      const serialized = serializeDraft(draft);
      if (new TextEncoder().encode(serialized).byteLength > DRAFT_MAX_BYTES) return 'too-large';
      try {
        await backend.put(draftKeyOf(draft), serialized);
        return 'saved';
      } catch {
        return 'unavailable';
      }
    },
    async loadTask(userId, taskId) {
      const raw = await guard(() => backend.get(taskDraftKey(userId, taskId)), null);
      const parsed = parseDraft(raw, userId);
      return parsed && parsed.kind === 'task' ? parsed : null;
    },
    async loadCapture(userId, captureDraftId) {
      const raw = await guard(() => backend.get(captureDraftKey(userId, captureDraftId)), null);
      const parsed = parseDraft(raw, userId);
      return parsed && parsed.kind === 'capture' ? parsed : null;
    },
    async removeTask(userId, taskId) {
      await guard(async () => { await backend.delete(taskDraftKey(userId, taskId)); }, undefined);
    },
    async removeCapture(userId, captureDraftId) {
      await guard(async () => { await backend.delete(captureDraftKey(userId, captureDraftId)); }, undefined);
    },
    async clearUser(userId) {
      const prefix = userDraftKeyPrefix(userId);
      const keys = await guard(() => backend.keys(), [] as string[]);
      const mine = keys.filter((key) => key.startsWith(prefix));
      for (const key of mine) await guard(async () => { await backend.delete(key); }, undefined);
      return mine.length;
    },
  };
}
