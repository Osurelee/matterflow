'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BODY_MAX_CODE_POINTS, codePointLength, escapePlaintextToMarkdown, parseBody, renderSafeHtml } from '@/domain/body';
import RichBodyEditor, { type RichBodyEditorHandle } from '@/components/RichBodyEditor';
import TaskAttachments from '@/components/TaskAttachments';
import AudioRecorder from '@/components/AudioRecorder';
import CaptureComposer, { type CaptureComposerHandle } from '@/components/CaptureComposer';
import CaptureAttachments, { type CaptureAttachmentsHandle } from '@/components/CaptureAttachments';
import TaskTreePanel from '@/components/TaskTreePanel';
import TaskReferencesPanel from '@/components/TaskReferencesPanel';
import ChecklistPromotionPanel from '@/components/ChecklistPromotionPanel';
import EnableProjectPanel from '@/components/EnableProjectPanel';
import ProjectTreePanel from '@/components/ProjectTreePanel';
import { DatesEditor, HandlingEditor, PriorityEditor, StatusEditor, type AttrKind, type AttrPayload, type AttrSaveResult, type AttrTask } from '@/components/TaskAttributeEditors';
import { checklistCounts, staticChecklistLines, uncheckedCompletionWarning } from '@/domain/checklist';
import { createDraftStore, createIndexedDbDraftBackend, decideTaskDraft, emptyDraftFields, isDraftStorageSupported, type CaptureDraft, type CaptureMediaDraftAsset, type DraftFields, type PendingUpload, type TaskDraft } from '@/shared/drafts';
import { apiFetch, apiUrl } from '@/shared/api';
import styles from './page.module.css';

type View = 'inbox' | 'today' | 'overdue' | 'followup' | 'doing' | 'delegated' | 'waiting' | 'watched' | 'all' | 'archived' | 'trash';
type ReviewKind = 'unprocessed' | 'waiting' | 'project_next_action' | 'completed' | 'cancelled';
type TaskPathPart = { id: string; title: string };
type SearchMatch = { type: string; text?: string; name?: string; occurredAt?: string };
type TaskItem = {
  id: string; title: string; status: string; isProcessed: boolean; spaceId: string; spaceName: string;
  projectId: string | null; sectionId: string | null; parentId:string|null; structureVersion:number; spaceStructureVersion:number; projectRootTaskId?:string|null; isProjectRoot?:boolean; priority: string; handlingMode: string; counterpartName: string;
  plannedDate: string | null; dueDate: string | null; followUpDate: string | null;
  risk?: { overdue: boolean; followUpDue: boolean; plannedDue: boolean };
  createdAt: string; updatedAt: string; version: number; archivedAt?: string | null; deletedAt?: string | null; deletionBatchId?: string | null;
  path?: TaskPathPart[]; matches?: SearchMatch[]; reviewKind?: string; resultNote?: string; cancellationReason?: string; completedAt?: string | null; cancelledAt?: string | null;
  sourceUrl?: string | null; sourceLabel?: string | null;
};
type SpaceItem = { id: string; name: string; isDefault: boolean; archived: boolean; version: number; projectCount: number; taskCount: number };
type ProjectItem = { id: string; spaceId: string; spaceName: string; name: string; rootTaskId:string|null; status:string; isPaused:boolean; archived: boolean; version: number; counts: { active: number; completed: number; cancelled: number } };
const viewNames: Record<string, string> = { inbox: '收件箱', today: '今天', overdue: '已逾期', followup: '待跟进', doing: '我要做', delegated: '交给别人', waiting: '等待中', watched: '我关注的', all: '全部事项', archived: '已归档', trash: '回收站' };
const viewEmptyText: Record<string, string> = { inbox: '收件箱已清空', today: '今天没有到期或跟进的安排', overdue: '没有已逾期事项', followup: '没有待跟进事项', doing: '没有由本人处理的事项', delegated: '没有交给别人的事项', waiting: '没有等待中的事项', watched: '没有关注的事项', all: '还没有事项', archived: '没有已归档事项', trash: '回收站为空' };
const riskLabels: Array<[keyof NonNullable<TaskItem['risk']>, string]> = [['overdue','已逾期'],['followUpDue','跟进到期'],['plannedDue','计划已到']];
const navGlyphs: Record<string,string> = { inbox:'▦', today:'◷', overdue:'!', followup:'↻', doing:'✎', delegated:'⇢', waiting:'◌', watched:'◎', all:'◉', archived:'▤', trash:'⌫' };
type TaskDetail = TaskItem & { descriptionFormat:string; description:string; sourceUrl:string|null; sourceLabel:string|null; waitingReason:string; cancellationReason:string; completedAt:string|null; cancelledAt:string|null; plannedDate:string|null; dueDate:string|null; followUpDate:string|null; nextAction:string; blockedReason:string; resultNote:string };
type ApiEnvelope<T> = { data: T; requestId: string };
type ApiFailure = { error?: { code?: string; message?: string; current?: TaskDetail; currentVersion?: number; fieldErrors?: Record<string,string> } };
type LifecycleOperation = 'archive' | 'delete';
type LifecycleDialogState = { operation: LifecycleOperation; scope: 'single' | 'subtree'; step: 'save' | 'confirm'; expectedVersion?: number };
type PagedTaskResult = { items?: unknown[]; total?: number; limit?: number; offset?: number; [key: string]: unknown };

type TaskEvent = { id:string; type:string; actorUserId:string; occurredAt:string; requestId:string|null; payload:Record<string,unknown> };
const eventNames:Record<string,string>={task_created:'创建事项',task_updated:'更新字段',task_transitioned:'状态流转',task_processed_marked:'标记已整理',task_delegated:'委托',task_delegation_changed:'更换受托人',task_delegation_ended:'结束委托',task_recall_requested:'收回自己处理',task_archived:'归档',task_unarchived:'取消归档',task_deleted:'删除',task_restored:'恢复',task_progress_appended:'追加进展'};
const fieldNames:Record<string,string>={status:'状态',title:'标题',description:'正文',priority:'优先级',plannedDate:'计划日期',dueDate:'截止日期',followUpDate:'跟进日期',nextAction:'下一步',blockedReason:'阻塞原因',waitingReason:'等待原因',cancellationReason:'取消原因',resultNote:'结果说明',action:'行动方',archivedAt:'归档'};
const matchNames:Record<string,string>={title:'标题',body:'正文',progress:'进展',handler:'处理方',attachment:'附件'};
function formatEventValue(key:string,value:unknown) {
  if(key==='status'&&typeof value==='string') return statusNames[value]??value;
  if(value===null||value===undefined||value==='') return '空';
  if(typeof value==='object') return JSON.stringify(value);
  const text=String(value);
  return text.length>40?`${text.slice(0,40)}…`:text;
}
function eventDetail(event:TaskEvent) {
  if(event.type==='task_progress_appended') return String(event.payload.text??'');
  const bodyPayload=event.payload.body as {format?:string;length?:number}|undefined;
  const bodySummary=bodyPayload?('正文：第 '+(event.payload.version??'?')+' 版，'+(bodyPayload.length??0)+' 字（'+(bodyPayload.format==='markdown_v1'?'Markdown':'纯文本')+'）'):'';
  const changes=event.payload.changes as Record<string,{from:unknown;to:unknown}>|undefined;
  if(!changes) return bodySummary;
  if(event.type==='task_created'&&'title' in changes) return String(changes.title?.to??'');
  const summary=Object.entries(changes).map(([key,value])=>`${fieldNames[key]??key}：${formatEventValue(key,value?.from)} → ${formatEventValue(key,value?.to)}`).join('；');
  return [summary,bodySummary].filter(Boolean).join('；');
}
const statusNames: Record<string,string> = { todo: '待处理', in_progress: '进行中', waiting: '等待中', done: '已完成', cancelled: '已取消' };
const nextStatuses:Record<string,string[]>={todo:['in_progress','waiting','done','cancelled'],in_progress:['todo','waiting','done','cancelled'],waiting:['todo','in_progress','done','cancelled'],done:['todo'],cancelled:['todo']};
function dateLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' }).format(date);
}
async function readError(response: Response) {
  const body = await response.json().catch(() => ({})) as ApiFailure;
  return body.error?.message ?? `请求失败（${response.status}）`;
}

/** 快速捕获：从 Markdown 正文首行派生标题（去掉块级标记与行内格式，最多 200 码点）。 */
function deriveCaptureTitle(md: string): string {
  const line = md.split(/\r?\n/).find((l) => l.trim());
  if (!line) return '';
  const cleaned = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^\[[ xX]\]\s?/, '')
    .replace(/^(\d{1,9})[.)]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim();
  return [...cleaned].slice(0, 200).join('');
}

/** 来源信息通过链接识别：优先取 Markdown 链接 `[标签](url)`，其次裸 http(s) 链接。 */
function detectCaptureSource(md: string): { url?: string; label?: string } {
  const link = /!?\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/i.exec(md);
  if (link) return { url: link[2].trim().replace(/[)}\\]+$/, ''), label: link[1].trim() || undefined };
  const bare = /(https?:\/\/[^\s<>]+)/i.exec(md);
  if (bare) return { url: bare[1].trim().replace(/[.,;:!?"'）]+$/, ''), label: undefined };
  return {};
}

function InboxPage({ onSignOut, onUnauthorized }: { onSignOut: () => void; onUnauthorized: () => void }) {
  const [view, setView] = useState<View>('inbox');
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [spaceFilter, setSpaceFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [handlingMode, setHandlingMode] = useState('self');
  const [counterpartName, setCounterpartName] = useState('');
  const [handlingSaving, setHandlingSaving] = useState(false);
  const [placementSpace, setPlacementSpace] = useState('');
  const [placementProject, setPlacementProject] = useState('');
  const [placementSection, setPlacementSection] = useState('');
  const [projectSections, setProjectSections] = useState<Array<{ id: string; name: string; sortKey: string; version: number; taskCount: number }>>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [sectionSaving, setSectionSaving] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  const [sectionManaging, setSectionManaging] = useState(false);
  const [placementSaving, setPlacementSaving] = useState(false);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchItems, setSearchItems] = useState<TaskItem[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [reviewKind, setReviewKind] = useState<ReviewKind | null>(null);
  const [reviewItems, setReviewItems] = useState<TaskItem[]>([]);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewOffset, setReviewOffset] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState('');
  const [exportError, setExportError] = useState('');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<TaskItem | null>(null);
  const [attributePopover, setAttributePopover] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailTitle, setDetailTitle] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailSaving, setDetailSaving] = useState(false);
  const [lifecycleMenuOpen, setLifecycleMenuOpen] = useState(false);
  const [lifecycleDialog, setLifecycleDialog] = useState<LifecycleDialogState | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [detailChildCount, setDetailChildCount] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [transitionStatus, setTransitionStatus] = useState('');
  const [waitingReason, setWaitingReason] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [priority, setPriority] = useState('none');
  const [plannedDate, setPlannedDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [resultNote, setResultNote] = useState('');
  const [planningSaving, setPlanningSaving] = useState(false);
  const [description, setDescription] = useState('');
  const [descriptionFormat, setDescriptionFormat] = useState<string>('plaintext');
  const [bodyView, setBodyView] = useState<'visual' | 'source' | 'preview'>('visual');
  const [bodySaving, setBodySaving] = useState(false);
  const [bodyRevisions, setBodyRevisions] = useState<Array<{ id: string; format: string; content: string; taskVersion: number; createdAt: string }>>([]);
  const [bodyRevisionsOpen, setBodyRevisionsOpen] = useState(false);
  const [bodyRevisionsLoading, setBodyRevisionsLoading] = useState(false);
  const [userId, setUserId] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState('');
  const [draftUnsupported, setDraftUnsupported] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<{ draft: TaskDraft; kind: 'restored' | 'conflict'; serverVersion: number } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const draftStore = useMemo(() => createDraftStore(createIndexedDbDraftBackend()), []);
  const unsavedRef = useRef(false);
  const persistDraftRef = useRef<() => Promise<void>>(async () => undefined);
  const persistCaptureDraftRef = useRef<() => Promise<void>>(async () => undefined);
  const [checklist, setChecklist] = useState<Array<{ id: string; text: string; isChecked: boolean; version: number; sortKey: string }>>([]);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [checklistBusy, setChecklistBusy] = useState('');
  const [checklistText, setChecklistText] = useState('');
  const [checklistError, setChecklistError] = useState('');
  const [editingItemId, setEditingItemId] = useState('');
  const [editingText, setEditingText] = useState('');
  const [staticChecklistDismissed, setStaticChecklistDismissed] = useState(false);
  const [checklistImporting, setChecklistImporting] = useState(false);
  const checklistRequest = useRef<{ signature: string; requestId: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const richBodyEditorRef = useRef<RichBodyEditorHandle>(null);
  const bodyRequest = useRef<{ id: string; version: number; signature: string; requestId: string } | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [progressAudioAssetIds,setProgressAudioAssetIds]=useState<string[]>([]);
  const [progressAudioPending,setProgressAudioPending]=useState(false);
  const [progressCommitToken,setProgressCommitToken]=useState(0);
  const [captureAudioAssetIds,setCaptureAudioAssetIds]=useState<string[]>([]);
  const [captureAssets,setCaptureAssets]=useState<Array<{id:string;originalName:string;mimeType:string;byteSize:number;kind:'image'|'file'|'audio';contentUrl:string;previewUrl:string}>>([]);
  const [captureFilesPending,setCaptureFilesPending]=useState(false);
  const [captureNeedsReentry,setCaptureNeedsReentry]=useState(false);
  /** 快速捕获正文：Markdown 源文本（新捕获一律 markdown_v1）。 */
  const [captureBody,setCaptureBody]=useState('');
  const [captureComposing,setCaptureComposing]=useState(false);
  const [captureMultiText,setCaptureMultiText]=useState('');
  const [capturePreviewRows,setCapturePreviewRows]=useState<string[]>([]);
  const [captureBatchBusy,setCaptureBatchBusy]=useState(false);
  const [captureBatchOpen,setCaptureBatchOpen]=useState(false);
  const [captureUndo,setCaptureUndo]=useState<{taskId:string;version:number;label:string}|null>(null);
  const [captureUndoBusy,setCaptureUndoBusy]=useState(false);
  const [captureAudioPending,setCaptureAudioPending]=useState(false);
  const [captureCommitToken,setCaptureCommitToken]=useState(0);
  const [captureDraftId,setCaptureDraftId]=useState('');
  const [captureDraftReady,setCaptureDraftReady]=useState(false);
  const [captureDraftStatus,setCaptureDraftStatus]=useState('');
  const [captureDraftAvailable,setCaptureDraftAvailable]=useState<CaptureDraft|null>(null);
  const [captureMediaKey,setCaptureMediaKey]=useState(0);
  const [progressSaving, setProgressSaving] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [pendingMediaCount, setPendingMediaCount] = useState(0);
  const onAttachmentPendingChange = useCallback((count:number)=>setPendingMediaCount(count),[]);
  const onCaptureRecordingPending = useCallback((pending:boolean)=>{setCaptureAudioPending(pending);if(pending)setCaptureNeedsReentry(false)},[]);
  const onCaptureFilePending=useCallback((pending:boolean)=>{setCaptureFilesPending(pending);if(pending)setCaptureNeedsReentry(false)},[]);
  const onCaptureAssetsChange=useCallback((items:Array<{id:string;originalName:string;mimeType:string;byteSize:number;kind:'image'|'file'|'audio';contentUrl:string;previewUrl:string}>)=>setCaptureAssets(items),[]);
  const onCaptureAttachFiles=useCallback((files:File[])=>{captureAttachmentsRef.current?.addFiles(files)},[]);
  const onProgressRecordingPending = useCallback((pending:boolean)=>setProgressAudioPending(pending),[]);
  const [processingId, setProcessingId] = useState('');
  const [lifecycleActionId, setLifecycleActionId] = useState('');
  const [historyTask, setHistoryTask] = useState<TaskItem | null>(null);
  const captureComposerRef = useRef<CaptureComposerHandle>(null);
  const captureAttachmentsRef = useRef<CaptureAttachmentsHandle>(null);
  const captureMultiRef = useRef<HTMLTextAreaElement>(null);
  const audioRecorderRef = useRef<{ start: () => void } | null>(null);
  const createRequest = useRef<{title:string;id:string;placement:string;payloadSignature:string}|null>(null);
  const captureBatchRequest=useRef<{signature:string;requestId:string}|null>(null);
  const editRequest = useRef<{id:string;title:string;version:number;requestId:string}|null>(null);
  const progressRequest = useRef<{id:string;version:number;text:string;assetSignature:string;requestId:string}|null>(null);
  const handlingRequest = useRef<{id:string;version:number;mode:string;name:string;requestId:string}|null>(null);
  const placementRequest = useRef<{id:string;version:number;spaceId:string;projectId:string;requestId:string}|null>(null);
  const planningRequest = useRef<{id:string;version:number;signature:string;requestId:string}|null>(null);
  const transitionRequest = useRef<{id:string;version:number;status:string;waitingReason:string;cancellationReason:string;requestId:string}|null>(null);
  const processRequest = useRef<{id:string;version:number;requestId:string}|null>(null);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);

  const reviewNames: Record<ReviewKind, string> = { unprocessed: '未整理', waiting: '等待中', project_next_action: '项目下一步', completed: '已完成', cancelled: '已取消' };
  const normalizeTask = useCallback((value: unknown): TaskItem | null => {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? row.taskId ?? '');
    if (!id) return null;
    return {
      id, title: String(row.title ?? row.name ?? '未命名事项'), status: String(row.status ?? 'todo'),
      isProcessed: Boolean(row.isProcessed ?? row.processed ?? false), spaceId: String(row.spaceId ?? ''), spaceName: String(row.spaceName ?? row.space ?? '未分配空间'),
      projectId: row.projectId == null ? null : String(row.projectId), sectionId: row.sectionId == null ? null : String(row.sectionId), parentId: row.parentId == null ? null : String(row.parentId),
      structureVersion: Number(row.structureVersion ?? 0), spaceStructureVersion: Number(row.spaceStructureVersion ?? 0), projectRootTaskId: row.projectRootTaskId == null ? null : String(row.projectRootTaskId), isProjectRoot: Boolean(row.isProjectRoot),
      priority: String(row.priority ?? 'none'), handlingMode: String(row.handlingMode ?? 'self'), counterpartName: String(row.counterpartName ?? ''), plannedDate: row.plannedDate == null ? null : String(row.plannedDate), dueDate: row.dueDate == null ? null : String(row.dueDate), followUpDate: row.followUpDate == null ? null : String(row.followUpDate),
      risk: row.risk && typeof row.risk === 'object' ? { overdue: Boolean((row.risk as Record<string, unknown>).overdue), followUpDue: Boolean((row.risk as Record<string, unknown>).followUpDue), plannedDue: Boolean((row.risk as Record<string, unknown>).plannedDue) } : undefined,
      createdAt: String(row.createdAt ?? new Date().toISOString()), updatedAt: String(row.updatedAt ?? row.createdAt ?? new Date().toISOString()), version: Number(row.version ?? 0), archivedAt: row.archivedAt == null ? null : String(row.archivedAt), deletedAt: row.deletedAt == null ? null : String(row.deletedAt), deletionBatchId: row.deletionBatchId == null ? null : String(row.deletionBatchId),
      path: Array.isArray(row.path) ? row.path.filter((part): part is Record<string, unknown> => Boolean(part && typeof part === 'object')).map((part) => ({ id: String(part.id ?? ''), title: String(part.title ?? '') })).filter((part) => part.id && part.title) : undefined,
      matches: Array.isArray(row.matches) ? row.matches.filter((match): match is Record<string, unknown> => Boolean(match && typeof match === 'object')).map((match) => ({ type: String(match.type ?? ''), text: match.text == null ? undefined : String(match.text), name: match.name == null ? undefined : String(match.name), occurredAt: match.occurredAt == null ? undefined : String(match.occurredAt) })).filter((match) => match.type) : undefined,
      reviewKind: row.reviewKind == null ? undefined : String(row.reviewKind), resultNote: row.resultNote == null ? undefined : String(row.resultNote), cancellationReason: row.cancellationReason == null ? undefined : String(row.cancellationReason), completedAt: row.completedAt == null ? null : String(row.completedAt), cancelledAt: row.cancelledAt == null ? null : String(row.cancelledAt), sourceUrl: row.sourceUrl == null ? null : String(row.sourceUrl), sourceLabel: row.sourceLabel == null ? null : String(row.sourceLabel),
    };
  }, []);
  const parsePagedTasks = useCallback((body: unknown) => {
    const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const data = envelope.data && typeof envelope.data === 'object' ? envelope.data as PagedTaskResult : envelope as PagedTaskResult;
    const rawItems = Array.isArray(data.items) ? data.items : Array.isArray((data as Record<string, unknown>).results) ? (data as Record<string, unknown>).results as unknown[] : [];
    const deduped = rawItems.map(normalizeTask).filter((item): item is TaskItem => Boolean(item)).filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
    return { items: deduped, total: Number(data.total ?? deduped.length), limit: Number(data.limit ?? 50), offset: Number(data.offset ?? 0) };
  }, [normalizeTask]);

  const listQueryFor = useCallback((targetView: View, offset: number) => {
    const params = new URLSearchParams({ view: targetView, limit: '100', offset: String(offset) });
    if (projectFilter) params.set('projectId', projectFilter);
    else if (spaceFilter) params.set('spaceId', spaceFilter);
    if (targetView === 'all') params.set('includeEnded', 'true');
    return `/api/tasks?${params.toString()}`;
  }, [spaceFilter, projectFilter]);
  const listQuery = useCallback((offset: number) => listQueryFor(view, offset), [listQueryFor, view]);

  const clearSearch = useCallback(() => { setSearchInput(''); setSearchQuery(''); setSearchItems([]); setSearchTotal(0); setSearchOffset(0); setSearchError(''); }, []);
  const loadSearch = useCallback(async (query: string, offset = 0) => {
    const clean = query.trim();
    if (!clean) { clearSearch(); return; }
    setSearchLoading(true); setSearchError('');
    try {
      const response = await apiFetch(`/api/search?${new URLSearchParams({ q: clean, limit: '50', offset: String(offset) })}`);
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = parsePagedTasks(await response.json());
      setSearchQuery(clean); setSearchOffset(result.offset); setSearchTotal(result.total); setSearchItems(result.items);
    } catch (error) { setSearchError(error instanceof Error ? error.message : '搜索失败'); }
    finally { setSearchLoading(false); }
  }, [clearSearch, onUnauthorized, parsePagedTasks]);
  const loadReview = useCallback(async (kind: ReviewKind, offset = 0) => {
    setReviewKind(kind); setReviewLoading(true); setReviewError('');
    try {
      let response = await apiFetch(`/api/review?${new URLSearchParams({ kind, limit: '50', offset: String(offset) })}`);
      if (!response.ok && response.status === 400 && (kind === 'waiting' || kind === 'project_next_action')) {
        const legacyKind = kind === 'waiting' ? 'waiting_without_followup' : 'project_without_next_action';
        response = await apiFetch(`/api/review?${new URLSearchParams({ kind: legacyKind, limit: '50', offset: String(offset) })}`);
      }
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = parsePagedTasks(await response.json());
      setReviewOffset(result.offset); setReviewTotal(result.total); setReviewItems(result.items);
    } catch (error) { setReviewError(error instanceof Error ? error.message : '回顾加载失败'); }
    finally { setReviewLoading(false); }
  }, [onUnauthorized, parsePagedTasks]);
  const exportData = useCallback(async (format: 'json' | 'csv' | 'bundle') => {
    setExportBusy(format); setExportError('');
    try {
      const params = new URLSearchParams();
      if (projectFilter) params.set('projectId', projectFilter); else if (spaceFilter) params.set('spaceId', spaceFilter);
      if (!projectFilter && !spaceFilter && view) params.set('view', view);
      if (view === 'all') params.set('includeEnded', 'true');
      if (searchQuery) params.set('q', searchQuery);
      const response = await apiFetch(`/api/exports/${format}${params.toString() ? `?${params}` : ''}`);
      if (!response.ok) throw new Error(await readError(response));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `tasks-${new Date().toISOString().slice(0, 10)}.${format === 'bundle' ? 'zip' : format}`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      setNotice(`已开始下载 ${format.toUpperCase()} 导出`); setExportOpen(false);
    } catch (error) { setExportError(error instanceof Error ? error.message : '导出失败'); }
    finally { setExportBusy(''); }
  }, [projectFilter, searchQuery, spaceFilter, view]);

  const loadStructure = useCallback(async () => {
    try {
      const [spaceResponse, projectResponse] = await Promise.all([apiFetch('/api/spaces?includeArchived=true'), apiFetch('/api/projects')]);
      if (spaceResponse.status === 401 || projectResponse.status === 401) { onUnauthorized(); return; }
      if (spaceResponse.ok) { const body = await spaceResponse.json() as ApiEnvelope<{ items: SpaceItem[] }>; setSpaces(body.data.items.filter((item) => !item.archived)); }
      if (projectResponse.ok) { const body = await projectResponse.json() as ApiEnvelope<{ items: ProjectItem[] }>; setProjects(body.data.items); }
    } catch { /* 结构读取失败不阻塞事项列表 */ }
  }, [onUnauthorized]);
  useEffect(() => { void loadStructure(); }, [loadStructure]);

  useEffect(() => {
    const projectId = placementProject || projectFilter;
    if (!projectId) { setProjectSections([]); return; }
    let active = true; setSectionsLoading(true);
    void apiFetch(`/api/projects/${projectId}/sections`).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as ApiEnvelope<{ items: Array<{ id: string; name: string; sortKey: string; version: number; taskCount: number }> }>;
      if (active) setProjectSections(body.data.items);
    }).catch(() => { if (active) setProjectSections([]); }).finally(() => { if (active) setSectionsLoading(false); });
    return () => { active = false; };
  }, [placementProject, projectFilter]);

  const loadItems = useCallback(async () => {
    const sequence = ++listSequence.current;
    setLoading(true); setListError('');
    try {
      const response = await apiFetch(listQuery(0));
      if (!response.ok) {
        if (response.status === 401) onUnauthorized();
        throw new Error(await readError(response));
      }
      const body = await response.json() as ApiEnvelope<{items:TaskItem[];total:number}>;
      if (sequence === listSequence.current) { setItems(body.data.items.filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)); setTotal(body.data.total); }
    } catch (error) {
      if (sequence === listSequence.current) setListError(error instanceof Error ? error.message : '暂时无法读取事项');
    } finally { if (sequence === listSequence.current) setLoading(false); }
  }, [listQuery, onUnauthorized]);

  async function loadMoreItems() {
    if (loadingMore || items.length >= total) return;
    const requestedView = view; const requestedOffset = items.length; setLoadingMore(true);
    try {
      const response = await apiFetch(listQueryFor(requestedView, requestedOffset));
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const body = await response.json() as ApiEnvelope<{items:TaskItem[];total:number}>;
      if (requestedView === view) { setItems((current) => [...current,...body.data.items.filter((item, index, page) => page.findIndex((candidate) => candidate.id === item.id) === index && !current.some((existing) => existing.id === item.id))]); setTotal(body.data.total); }
    } catch (error) { setNotice(error instanceof Error ? error.message : '加载失败'); }
    finally { setLoadingMore(false); }
  }

  useEffect(() => { void loadItems(); }, [loadItems]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); captureComposerRef.current?.focus(); }
      if (event.key === 'Escape' && lifecycleDialog) { setLifecycleDialog(null); return; }
      if (event.key === 'Escape' && lifecycleMenuOpen) { setLifecycleMenuOpen(false); return; }
      if (event.key === 'Escape' && selected) closeDetail();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    let active = true;
    void apiFetch('/api/auth/me').then(async (response) => {
      if (!response.ok) return;
      const result = await response.json() as ApiEnvelope<{ id: string }>;
      if (active) setUserId(result.data?.id ?? '');
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(()=>{
    if(!userId)return;
    let active=true;const key=`tasks.captureDraftId.v1|${userId}`;let id='';
    try{id=sessionStorage.getItem(key)||'';if(!id){id=crypto.randomUUID();sessionStorage.setItem(key,id)}}catch{id=crypto.randomUUID()}
    setCaptureDraftId(id);
    void draftStore.loadCapture(userId,id).then(draft=>{
      if(!active)return;
      if(draft){if(captureDraftHasContent()){setCaptureDraftAvailable(draft);setCaptureDraftStatus('发现一份本机捕获草稿；可恢复，当前输入不会被覆盖。')}else{applyCaptureDraft(draft)}}
      setCaptureDraftReady(true);
    }).catch(()=>{if(active){setCaptureDraftReady(true);setCaptureDraftStatus('本机捕获草稿不可用')}});
    return()=>{active=false};
  },[userId,draftStore]);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) { if (unsavedRef.current) { event.preventDefault(); event.returnValue = ''; } }
    function onVisibility() { if (document.visibilityState === 'hidden' && unsavedRef.current) { void persistDraftRef.current(); void persistCaptureDraftRef.current(); } }
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  useEffect(() => { unsavedRef.current = hasUnsavedChanges(); });
  useEffect(() => { persistDraftRef.current = persistDraft; });
  useEffect(() => { persistCaptureDraftRef.current = persistCaptureDraft; });

  // 本机草稿：编辑停顿后写入，绝不冒充服务端保存（PRD 7.2）
  useEffect(() => {
    if (!detail || !userId || !hasUnsavedChanges()) return undefined;
    const handle = setTimeout(() => { void persistDraft(); }, 700);
    return () => clearTimeout(handle);
  }, [detail, userId, detailTitle, description, descriptionFormat, priority, plannedDate, dueDate, followUpDate, nextAction, blockedReason]);

  function applyCaptureDraft(draft:CaptureDraft){
    setCaptureBody(draft.description??'');setCaptureMultiText(draft.multiText??'');setCapturePreviewRows(draft.previewRows??[]);setCaptureAudioAssetIds(draft.captureAudioAssetIds??[]);setCaptureAssets((draft.mediaAssets??[]).map(asset=>({...asset,id:asset.assetId,previewUrl:''})));setCaptureNeedsReentry(draft.pendingUploads.some(item=>item.note?.includes('尚未上传')||item.note?.includes('尚未暂存')));setSpaceFilter(draft.spaceId??'');setProjectFilter(draft.projectId??'');setCaptureMediaKey(value=>value+1);setCaptureDraftAvailable(null);setCaptureDraftStatus(draft.pendingUploads.some(item=>item.note?.includes('尚未上传')||item.note?.includes('尚未暂存'))?'已恢复本机捕获草稿；未上传文件需重新选择，未暂存录音需重新录制。':'已恢复本机未提交捕获草稿。');
    captureComposerRef.current?.focus();
  }
  async function dismissAvailableCaptureDraft(){if(!captureDraftAvailable)return;if(userId)await draftStore.removeCapture(userId,captureDraftAvailable.captureDraftId);setCaptureDraftAvailable(null);setCaptureDraftStatus('已放弃旧捕获草稿；当前内容继续保留。')}

  function captureDraftHasContent(){return Boolean(captureBody.trim()||captureMultiText.trim()||capturePreviewRows.length||captureAudioAssetIds.length||captureAssets.length||captureFilesPending||captureAudioPending||captureNeedsReentry)}

  async function persistCaptureDraft():Promise<void>{
    if(!userId||!captureDraftId||!captureDraftReady||captureDraftAvailable||captureComposing)return;
    if(!captureDraftHasContent()){await draftStore.removeCapture(userId,captureDraftId);setCaptureDraftStatus('');return}
    if(!isDraftStorageSupported()){setCaptureDraftStatus('本机无法保存捕获草稿');return}
    const pendingUploads:PendingUpload[]=[...captureAudioAssetIds.map(localId=>({kind:'audio' as const,localId,note:'已上传暂存，待创建事项'})),...captureAssets.map(asset=>({kind:asset.kind,localId:asset.id,note:`已上传暂存：${asset.originalName}`})),...(captureFilesPending?[{kind:'file' as const,localId:'volatile-upload',note:'尚未上传；刷新后需重新选择'}]:[]),...(captureAudioPending?[{kind:'audio' as const,localId:'volatile-recording',note:'尚未暂存录音；刷新后需重新录制'}]:[]),...(captureNeedsReentry&&!captureFilesPending&&!captureAudioPending&&!captureAssets.length&&!captureAudioAssetIds.length?[{kind:'file' as const,localId:'restore-needed',note:'尚未上传媒体；请重新选择或录制'}]:[])];
    const mediaAssets:CaptureMediaDraftAsset[]=captureAssets.map(asset=>({assetId:asset.id,originalName:asset.originalName,mimeType:asset.mimeType,byteSize:asset.byteSize,kind:asset.kind,contentUrl:asset.contentUrl}));
    const detected=detectCaptureSource(captureBody);
    const draft:CaptureDraft={...emptyDraftFields(),schemaVersion:1,kind:'capture',userId,captureDraftId,title:deriveCaptureTitle(captureBody),description:captureBody,descriptionFormat:'markdown_v1',pendingUploads,updatedAt:new Date().toISOString(),sourceUrl:detected.url,sourceLabel:detected.label,multiText:captureMultiText,previewRows:capturePreviewRows,captureAudioAssetIds,mediaAssets,spaceId:spaceFilter,projectId:projectFilter};
    const result=await draftStore.save(draft);setCaptureDraftStatus(result==='saved'?'本机捕获草稿已保存（未提交）':result==='too-large'?'捕获草稿过大，本机无法保存':'本机捕获草稿不可用');
  }

  useEffect(()=>{if(!userId||!captureDraftId||!captureDraftReady||captureDraftAvailable)return;const timer=setTimeout(()=>{void persistCaptureDraft()},700);return()=>clearTimeout(timer)},[userId,captureDraftId,captureDraftReady,captureBody,captureComposing,captureMultiText,capturePreviewRows,captureAudioAssetIds,captureAssets,captureFilesPending,captureNeedsReentry,captureDraftAvailable,spaceFilter,projectFilter]);

  useEffect(()=>{
    if(!captureUndo)return;
    const timer=setTimeout(()=>setCaptureUndo(null),10000);
    return()=>clearTimeout(timer);
  },[captureUndo]);

  // 通知浮窗自动消失：有撤销动作时留久一点，其余 5s。
  useEffect(()=>{
    if(!notice)return;
    const timer=setTimeout(()=>setNotice(''), captureUndo ? 8000 : 5000);
    return()=>clearTimeout(timer);
  },[notice,captureUndo]);

  function rotateCaptureDraftId(){const next=crypto.randomUUID();try{if(userId)sessionStorage.setItem(`tasks.captureDraftId.v1|${userId}`,next)}catch{}setCaptureDraftId(next);setCaptureDraftStatus('');setCaptureDraftReady(true)}
  async function createTask(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const body = captureBody.trim();
    const assetIds=[...captureAssets.map(item=>item.id),...captureAudioAssetIds];
    const generatedPrefix=captureAudioAssetIds.length?'语音记录':captureAssets.some(item=>item.kind==='image')?'图片记录':'附件记录';
    const derivedTitle = deriveCaptureTitle(body);
    const clean = derivedTitle || (assetIds.length ? `${generatedPrefix} ${new Date().toISOString().slice(0,16).replace('T',' ')}` : '');
    if (!clean || creating || captureAudioPending || captureFilesPending || captureBatchBusy) return;
    const placementKey = projectFilter ? `project:${projectFilter}` : spaceFilter ? `space:${spaceFilter}` : 'private';
    const detected = detectCaptureSource(body);
    const payloadSignature=JSON.stringify({title:clean,placementKey,description:body,sourceUrl:detected.url,sourceLabel:detected.label,assetIds});
    if (!createRequest.current || createRequest.current.payloadSignature!==payloadSignature) createRequest.current = { title: clean, id: crypto.randomUUID(), placement: placementKey, payloadSignature };
    setCreating(true); setNotice('');
    try {
      const payload: Record<string, unknown> = { requestId: createRequest.current.id, title: clean, ...(body?{description:body,descriptionFormat:'markdown_v1'}:{}), ...(detected.url?{sourceUrl:detected.url}:{}), ...(detected.label?{sourceLabel:detected.label}:{}), ...(assetIds.length?{assetIds}:{}) };
      if (projectFilter) payload.projectId = projectFilter;
      else if (spaceFilter) payload.spaceId = spaceFilter;
      const response = await apiFetch('/api/captures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = await response.json() as ApiEnvelope<TaskItem>;
      createRequest.current = null; if(userId&&captureDraftId)await draftStore.removeCapture(userId,captureDraftId); setCaptureBody(''); setCaptureAudioAssetIds([]); setCaptureCommitToken((token)=>token+1); setCaptureAssets([]); setCaptureFilesPending(false); setCaptureBatchOpen(false); setCapturePreviewRows([]); setCaptureMultiText(''); rotateCaptureDraftId();
      setNotice(derivedTitle ? '已添加到收件箱' : '已添加媒体事项；临时标题可在详情中修改');
      setCaptureUndo({ taskId: result.data.id, version: result.data.version, label: clean });
      setView('inbox');
      captureComposerRef.current?.focus();
      if (view === 'inbox') await loadItems();
      else setItems((current) => [result.data, ...current]);
    } catch (error) { setNotice(error instanceof Error ? error.message : '保存失败，内容已保留'); }
    finally { setCreating(false); }
  }

  async function undoCapture(){
    const target=captureUndo;if(!target||captureUndoBusy)return;
    setCaptureUndoBusy(true);setNotice('');
    try{
      const response=await apiFetch(`/api/tasks/${target.taskId}/archive`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),expectedVersion:target.version,scope:'single'})});
      if(!response.ok){if(response.status===401)onUnauthorized();throw new Error(await readError(response))}
      setCaptureUndo(null);setNotice(`已撤销「${target.label.slice(0,20)}」；事项已移入归档，可恢复。`);await loadItems();
    }catch(error){setNotice(error instanceof Error?error.message:'撤销失败，可稍后在归档中处理')}
    finally{setCaptureUndoBusy(false)}
  }

  function previewCaptureBatch(){
    const rows=captureMultiText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if(!rows.length){setNotice('请先输入要拆分的多行事项');return}
    if(rows.length>50){setNotice('单批最多拆分50条事项');return}
    setCapturePreviewRows(rows);captureBatchRequest.current=null;setNotice('请检查预览；确认后才会创建事项。');
  }

  async function submitCaptureBatch(){
    if(!capturePreviewRows.length||captureBatchBusy)return;
    const placementKey=projectFilter?`project:${projectFilter}`:spaceFilter?`space:${spaceFilter}`:'private';
    const signature=JSON.stringify({rows:capturePreviewRows,placementKey});
    if(!captureBatchRequest.current||captureBatchRequest.current.signature!==signature)captureBatchRequest.current={signature,requestId:crypto.randomUUID()};
    setCaptureBatchBusy(true);setNotice('');
    try{
      const payload={requestId:captureBatchRequest.current.requestId,rows:capturePreviewRows.map(title=>({title})),...(projectFilter?{projectId:projectFilter}:spaceFilter?{spaceId:spaceFilter}:{})};
      const response=await apiFetch('/api/capture-batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok){if(response.status===401)onUnauthorized();throw new Error(await readError(response))}
      const result=await response.json() as ApiEnvelope<{items:TaskItem[]}>;captureBatchRequest.current=null;setCapturePreviewRows([]);setCaptureMultiText('');setCaptureBatchOpen(false);if(!captureAudioAssetIds.length&&!captureAssets.length&&!captureBody.trim()){if(userId&&captureDraftId)await draftStore.removeCapture(userId,captureDraftId);rotateCaptureDraftId()}setNotice(`已创建 ${result.data.items.length} 条事项（同批提交）`);setView('inbox');await loadItems();
    }catch(error){setNotice(error instanceof Error?error.message:'批量创建失败；预览内容已保留，可修正后重试')}
    finally{setCaptureBatchBusy(false)}
  }

  async function openDetail(item: TaskItem) {
    const sequence = ++detailSequence.current;
    setSelected(item); setDetail(null); setDetailTitle(item.title); setDetailError(''); setDetailLoading(true); setEvents([]); setEventsHasMore(false); setProgressText(''); setProgressAudioAssetIds([]); setProgressAudioPending(false); setProgressCommitToken((token)=>token+1); setDescription(''); setBodyRevisions([]); setBodyRevisionsOpen(false); bodyRequest.current = null; setRestoredDraft(null); setDraftSavedAt(''); setChecklist([]); setChecklistError(''); setStaticChecklistDismissed(false); setEditingItemId(''); checklistRequest.current = null; setLifecycleMenuOpen(false); setLifecycleDialog(null); setDetailChildCount(0);
    try {
      const response = await apiFetch(`/api/tasks/${item.id}`);
      if (sequence !== detailSequence.current) return;
      if (response.ok) {
        const result = await response.json() as ApiEnvelope<TaskDetail>;
        setDetail(result.data); setDetailTitle(result.data.title); setTransitionStatus(''); setWaitingReason(result.data.waitingReason); setCancellationReason(result.data.cancellationReason); setPriority(result.data.priority); setPlannedDate(result.data.plannedDate??''); setDueDate(result.data.dueDate??''); setFollowUpDate(result.data.followUpDate??''); setNextAction(result.data.nextAction); setBlockedReason(result.data.blockedReason); setResultNote(result.data.resultNote??''); setHandlingMode(result.data.handlingMode); setCounterpartName(result.data.counterpartName); setPlacementSpace(result.data.spaceId); setPlacementProject(result.data.projectId ?? ''); setPlacementSection(result.data.sectionId ?? ''); setDescription(result.data.description); setDescriptionFormat(result.data.descriptionFormat); setBodyView(result.data.descriptionFormat==='markdown_v1'?'visual':'source'); bodyRequest.current = null; await loadEvents(result.data.id); await loadChecklist(result.data.id);
        if (sequence === detailSequence.current && userId) {
          const localDraft = await draftStore.loadTask(userId, result.data.id);
          const decision = decideTaskDraft({ draft: localDraft, serverVersion: result.data.version, serverFields: serverDraftFields(result.data) });
          if (decision.action === 'discard') { await draftStore.removeTask(userId, result.data.id); setRestoredDraft(null); setDraftSavedAt(''); }
          else if (decision.action === 'restore') { applyDraftFields(decision.draft); setRestoredDraft({ draft: decision.draft, kind: 'restored', serverVersion: result.data.version }); setDraftSavedAt(decision.draft.updatedAt); }
          else if (decision.action === 'conflict') { setRestoredDraft({ draft: decision.draft, kind: 'conflict', serverVersion: result.data.version }); setDraftSavedAt(decision.draft.updatedAt); }
        }
      } else {
        if (response.status === 401) onUnauthorized();
        setDetailError(await readError(response));
      }
    } catch (error) { if (sequence === detailSequence.current) setDetailError(error instanceof Error ? error.message : '读取详情失败'); }
    finally { if (sequence === detailSequence.current) setDetailLoading(false); }
  }

  async function openTaskFromTree(id:string){if(!confirmLeave())return;try{const response=await apiFetch(`/api/tasks/${id}`);if(!response.ok)throw new Error(await readError(response));const result=await response.json() as ApiEnvelope<TaskDetail>;await openDetail(result.data)}catch(error){setNotice(error instanceof Error?error.message:'无法打开事项')}}
  async function refreshTreeDetail(){if(!detail)return;try{const response=await apiFetch(`/api/tasks/${detail.id}`);if(!response.ok)throw new Error(await readError(response));const result=await response.json() as ApiEnvelope<TaskDetail>;await openDetail(result.data)}catch(error){setNotice(error instanceof Error?error.message:'刷新事项失败')}}

  async function openProjectRoot(project:ProjectItem){
    if(!project.rootTaskId)return;
    try{const response=await apiFetch(`/api/tasks/${project.rootTaskId}`);if(!response.ok){if(response.status===401)onUnauthorized();throw new Error(await readError(response))}const result=await response.json() as ApiEnvelope<TaskDetail>;await openDetail(result.data)}catch(error){setNotice(error instanceof Error?error.message:'无法打开项目目标事项')}
  }

  function onProjectEnabled(result: { taskId: string; taskVersion: number; structureVersion: number; project: { id: string } }) {
    setDetail((current) => current && current.id === result.taskId ? { ...current, projectId: result.project.id, projectRootTaskId: result.taskId, isProjectRoot: true, version: result.taskVersion, structureVersion: result.structureVersion } : current);
    setPlacementProject(result.project.id);
    setNotice('已启用项目视图，原事项已成为项目目标');
    void loadStructure();
    void loadItems();
  }

  function hasUnsavedChanges() {
    const stagedMediaDirty=Boolean(captureBody.trim()||captureAudioAssetIds.length||captureAudioPending||captureAssets.length||captureFilesPending||captureNeedsReentry||captureMultiText.trim()||capturePreviewRows.length||captureBatchOpen||progressAudioAssetIds.length||progressAudioPending);
    if (!detail) return stagedMediaDirty;
    const planningDirty=priority!==detail.priority||plannedDate!==(detail.plannedDate??'')||dueDate!==(detail.dueDate??'')||followUpDate!==(detail.followUpDate??'')||nextAction!==detail.nextAction||blockedReason!==detail.blockedReason||resultNote!==(detail.resultNote??'');
    const transitionDirty=Boolean(transitionStatus)||waitingReason!==detail.waitingReason||cancellationReason!==detail.cancellationReason;
    const handlingDirty=handlingMode!==detail.handlingMode||counterpartName.trim()!==detail.counterpartName||(placementSpace!==detail.spaceId)||((placementProject||'')!==(detail.projectId??''));
    return detailTitle.trim()!==detail.title||planningDirty||transitionDirty||handlingDirty||description!==detail.description||descriptionFormat!==detail.descriptionFormat||progressText.trim().length>0||pendingMediaCount>0||stagedMediaDirty;
  }

  function confirmLeave(message='有未保存的修改，确定离开吗？') {
    return !hasUnsavedChanges()||window.confirm(message);
  }

  function closeDetail(skipConfirm: unknown = false) {
    if (skipConfirm !== true && !confirmLeave(pendingMediaCount>0?'有正在录制或尚未上传的媒体。离开会停止麦克风并丢弃本机片段；确定离开吗？':'有未保存的修改，确定关闭吗？')) return;
    detailSequence.current += 1;
    setSelected(null); setDetail(null); setDetailError(''); setEvents([]); setEventsHasMore(false); setProgressText(''); setProgressAudioAssetIds([]); setProgressAudioPending(false); setProgressCommitToken((token)=>token+1); setDescription(''); setBodyRevisions([]); setBodyRevisionsOpen(false); bodyRequest.current = null; setRestoredDraft(null); setDraftSavedAt(''); setChecklist([]); setChecklistError(''); setStaticChecklistDismissed(false); setEditingItemId(''); setChecklistText(''); checklistRequest.current = null; editRequest.current = null; setLifecycleMenuOpen(false); setLifecycleDialog(null); setDetailChildCount(0);
  }

  async function saveTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !detailTitle.trim() || detailTitle.trim() === detail.title || detailSaving) return;
    const clean = detailTitle.trim();
    if (!editRequest.current || editRequest.current.id !== detail.id || editRequest.current.title !== clean || editRequest.current.version !== detail.version) {
      editRequest.current = { id: detail.id, title: clean, version: detail.version, requestId: crypto.randomUUID() };
    }
    setDetailSaving(true); setDetailError('');
    try {
      const response = await apiFetch(`/api/tasks/${detail.id}`, { method: 'PATCH', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ requestId:editRequest.current.requestId, expectedVersion:detail.version, title:clean }) });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = await response.json() as ApiEnvelope<{version:number;updatedAt:string;title:string}>;
      setDetail({ ...detail, title:result.data.title, version:result.data.version, updatedAt:result.data.updatedAt });
      setDetailTitle(result.data.title); editRequest.current = null; setNotice('已保存'); await refreshDraftBase(result.data.version); await loadItems();
    } catch (error) { setDetailError(error instanceof Error ? error.message : '保存失败，请重试'); }
    finally { setDetailSaving(false); }
  }

  async function savePlanning() {
    if(!detail||planningSaving) return;
    const payload={priority,plannedDate:plannedDate||null,dueDate:dueDate||null,followUpDate:followUpDate||null,nextAction:nextAction.trim(),blockedReason:blockedReason.trim()};
    const signature=JSON.stringify(payload);
    if(!planningRequest.current||planningRequest.current.id!==detail.id||planningRequest.current.version!==detail.version||planningRequest.current.signature!==signature) planningRequest.current={id:detail.id,version:detail.version,signature,requestId:crypto.randomUUID()};
    setPlanningSaving(true); setDetailError('');
    try {
      const response=await apiFetch(`/api/tasks/${detail.id}/planning`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:planningRequest.current.requestId,expectedVersion:detail.version,...payload})});
      if(!response.ok){if(response.status===401)onUnauthorized();throw new Error(await readError(response));}
      const result=await response.json() as ApiEnvelope<{priority:string;plannedDate:string|null;dueDate:string|null;followUpDate:string|null;nextAction:string;blockedReason:string;version:number;updatedAt:string}>;
      setDetail({...detail,...result.data}); planningRequest.current=null; setNotice('安排信息已保存'); await refreshDraftBase(result.data.version); await loadItems();
    } catch(error){setDetailError(error instanceof Error?error.message:'保存安排信息失败，输入已保留');}
    finally{setPlanningSaving(false);}
  }

  async function loadEvents(taskId:string, before?:TaskEvent) {
    setEventsLoading(true);
    try {
      const query=before?`?limit=50&before=${encodeURIComponent(before.occurredAt)}&beforeId=${encodeURIComponent(before.id)}`:'?limit=50';
      const response=await apiFetch(`/api/tasks/${taskId}/events${query}`);
      if(!response.ok){if(response.status===401)onUnauthorized();throw new Error(await readError(response));}
      const body=await response.json() as ApiEnvelope<{items:TaskEvent[];hasMore:boolean}>;
      setEvents((current)=>before?[...body.data.items,...current]:body.data.items);
      setEventsHasMore(body.data.hasMore);
    } catch(error) { setDetailError(error instanceof Error?error.message:'读取历史失败'); }
    finally { setEventsLoading(false); }
  }

  async function appendProgress() {
    if(!detail||progressSaving) return;
    const text=progressText.trim();const assetIds=[...progressAudioAssetIds];const assetSignature=assetIds.join(',');
    if(!text&&!assetIds.length) return;
    if(!progressRequest.current||progressRequest.current.id!==detail.id||progressRequest.current.version!==detail.version||progressRequest.current.text!==text||progressRequest.current.assetSignature!==assetSignature) progressRequest.current={id:detail.id,version:detail.version,text,assetSignature,requestId:crypto.randomUUID()};
    setProgressSaving(true); setDetailError('');
    try {
      const response=await apiFetch(`/api/tasks/${detail.id}/progress`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:progressRequest.current.requestId,expectedVersion:detail.version,text,assetIds})});
      if(!response.ok){if(response.status===401)onUnauthorized();throw new Error(await readError(response));}
      const result=await response.json() as ApiEnvelope<{version:number;updatedAt:string}>;
      progressRequest.current=null; setProgressText(''); setProgressAudioAssetIds([]); setProgressCommitToken((token)=>token+1); setDetail({...detail,version:result.data.version,updatedAt:result.data.updatedAt}); setNotice(assetIds.length?'进展与录音已追加':'进展已追加'); await loadEvents(detail.id); await loadItems();
    } catch(error) { setDetailError(error instanceof Error?error.message:'追加进展失败，内容已保留'); }
    finally { setProgressSaving(false); }
  }

  async function removeProgressAudio(linkId:string,name:string) {
    if(!detail||!window.confirm(`从这条进展移除录音“${name}”？进展历史保留，原文件不物理删除。`))return;
    try{
      const response=await apiFetch(`/api/tasks/${detail.id}/attachments/${linkId}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),expectedVersion:detail.version})});
      if(!response.ok)throw new Error(await readError(response));
      const result=await response.json() as ApiEnvelope<{version:number}>;setDetail(current=>current?{...current,version:result.data.version}:current);await loadEvents(detail.id);
    }catch(error){setDetailError(error instanceof Error?error.message:'移除进展录音失败')}
  }

  async function submitTransition() {
    if (!detail || !transitionStatus || transitioning) return;
    const status=transitionStatus; const wait=waitingReason.trim(); const cancel=cancellationReason.trim();
    if (status === 'done') {
      const warning = uncheckedCompletionWarning(checklist.filter((item) => !item.isChecked).length);
      if (warning && !window.confirm(warning)) return;
    }
    if (!transitionRequest.current || transitionRequest.current.id!==detail.id || transitionRequest.current.version!==detail.version || transitionRequest.current.status!==status || transitionRequest.current.waitingReason!==wait || transitionRequest.current.cancellationReason!==cancel) {
      transitionRequest.current={id:detail.id,version:detail.version,status,waitingReason:wait,cancellationReason:cancel,requestId:crypto.randomUUID()};
    }
    setTransitioning(true); setDetailError('');
    try {
      const response=await apiFetch(`/api/tasks/${detail.id}/transition`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:transitionRequest.current.requestId,expectedVersion:detail.version,status,...(status==='waiting'?{waitingReason:wait}:{}),...(status==='cancelled'?{cancellationReason:cancel}:{})})});
      if(!response.ok){if(response.status===401)onUnauthorized();throw new Error(await readError(response));}
      const result=await response.json() as ApiEnvelope<{status:string;version:number;updatedAt:string;waitingReason:string;cancellationReason:string;completedAt:string|null;cancelledAt:string|null;isProcessed:boolean}>;
      setDetail({...detail,status:result.data.status,version:result.data.version,updatedAt:result.data.updatedAt,followUpDate:(result.data.status==='done'||result.data.status==='cancelled')?null:detail.followUpDate,waitingReason:result.data.waitingReason,cancellationReason:result.data.cancellationReason,completedAt:result.data.completedAt,cancelledAt:result.data.cancelledAt,isProcessed:result.data.isProcessed,resultNote:result.data.status==='todo'?'':detail.resultNote});
      setTransitionStatus(''); if(result.data.status==='done'||result.data.status==='cancelled') setFollowUpDate(''); if(result.data.status==='todo') setResultNote(''); setWaitingReason(result.data.waitingReason); setCancellationReason(result.data.cancellationReason); transitionRequest.current=null; setNotice(result.data.status==='todo'&&(detail.status==='done'||detail.status==='cancelled')?'事项已重新打开，请重新安排跟进。':'状态已更新'); await loadItems();
    } catch(error) {setDetailError(error instanceof Error?error.message:'状态更新失败，请重试');}
    finally {setTransitioning(false);}
  }

  /** UX-02/03：属性就地保存。每次只提交当前字段，复用事项版本与幂等 requestId。 */
  async function saveAttribute(task: AttrTask, kind: AttrKind, payload: AttrPayload): Promise<AttrSaveResult> {
    if (kind === 'status' && payload.status === 'done') { const warning = uncheckedCompletionWarning(checklist.filter((item) => !item.isChecked).length); if (warning && !window.confirm(warning)) return 'failed'; }
    const requestId = crypto.randomUUID();
    const path = kind === 'status' ? `/api/tasks/${task.id}/transition` : kind === 'handling' ? `/api/tasks/${task.id}/handling` : `/api/tasks/${task.id}`;
    const method = kind === 'status' || kind === 'handling' ? 'POST' : 'PATCH';
    try {
      const response = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, expectedVersion: task.version, ...payload }) });
      const parsed = await response.json().catch(() => ({})) as ApiEnvelope<Record<string, unknown>> & ApiFailure;
      if (!response.ok) {
        if (response.status === 401) onUnauthorized();
        if (response.status === 409 && parsed.error?.current) {
          const fresh = parsed.error.current as Partial<TaskDetail>;
          setDetail((value) => value && value.id === task.id ? { ...value, ...fresh, version: Number(fresh.version ?? value.version) } : value);
          setItems((values) => values.map((value) => value.id === task.id ? { ...value, ...fresh, version: Number(fresh.version ?? value.version) } as TaskItem : value));
          return 'conflict';
        }
        setNotice(parsed.error?.message ?? `保存失败（${response.status}）`);
        return 'failed';
      }
      const result = parsed.data ?? {};
      setItems((values) => values.map((value) => value.id === task.id ? { ...value, ...result } as TaskItem : value));
      setSelected((value) => value && value.id === task.id ? { ...value, ...result } as TaskItem : value);
      setDetail((value) => value && value.id === task.id ? { ...value, ...result } as TaskDetail : value);
      setNotice('已保存');
      void loadItems();
      return result.changed === false ? 'noop' : 'saved';
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败，输入已保留');
      return 'failed';
    }
  }

  /** 行内编辑后弹层只负责局部操作，详情表单状态同步由打开详情时重新读取。 */
  const attributeTask = (item: TaskItem): TaskItem => item;

  async function markProcessed(item: TaskItem) {
    if (item.isProcessed || processingId) return;
    if (!processRequest.current || processRequest.current.id !== item.id || processRequest.current.version !== item.version) processRequest.current = { id:item.id, version:item.version, requestId:crypto.randomUUID() };
    setProcessingId(item.id); setNotice('');
    try {
      const response = await apiFetch(`/api/tasks/${item.id}/process`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({requestId:processRequest.current.requestId,expectedVersion:item.version}) });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      processRequest.current = null;
      if (selected?.id === item.id) { setSelected(null); setDetail(null); }
      setNotice('已完成整理'); await loadItems();
    } catch (error) { setNotice(error instanceof Error ? error.message : '整理失败，请重试'); }
    finally { setProcessingId(''); }
  }

  async function restoreLifecycleItem(item: TaskItem) {
    if (lifecycleActionId || (view !== 'archived' && view !== 'trash')) return;
    const operation = view === 'archived' ? 'unarchive' : 'restore';
    setLifecycleActionId(item.id); setNotice('');
    try {
      const body = { requestId: crypto.randomUUID(), expectedVersion: item.version, ...(operation === 'unarchive' ? { expectedStructureVersion: item.structureVersion } : {}) };
      const response = await apiFetch(`/api/tasks/${item.id}/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = await response.json() as ApiEnvelope<{ unarchivedCount?: number; restoredCount?: number }>;
      const count = operation === 'unarchive' ? result.data.unarchivedCount : result.data.restoredCount;
      setNotice(operation === 'unarchive' ? `已取消归档${count && count > 1 ? `（恢复 ${count} 项）` : ''}` : `已从回收站恢复${count && count > 1 ? `（恢复 ${count} 项）` : ''}`);
      await loadItems();
    } catch (error) { setNotice(error instanceof Error ? error.message : '恢复失败，请重试'); }
    finally { setLifecycleActionId(''); }
  }

  async function openLifecycleHistory(item: TaskItem) {
    setHistoryTask(item); setEvents([]); setEventsLoading(true);
    try {
      const response = await apiFetch(`/api/tasks/${item.id}/events?limit=100&includeDeleted=${item.deletedAt ? 'true' : 'false'}`);
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const body = await response.json() as ApiEnvelope<{ items: TaskEvent[] }>;
      setEvents(body.data.items); setEventsHasMore(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : '读取历史失败'); }
    finally { setEventsLoading(false); }
  }


  useEffect(() => {
    if (!hasUnsavedChanges()) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  });

  async function saveHandling() {
    if (!detail || handlingSaving) return;
    const mode = handlingMode; const name = counterpartName.trim();
    if (mode === 'other' && !name) return;
    if (!handlingRequest.current || handlingRequest.current.id !== detail.id || handlingRequest.current.version !== detail.version || handlingRequest.current.mode !== mode || handlingRequest.current.name !== name) handlingRequest.current = { id: detail.id, version: detail.version, mode, name, requestId: crypto.randomUUID() };
    setHandlingSaving(true); setDetailError('');
    try {
      const response = await apiFetch(`/api/tasks/${detail.id}/handling`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: handlingRequest.current.requestId, expectedVersion: detail.version, handlingMode: mode, ...(mode === 'other' ? { counterpartName: name } : {}) }) });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = await response.json() as ApiEnvelope<{ handlingMode: string; counterpartName: string; version: number; updatedAt: string }>;
      setDetail({ ...detail, handlingMode: result.data.handlingMode, counterpartName: result.data.counterpartName, version: result.data.version, updatedAt: result.data.updatedAt });
      setHandlingMode(result.data.handlingMode); setCounterpartName(result.data.counterpartName); handlingRequest.current = null; setNotice('处理安排已保存'); await loadItems();
    } catch (error) { setDetailError(error instanceof Error ? error.message : '保存处理安排失败，输入已保留'); }
    finally { setHandlingSaving(false); }
  }

  async function savePlacement() {
    if (!detail || placementSaving || !placementSpace) return;
    const spaceId = placementSpace; const projectId = placementProject;
    if (!placementRequest.current || placementRequest.current.id !== detail.id || placementRequest.current.version !== detail.version || placementRequest.current.spaceId !== spaceId || placementRequest.current.projectId !== projectId) placementRequest.current = { id: detail.id, version: detail.version, spaceId, projectId, requestId: crypto.randomUUID() };
    setPlacementSaving(true); setDetailError('');
    try {
      const response = await apiFetch(`/api/tasks/${detail.id}/placement`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: placementRequest.current.requestId, expectedVersion: detail.version, spaceId, projectId: projectId || null }) });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = await response.json() as ApiEnvelope<{ spaceId: string; projectId: string | null; sectionId: string | null; version: number; updatedAt: string }>;
      const spaceName = spaces.find((item) => item.id === result.data.spaceId)?.name ?? detail.spaceName;
      setDetail({ ...detail, spaceId: result.data.spaceId, spaceName, projectId: result.data.projectId, sectionId: result.data.sectionId, version: result.data.version, updatedAt: result.data.updatedAt });
      setPlacementSpace(result.data.spaceId); setPlacementProject(result.data.projectId ?? ''); setPlacementSection(result.data.sectionId ?? ''); placementRequest.current = null; setNotice('归属已保存'); await loadItems(); await loadStructure();
    } catch (error) { setDetailError(error instanceof Error ? error.message : '保存归属失败'); }
    finally { setPlacementSaving(false); }
  }

  async function saveSection() {
    if (!detail || !canAssignSection || sectionSaving || !hasSectionChanges) return;
    setSectionSaving(true); setDetailError('');
    try {
      const response = await apiFetch(`/api/tasks/${detail.id}/section`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: detail.version, sectionId: placementSection || null }) });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = await response.json() as ApiEnvelope<{ sectionId: string | null; version: number; updatedAt: string }>;
      setDetail({ ...detail, sectionId: result.data.sectionId, version: result.data.version, updatedAt: result.data.updatedAt });
      setPlacementSection(result.data.sectionId ?? ''); setNotice(result.data.sectionId ? '已加入分组' : '已移出分组'); await loadItems();
    } catch (error) { setDetailError(error instanceof Error ? error.message : '保存分组失败'); }
    finally { setSectionSaving(false); }
  }

  async function createSection() {
    if (!projectFilter || !newSectionName.trim() || sectionManaging) return;
    setSectionManaging(true); setNotice('');
    try {
      const response = await apiFetch(`/api/projects/${projectFilter}/sections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), name: newSectionName.trim() }) });
      if (!response.ok) throw new Error(await readError(response));
      setNewSectionName(''); setNotice('已创建项目分组');
      const refreshed = await apiFetch(`/api/projects/${projectFilter}/sections`);
      if (refreshed.ok) { const body = await refreshed.json() as ApiEnvelope<{ items: typeof projectSections }>; setProjectSections(body.data.items); }
    } catch (error) { setNotice(error instanceof Error ? error.message : '创建分组失败'); }
    finally { setSectionManaging(false); }
  }

  async function moveSection(index: number, direction: -1 | 1) {
    if (!projectFilter || sectionManaging) return;
    const target = index + direction; if (target < 0 || target >= projectSections.length) return;
    const next = projectSections.map((section) => section.id); [next[index], next[target]] = [next[target], next[index]];
    setSectionManaging(true); setNotice('');
    try {
      const projectResponse = await apiFetch(`/api/projects/${projectFilter}`); if (!projectResponse.ok) throw new Error(await readError(projectResponse));
      const projectBody = await projectResponse.json() as ApiEnvelope<{ version: number }>;
      const response = await apiFetch(`/api/projects/${projectFilter}/sections/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), expectedProjectVersion: projectBody.data.version, sectionIds: next }) });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as ApiEnvelope<{ items: typeof projectSections }>; setProjectSections(body.data.items); setNotice('分组顺序已更新');
    } catch (error) { setNotice(error instanceof Error ? error.message : '调整分组顺序失败'); }
    finally { setSectionManaging(false); }
  }

  /** 小步骤清单（PRD 9.3）：独立于正文与状态，不进入任务视图与计数。 */
  async function loadChecklist(taskId: string) {
    setChecklistLoading(true);
    try {
      const response = await apiFetch(`/api/tasks/${taskId}/checklist`);
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const body = await response.json() as ApiEnvelope<{ items: Array<{ id: string; text: string; isChecked: boolean; version: number; sortKey: string }> }>;
      setChecklist(body.data.items);
    } catch (error) { setChecklistError(error instanceof Error ? error.message : '读取小步骤失败'); }
    finally { setChecklistLoading(false); }
  }

  /** 同一次操作重试复用 requestId，成功后清空，避免重试重复写入。 */
  function checklistRequestId(signature: string) {
    if (!checklistRequest.current || checklistRequest.current.signature !== signature) checklistRequest.current = { signature, requestId: crypto.randomUUID() };
    return checklistRequest.current.requestId;
  }

  async function checklistMutation(path: string, signature: string, payload: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST') {
    if (!detail) return null;
    const response = await apiFetch(`/api/tasks/${detail.id}/checklist${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: checklistRequestId(signature), expectedVersion: detail.version, ...payload }),
    });
    if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
    checklistRequest.current = null;
    const body = await response.json() as ApiEnvelope<{ items: Array<{ id: string; text: string; isChecked: boolean; version: number; sortKey: string }> }>;
    setChecklist(body.data.items);
    return body.data;
  }

  async function addChecklistItem() {
    if (!detail || checklistBusy || !checklistText.trim()) return;
    setChecklistBusy('create'); setChecklistError('');
    try { await checklistMutation('', `create:${checklistText.trim()}`, { text: checklistText.trim() }); setChecklistText(''); }
    catch (error) { setChecklistError(error instanceof Error ? error.message : '添加小步骤失败'); }
    finally { setChecklistBusy(''); }
  }

  async function toggleChecklistItem(item: { id: string; version: number; isChecked: boolean }) {
    if (!detail || checklistBusy) return;
    setChecklistBusy(item.id); setChecklistError('');
    try { await checklistMutation(`/${item.id}`, `toggle:${item.id}:${item.version}:${!item.isChecked}`, { itemVersion: item.version, isChecked: !item.isChecked }, 'PATCH'); }
    catch (error) { setChecklistError(error instanceof Error ? error.message : '更新小步骤失败'); }
    finally { setChecklistBusy(''); }
  }

  async function saveChecklistText(item: { id: string; version: number; text: string }) {
    if (!detail || checklistBusy) return;
    const text = editingText.trim();
    if (!text || text === item.text) { setEditingItemId(''); return; }
    setChecklistBusy(item.id); setChecklistError('');
    try { await checklistMutation(`/${item.id}`, `text:${item.id}:${item.version}:${text}`, { itemVersion: item.version, text }, 'PATCH'); setEditingItemId(''); }
    catch (error) { setChecklistError(error instanceof Error ? error.message : '保存小步骤失败'); }
    finally { setChecklistBusy(''); }
  }

  async function moveChecklistItem(item: { id: string; version: number }, direction: 'up' | 'down') {
    if (!detail || checklistBusy) return;
    setChecklistBusy(item.id); setChecklistError('');
    try { await checklistMutation(`/${item.id}/move`, `move:${item.id}:${item.version}:${direction}`, { itemVersion: item.version, direction }); }
    catch (error) { setChecklistError(error instanceof Error ? error.message : '排序失败'); }
    finally { setChecklistBusy(''); }
  }

  async function removeChecklistItem(item: { id: string; version: number }) {
    if (!detail || checklistBusy) return;
    if (!window.confirm('删除这条小步骤？删除不影响事项本身。')) return;
    setChecklistBusy(item.id); setChecklistError('');
    try { await checklistMutation(`/${item.id}/remove`, `remove:${item.id}:${item.version}`, { itemVersion: item.version }); }
    catch (error) { setChecklistError(error instanceof Error ? error.message : '删除小步骤失败'); }
    finally { setChecklistBusy(''); }
  }

  /** 正文里的静态 `- [ ]` 转成结构化小步骤（PRD 7.1）：服务端同一事务内建条目并清理正文。 */
  async function importStaticChecklist() {
    if (!detail || checklistImporting) return;
    setChecklistImporting(true); setChecklistError('');
    try {
      const response = await apiFetch(`/api/tasks/${detail.id}/checklist/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: detail.version }),
      });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const body = await response.json() as ApiEnvelope<{
        imported: number; skipped: number; version: number; description?: string; descriptionFormat?: string;
        items: Array<{ id: string; text: string; isChecked: boolean; version: number; sortKey: string }>;
      }>;
      setChecklist(body.data.items);
      if (body.data.description !== undefined) {
        const nextDescription = body.data.description;
        const nextFormat = body.data.descriptionFormat ?? descriptionFormat;
        setDescription(nextDescription); setDescriptionFormat(nextFormat); resetBodyRequests();
        setDetail((current) => current ? { ...current, description: nextDescription, descriptionFormat: nextFormat, version: body.data.version } : current);
      }
      setStaticChecklistDismissed(true);
      setNotice(body.data.skipped > 0
        ? `已转为 ${body.data.imported} 条小步骤；另有 ${body.data.skipped} 行因超出 100 条上限保留为静态文本。`
        : `已把 ${body.data.imported} 行复选框转为小步骤，并从正文移除`);
      await loadItems();
    } catch (error) { setChecklistError(error instanceof Error ? error.message : '转换小步骤失败'); }
    finally { setChecklistImporting(false); }
  }

  /** 草稿覆盖的编辑字段（标题、正文、安排）；进展与状态原因仍由离开确认保护。 */
  function editorDraftFields(): DraftFields {
    return {
      title: detailTitle.trim(), description, descriptionFormat, priority,
      plannedDate, dueDate, followUpDate, nextAction: nextAction.trim(), blockedReason: blockedReason.trim(), pendingUploads: [],
    };
  }

  function serverDraftFields(source: { title: string; description: string; descriptionFormat: string; priority: string; plannedDate: string | null; dueDate: string | null; followUpDate: string | null; nextAction: string; blockedReason: string }): DraftFields {
    return {
      title: source.title, description: source.description, descriptionFormat: source.descriptionFormat, priority: source.priority,
      plannedDate: source.plannedDate ?? '', dueDate: source.dueDate ?? '', followUpDate: source.followUpDate ?? '',
      nextAction: source.nextAction, blockedReason: source.blockedReason, pendingUploads: [],
    };
  }

  function applyDraftSaveResult(result: 'saved' | 'too-large' | 'unavailable') {
    if (result === 'saved') { setDraftSavedAt(new Date().toISOString()); setDraftUnsupported(false); }
    else { setDraftSavedAt(''); setDraftUnsupported(true); }
  }

  /** 只写本机草稿：不改变服务端，也不显示为「已保存」。 */
  async function persistDraft(): Promise<void> {
    if (!detail || !userId || !hasUnsavedChanges()) return;
    if (!isDraftStorageSupported()) { setDraftUnsupported(true); return; }
    const result = await draftStore.save({
      schemaVersion: 1, kind: 'task', userId, taskId: detail.id, baseVersion: detail.version,
      updatedAt: new Date().toISOString(), ...editorDraftFields(),
    });
    applyDraftSaveResult(result);
  }

  /** 部分保存成功后刷新草稿：没有未提交内容就删除，否则按新版本重存，避免下次被误判为冲突。 */
  async function refreshDraftBase(version: number): Promise<void> {
    if (!detail || !userId) return;
    if (!hasUnsavedChanges()) { await draftStore.removeTask(userId, detail.id); setDraftSavedAt(''); setRestoredDraft(null); return; }
    if (!isDraftStorageSupported()) { setDraftUnsupported(true); return; }
    const result = await draftStore.save({
      schemaVersion: 1, kind: 'task', userId, taskId: detail.id, baseVersion: version,
      updatedAt: new Date().toISOString(), ...editorDraftFields(),
    });
    applyDraftSaveResult(result);
  }

  function applyDraftFields(draft: TaskDraft) {
    setDetailTitle(draft.title); setDescription(draft.description); setDescriptionFormat(draft.descriptionFormat);
    setPriority(draft.priority); setPlannedDate(draft.plannedDate); setDueDate(draft.dueDate); setFollowUpDate(draft.followUpDate);
    setNextAction(draft.nextAction); setBlockedReason(draft.blockedReason);
    setBodyView(draft.descriptionFormat === 'markdown_v1' ? 'visual' : 'source');
    bodyRequest.current = null;
  }

  function useMyDraft() {
    if (!restoredDraft) return;
    applyDraftFields(restoredDraft.draft);
    setRestoredDraft(null);
    setNotice('已载入本机草稿；保存后才会写入服务器（服务器原内容仍可在正文历史查看）。');
  }

  async function discardDraft() {
    if (detail && userId) await draftStore.removeTask(userId, detail.id);
    setRestoredDraft(null); setDraftSavedAt('');
    setNotice('已放弃本机草稿');
  }

  /** PRD 7.2：退出账号前提示未提交内容，确认后清理本机私有草稿。 */
  async function requestSignOut() {
    if (signingOut) return;
    if (userId) {
      const message = hasUnsavedChanges()
        ? `有未提交的修改${pendingMediaCount>0?'和媒体片段':''}。退出会清理本机草稿并丢弃未上传媒体，确定退出吗？`
        : '退出账号会清理本机保存的私有草稿，确定退出吗？';
      if (!window.confirm(message)) return;
    }
    setSigningOut(true);
    if (userId) await draftStore.clearUser(userId);
    onSignOut();
  }

  function resetBodyRequests() { bodyRequest.current = null; }

  /** PRD 7.1 / 技术设计 3.3：旧纯文本必须先转义再按 Markdown 解释，不能静默改写历史（AT-28）。 */
  function convertToMarkdown() {
    setDescription(escapePlaintextToMarkdown(description));
    setDescriptionFormat('markdown_v1');
    setBodyView('visual');
    resetBodyRequests();
    setNotice('已把旧纯文本转义为 Markdown 源文本；保存后才会成为新版本。');
  }

  function insertAssetIntoBody(assetId:string,alt:string) {
    if(descriptionFormat==='plaintext') {
      setNotice('请先将旧纯文本正文显式转换为 Markdown，之后再插入图片。');
      return;
    }
    setBodyView(bodyView==='preview'?'source':bodyView);
    requestAnimationFrame(()=>richBodyEditorRef.current?.insertAsset(assetId,alt));
    setDescriptionFormat('markdown_v1');
    resetBodyRequests();
  }

  function surroundSelection(prefix: string, suffix: string, placeholder: string) {
    const element = bodyRef.current;
    if (!element) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const selected = description.slice(start, end) || placeholder;
    setDescription(`${description.slice(0, start)}${prefix}${selected}${suffix}${description.slice(end)}`);
    resetBodyRequests();
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    });
  }

  function prefixLine(prefix: string) {
    const element = bodyRef.current;
    if (!element) return;
    const start = element.selectionStart;
    const lineStart = description.lastIndexOf('\n', start - 1) + 1;
    setDescription(`${description.slice(0, lineStart)}${prefix}${description.slice(lineStart)}`);
    resetBodyRequests();
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + prefix.length, start + prefix.length);
    });
  }

  async function loadBodyRevisions() {
    if (!detail) return;
    setBodyRevisionsLoading(true);
    try {
      const response = await apiFetch(`/api/tasks/${detail.id}/body-revisions?limit=20`);
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const body = await response.json() as ApiEnvelope<{ items: Array<{ id: string; format: string; content: string; taskVersion: number; createdAt: string }> }>;
      setBodyRevisions(body.data.items);
    } catch (error) { setDetailError(error instanceof Error ? error.message : '读取正文历史失败'); }
    finally { setBodyRevisionsLoading(false); }
  }

  async function saveContent(): Promise<number | null> {
    if (!detail || bodySaving) return null;
    const payload = {
      title: detailTitle.trim(),
      description,
      descriptionFormat,
      priority,
      plannedDate: plannedDate || null,
      dueDate: dueDate || null,
      followUpDate: followUpDate || null,
      nextAction: nextAction.trim(),
      blockedReason: blockedReason.trim(),
      resultNote: resultNote.trim(),
    };
    const signature = JSON.stringify(payload);
    if (!bodyRequest.current || bodyRequest.current.id !== detail.id || bodyRequest.current.version !== detail.version || bodyRequest.current.signature !== signature) {
      bodyRequest.current = { id: detail.id, version: detail.version, signature, requestId: crypto.randomUUID() };
    }
    setBodySaving(true); setDetailError('');
    try {
      const response = await apiFetch(`/api/tasks/${detail.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: bodyRequest.current.requestId, expectedVersion: detail.version, ...payload }),
      });
      if (!response.ok) { if (response.status === 401) onUnauthorized(); throw new Error(await readError(response)); }
      const result = await response.json() as ApiEnvelope<{
        version: number; updatedAt: string; title: string; description: string; descriptionFormat: string;
        priority: string; plannedDate: string | null; dueDate: string | null; followUpDate: string | null;
        nextAction: string; blockedReason: string; resultNote: string;
        body: { revisionId: string; format: string; length: number; hasUnsupportedSyntax: boolean; hasTaskListSyntax: boolean } | null;
      }>;
      const next = result.data;
      setDetail({ ...detail, title: next.title, description: next.description, descriptionFormat: next.descriptionFormat, priority: next.priority, plannedDate: next.plannedDate, dueDate: next.dueDate, followUpDate: next.followUpDate, nextAction: next.nextAction, blockedReason: next.blockedReason, resultNote: next.resultNote, version: next.version, updatedAt: next.updatedAt });
      setDetailTitle(next.title); setDescription(next.description); setDescriptionFormat(next.descriptionFormat);
      setPriority(next.priority); setPlannedDate(next.plannedDate ?? ''); setDueDate(next.dueDate ?? ''); setFollowUpDate(next.followUpDate ?? ''); setNextAction(next.nextAction); setBlockedReason(next.blockedReason); setResultNote(next.resultNote ?? '');
      bodyRequest.current = null;
      if (userId) { await draftStore.removeTask(userId, detail.id); setRestoredDraft(null); setDraftSavedAt(''); }
      setNotice(next.body?.hasUnsupportedSyntax ? '已保存；正文中有超出共同子集的写法，已按原样保留。' : next.body?.hasTaskListSyntax ? '已保存；检测到 - [ ] 复选框，当前按静态文本保留。' : '正文与安排已保存');
      if (isSearchMode) await loadSearch(searchQuery, searchOffset);
      else if (isReviewMode && reviewKind) await loadReview(reviewKind, reviewOffset);
      else await loadItems();
      if (bodyRevisionsOpen) await loadBodyRevisions();
      return next.version;
    } catch (error) { setDetailError(error instanceof Error ? error.message : '保存失败，输入已保留'); return null; }
    finally { setBodySaving(false); }
  }

  function openLifecycleDialog(operation: LifecycleOperation) {
    if (!detail || lifecycleBusy) return;
    setLifecycleMenuOpen(false);
    const hasContentChanges = hasBodyChanges || hasPlanningChanges || detailTitle.trim() !== detail.title;
    const hasIndependentChanges = hasHandlingChanges || hasPlacementChanges || hasSectionChanges || Boolean(transitionStatus) || progressText.trim().length > 0 || progressAudioAssetIds.length > 0 || progressAudioPending || pendingMediaCount > 0;
    if (hasIndependentChanges) {
      setDetailError('请先提交或取消当前的独立操作，再执行归档或移入回收站；录音和进展不会被自动带入。');
      return;
    }
    setLifecycleDialog({ operation, scope: 'single', step: hasContentChanges ? 'save' : 'confirm' });
  }

  async function continueLifecycleWithSavedContent() {
    if (!lifecycleDialog || lifecycleDialog.step !== 'save') return;
    const operation = lifecycleDialog.operation;
    const version = await saveContent();
    if (version === null) return;
    setLifecycleDialog({ operation, scope: 'single', step: 'confirm', expectedVersion: version });
  }

  async function continueLifecycleWithDraft() {
    if (!lifecycleDialog || lifecycleDialog.step !== 'save' || !detail) return;
    if (!isDraftStorageSupported()) {
      setDetailError('当前浏览器无法可靠保留本机草稿，请先保存后再执行该操作。');
      return;
    }
    await persistDraft();
    const operation = lifecycleDialog.operation;
    setLifecycleDialog({ operation, scope: 'single', step: 'confirm', expectedVersion: detail.version });
  }

  async function executeLifecycle() {
    if (!detail || !lifecycleDialog || lifecycleDialog.step !== 'confirm' || lifecycleBusy) return;
    const { operation, scope } = lifecycleDialog;
    const expectedVersion = lifecycleDialog.expectedVersion ?? detail.version;
    const expectedStructureVersion = detail.structureVersion;
    setLifecycleBusy(true); setDetailError('');
    try {
      const response = await apiFetch(`/api/tasks/${detail.id}/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion, expectedStructureVersion, scope }),
      });
      if (!response.ok) {
        if (response.status === 401) onUnauthorized();
        throw new Error(await readError(response));
      }
      const result = await response.json() as ApiEnvelope<{ archivedCount?: number; deletedCount?: number }>;
      setLifecycleDialog(null);
      closeDetail(true);
      const count = operation === 'archive' ? result.data.archivedCount : result.data.deletedCount;
      setNotice(operation === 'archive' ? `已归档${scope === 'subtree' ? `整棵主子树（${count ?? 1} 项）` : '当前事项'}` : `已移入回收站${scope === 'subtree' ? `（${count ?? 1} 项）` : ''}`);
      await loadItems();
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : '操作失败，请重试');
    } finally { setLifecycleBusy(false); }
  }

  const checklistStats=checklistCounts(checklist);
  const staticChecklistCandidates=detail?staticChecklistLines(description):[];
  const hasHandlingChanges=Boolean(detail&&(handlingMode!==detail.handlingMode||counterpartName.trim()!==detail.counterpartName));
  const hasPlacementChanges=Boolean(detail&&placementSpace&&(placementSpace!==detail.spaceId||(placementProject||'')!==(detail.projectId??'')));
  const canAssignSection=Boolean(detail?.projectId && detail.parentId && detail.parentId===detail.projectRootTaskId);
  const hasSectionChanges=Boolean(detail&&canAssignSection&&(placementSection||'')!==(detail.sectionId??''));

  const hasBodyChanges=Boolean(detail&&(description!==detail.description||descriptionFormat!==detail.descriptionFormat));
  const bodyFlags=useMemo(()=>parseBody(description),[description]);
  const hasPlanningChanges=Boolean(detail&&(priority!==detail.priority||plannedDate!==(detail.plannedDate??'')||dueDate!==(detail.dueDate??'')||followUpDate!==(detail.followUpDate??'')||nextAction!==detail.nextAction||blockedReason!==detail.blockedReason||resultNote!==(detail.resultNote??'')));
  const isLifecycleView = view === 'archived' || view === 'trash';
  const isSearchMode = Boolean(searchQuery);
  const isReviewMode = Boolean(reviewKind);
  const isContextMode = isSearchMode || isReviewMode;
  const activeItems = isSearchMode ? searchItems : isReviewMode ? reviewItems : items;
  const activeTotal = isSearchMode ? searchTotal : isReviewMode ? reviewTotal : total;
  const activeLoading = isSearchMode ? searchLoading : isReviewMode ? reviewLoading : loading;
  const activeError = isSearchMode ? searchError : isReviewMode ? reviewError : listError;
  const leaveSpecialMode = useCallback(() => { clearSearch(); setReviewKind(null); setReviewItems([]); setReviewTotal(0); }, [clearSearch]);

  return (
    <main className={styles.appShell}>
      <aside className={styles.sidebar}>
        <a className={styles.brand} href="#home" aria-label="知事首页"><span className={styles.brandMark}>知</span><span className={styles.brandName}>知事<span>个人工作区</span></span></a>
        <div className={styles.navLabel}>工作台</div>
        <nav className={styles.nav} aria-label="工作台导航">
          {(['inbox','today','overdue','followup','doing','delegated','waiting','watched','all'] as View[]).map((item)=><button key={item} className={`${styles.navItem} ${view === item && !projectFilter && !isSearchMode && !isReviewMode ? styles.navActive : ''}`} onClick={() => { leaveSpecialMode(); setProjectFilter(''); setView(item); }}><span className={styles.navGlyph}>{navGlyphs[item]}</span><span>{viewNames[item]}</span>{item === 'inbox' && !projectFilter && <span className={styles.navCount}>{total}</span>}</button>)}
        </nav>
        <div className={styles.navLabel}>回顾</div>
        {(Object.keys(reviewNames) as ReviewKind[]).map((kind)=><button key={kind} className={`${styles.navItem} ${reviewKind === kind ? styles.navActive : ''}`} onClick={() => { clearSearch(); setView('all'); setProjectFilter(''); setSpaceFilter(''); void loadReview(kind); }}><span className={styles.navGlyph}>◌</span><span>{reviewNames[kind]}</span></button>)}
        {(['archived','trash'] as View[]).map((item)=><button key={item} className={`${styles.navItem} ${view === item && !isSearchMode && !isReviewMode ? styles.navActive : ''}`} onClick={() => { leaveSpecialMode(); setProjectFilter(''); setSpaceFilter(''); setView(item); }}><span className={styles.navGlyph}>{navGlyphs[item]}</span><span>{viewNames[item]}</span></button>)}
        <div className={styles.navLabel}>项目</div>
        <div className={styles.projectList}>
          {projects.length === 0 && <p className={styles.projectEmpty}>还没有项目</p>}
          {projects.map((project)=><button key={project.id} className={`${styles.navItem} ${projectFilter === project.id && !isSearchMode && !isReviewMode ? styles.navActive : ''}`} onClick={() => { leaveSpecialMode(); setProjectFilter(project.id); setSpaceFilter(''); setView('all'); }}><span className={styles.navGlyph}>▤</span><span>{project.name}</span><span className={styles.navCount}>{project.counts.active}</span></button>)}
        </div>
        <div className={styles.sidebarBottom}><div className={styles.avatar}>我</div><div className={styles.accountText}><strong>我的空间</strong><small>个人工作区</small></div><div className={styles.sidebarActions}><AccountMenu /><button className={styles.signOut} disabled={signingOut} onClick={() => void requestSignOut()}>退出</button></div></div>
      </aside>

      <section className={styles.workspace} id="home">
        <header className={styles.topbar}><div className={styles.crumb}><span>工作台</span><i>/</i><b>{isSearchMode ? '搜索' : isReviewMode ? `回顾 · ${reviewNames[reviewKind!]}` : viewNames[view]}</b></div><div className={styles.topActions}><form className={styles.globalSearch} onSubmit={(event) => { event.preventDefault(); setView('all'); setReviewKind(null); void loadSearch(searchInput); }}><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜索事项…" aria-label="全局搜索"/><button type="submit">搜索</button>{(searchInput || searchQuery) && <button type="button" aria-label="清除搜索" onClick={clearSearch}>×</button>}</form><button type="button" className={styles.exportButton} onClick={() => setExportOpen((open) => !open)}>导出</button><span className={styles.topbarAccount}><AccountMenu onSignOut={() => void requestSignOut()} signingOut={signingOut} /></span></div></header>
        {exportOpen && <section className={styles.exportPanel} aria-label="导出面板"><div><strong>导出当前范围</strong><span>{projectFilter ? '当前项目' : spaceFilter ? '当前空间' : searchQuery ? `搜索：${searchQuery}` : `当前视图：${viewNames[view]}`}</span></div><div className={styles.exportActions}>{(['json','csv','bundle'] as const).map((format) => <button key={format} type="button" className={styles.secondaryButton} disabled={Boolean(exportBusy)} onClick={() => void exportData(format)}>{exportBusy === format ? '准备中…' : format === 'bundle' ? '完整包' : format.toUpperCase()}</button>)}</div>{exportError && <p className={styles.errorText} role="alert">{exportError}</p>}</section>}
        <div className={styles.pageContent}>
          <div className={styles.pageEyebrow}>{new Intl.DateTimeFormat('zh-CN',{weekday:'long',month:'long',day:'numeric',timeZone:'Asia/Shanghai'}).format(new Date())}</div>
          <div className={styles.pageHeading}><div><div className={styles.headingTitleLine}><h1>{isSearchMode ? `搜索：${searchQuery}` : isReviewMode ? `回顾 · ${reviewNames[reviewKind!]}` : projectFilter ? (projects.find((project)=>project.id===projectFilter)?.name ?? '项目') : viewNames[view]}</h1><span className={styles.headingCount}>{activeTotal}</span></div><p>{isSearchMode ? '按命中来源和层级路径浏览，打开详情后继续处理。' : isReviewMode ? '先看需要行动的事项，再进入详情补齐下一步或结果。' : projectFilter ? '项目内事项；在此新增会自动继承项目并标记已整理。' : view === 'inbox' ? '先记下来，整理可以稍后再做。' : view === 'archived' ? '只读回顾已归档的事项，可按归档批次取消归档。' : view === 'trash' ? '只读查看已移入回收站的事项，可按删除批次恢复。' : '只显示活跃事项；结束事项在全部视图可开启查看。'}</p>{isContextMode && <button type="button" className={styles.contextBackButton} onClick={() => { leaveSpecialMode(); setView('inbox'); }}>返回工作台</button>}{projectFilter&&projects.find(project=>project.id===projectFilter)?.rootTaskId&&<button type="button" className={styles.projectRootButton} onClick={()=>{const project=projects.find(item=>item.id===projectFilter);if(project)void openProjectRoot(project)}}>打开项目目标事项</button>}</div><button className={styles.refreshButton} onClick={() => isSearchMode ? void loadSearch(searchQuery, searchOffset) : isReviewMode ? void loadReview(reviewKind!, reviewOffset) : void loadItems()} aria-label="刷新列表" title="刷新列表">↻</button></div>
          {projectFilter && <ProjectTreePanel projectId={projectFilter} onOpen={(id) => void openTaskFromTree(id)} />}
          {projectFilter && <section className={styles.filterRow} aria-label="项目分组管理">
            <div className={styles.fieldLabel}><span>项目分组</span><div className={styles.captureMode}>{projectSections.map((section, index) => <span key={section.id}><button type="button" className={styles.secondaryButton} onClick={() => void moveSection(index, -1)} disabled={sectionManaging || index === 0} aria-label={`上移 ${section.name}`}>↑</button><button type="button" className={styles.secondaryButton} onClick={() => void moveSection(index, 1)} disabled={sectionManaging || index === projectSections.length - 1} aria-label={`下移 ${section.name}`}>{section.name} ↓</button></span>)}{projectSections.length === 0 && <span className={styles.dateHint}>暂无分组，事项会显示在未分组。</span>}</div></div>
            <form className={styles.captureSourceRow} onSubmit={(event) => { event.preventDefault(); void createSection(); }}><input value={newSectionName} onChange={(event) => setNewSectionName(event.target.value)} placeholder="新建分组名称" maxLength={80} aria-label="新建项目分组" /><button type="submit" className={styles.primaryButton} disabled={sectionManaging || !newSectionName.trim()}>{sectionManaging ? '处理中…' : '新建分组'}</button></form>
          </section>}

          {!isLifecycleView && !isContextMode && <div className={styles.captureRegion}>
          <div className={styles.quickAdd}>
            <CaptureComposer
              ref={captureComposerRef}
              value={captureBody}
              onChange={(next)=>{setCaptureBody(next)}}
              onComposingChange={setCaptureComposing}
              onSubmit={() => void createTask()}
              onAttachFiles={onCaptureAttachFiles}
              onPickMedia={(kind) => captureAttachmentsRef.current?.openPicker(kind)}
              onRecord={() => { setCaptureBatchOpen(false); audioRecorderRef.current?.start(); }}
              onBatch={() => { setCaptureBatchOpen((open) => !open); }}
              submitDisabled={creating || captureFilesPending || captureAudioPending || (!captureBody.trim() && !captureAssets.length && !captureAudioAssetIds.length)}
              hint="⌘/Ctrl+Enter 保存"
              placeholder="记下你现在想到的事…（⌘/Ctrl+Enter 保存，/ 打开功能菜单）"
            />
            <div className={styles.captureMediaRow}>
              <CaptureAttachments
                ref={captureAttachmentsRef}
                variant="flat"
                key={`${captureDraftId}:${captureMediaKey}`}
                initialAssets={captureAssets}
                onChange={onCaptureAssetsChange}
                onPendingChange={onCaptureFilePending}
                commitToken={captureCommitToken}
              />
              <AudioRecorder ref={audioRecorderRef} variant="flat" mode="staged" taskId="" expectedVersion={0} onVersionChange={()=>undefined} onAttached={()=>undefined} onPendingChange={onCaptureRecordingPending} onStagedAsset={(assetId)=>setCaptureAudioAssetIds(ids=>ids.includes(assetId)?ids:[...ids,assetId])} onDiscardStaged={(assetId)=>setCaptureAudioAssetIds(ids=>ids.filter(id=>id!==assetId))} commitToken={captureCommitToken}/>
            </div>
          </div>
          {captureDraftStatus&&<div className={styles.captureDraftNotice} role="status"><span>{captureDraftStatus}</span>{captureDraftAvailable&&<><button type="button" onClick={()=>applyCaptureDraft(captureDraftAvailable)}>恢复本机草稿</button><button type="button" onClick={()=>void dismissAvailableCaptureDraft()}>保留当前输入</button></>}</div>}
          {captureBatchOpen && <div className={styles.captureBatchPanel} role="region" aria-label="批量创建">
            <div className={styles.captureBatchHead}><strong>批量创建</strong><button type="button" className={styles.captureBatchClose} onClick={()=>setCaptureBatchOpen(false)} aria-label="关闭">×</button></div>
            <textarea ref={captureMultiRef} value={captureMultiText} onChange={e=>{setCaptureMultiText(e.target.value);setCapturePreviewRows([]);captureBatchRequest.current=null}} placeholder="每行一件事；先预览，不会自动拆分" />
            <button type="button" className={styles.secondaryButton} onClick={previewCaptureBatch}>预览拆分</button>
            {capturePreviewRows.length>0&&<div className={styles.capturePreview}><strong>预览 {capturePreviewRows.length} 条（可逐条修改）</strong>{capturePreviewRows.map((row,index)=><label key={index}><span>{index+1}</span><input value={row} onChange={e=>setCapturePreviewRows(rows=>rows.map((item,i)=>i===index?e.target.value:item))} maxLength={200}/><button type="button" onClick={()=>setCapturePreviewRows(rows=>rows.filter((_,i)=>i!==index))}>移除</button></label>)}<button type="button" className={styles.primaryButton} onClick={()=>void submitCaptureBatch()} disabled={captureBatchBusy||!capturePreviewRows.length}>{captureBatchBusy?'提交中…':'确认创建整批'}</button></div>}
          </div>}
          </div>}
          {notice && <div className={styles.toast} role="status"><span className={styles.toastIcon}>✓</span><span>{notice}</span>{captureUndo && !captureUndoBusy && <button className={styles.toastUndo} onClick={() => void undoCapture()}>撤销</button>}<button onClick={() => { setNotice(''); setCaptureUndo(null); }} aria-label="关闭通知">×</button></div>}
          {activeError && <div className={styles.errorBanner} role="alert"><span>{activeError}</span><button onClick={() => isSearchMode ? void loadSearch(searchQuery, searchOffset) : isReviewMode ? void loadReview(reviewKind!, reviewOffset) : void loadItems()}>重试</button></div>}

          <div className={styles.listToolbar}>
            {!isLifecycleView && !isContextMode && <div className={styles.filterRow} aria-label="列表筛选">
              <span className={styles.filterLabel}>筛选</span>
              <label className={styles.filterField}><span>空间</span><select value={spaceFilter} onChange={(event) => { setSpaceFilter(event.target.value); setProjectFilter(''); }}><option value="">全部空间</option>{spaces.map((space)=><option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
              <label className={styles.filterField}><span>项目</span><select value={projectFilter} onChange={(event) => { setProjectFilter(event.target.value); if (event.target.value) setSpaceFilter(''); }}><option value="">全部项目</option>{projects.map((project)=><option key={project.id} value={project.id}>{project.spaceName} / {project.name}</option>)}</select></label>
            </div>}
            <div className={styles.listHeader}>{isContextMode ? <div className={styles.contextListTitle}><span className={styles.contextListDot}>{isSearchMode ? '⌕' : '◌'}</span><span>{isSearchMode ? '搜索结果' : '回顾结果'}</span><span className={styles.contextListHint}>只读浏览，打开详情继续处理</span></div> : <div className={styles.viewTabs} role="tablist" aria-label="事项列表视图">
              <button role="tab" aria-selected={view === 'inbox'} className={view === 'inbox' ? styles.tabActive : ''} onClick={() => setView('inbox')}>待整理<span>{view === 'inbox' ? total : ''}</span></button>
              <button role="tab" aria-selected={view === 'all'} className={view === 'all' ? styles.tabActive : ''} onClick={() => setView('all')}>全部</button>
            </div>}<span className={styles.sortLabel}>{isSearchMode ? '相关性' : isReviewMode ? '成果优先' : '最近创建'} <span>↓</span></span></div>
          </div>

          <div className={styles.taskList} aria-live="polite">
            {activeLoading ? <div className={styles.skeletonList}><div/><div/><div/><div/></div> : activeItems.length === 0 ? (
              <div className={styles.emptyState}><div className={styles.emptyIcon}><span>↳</span></div><h2>{viewEmptyText[view] ?? '还没有事项'}</h2><p>{view === 'inbox' ? '做得好。新想到的事情可以继续记在上方。' : isLifecycleView ? '这里不会显示活跃事项；完成归档或恢复后，事项会回到工作台。' : projectFilter ? '在项目视图新增会让事项直接归入该项目。' : '可以切换视图或清除筛选，也可以直接从上方新增。'}</p>{!isLifecycleView && <button onClick={() => captureComposerRef.current?.focus()}>＋ 新增一件事</button>}</div>
            ) : activeItems.map((item) => <article className={`${styles.taskRow} ${isLifecycleView ? styles.lifecycleTaskRow : ''} ${isContextMode ? styles.contextTaskRow : ''}`} key={item.id}>
              {isLifecycleView ? <span className={styles.lifecycleMarker} aria-hidden="true">{view === 'archived' ? '▤' : '⌫'}</span> : isContextMode ? <span className={styles.contextMarker} aria-hidden="true">{isSearchMode ? '⌕' : '◌'}</span> : <button className={`${styles.processButton} ${item.isProcessed ? styles.processed : ''}`} onClick={() => void markProcessed(item)} disabled={item.isProcessed || Boolean(processingId)} aria-label={item.isProcessed ? `已整理：${item.title}` : `完成整理：${item.title}`} title={item.isProcessed ? '已整理' : '完成整理'}>{item.isProcessed ? '✓' : processingId === item.id ? <span className={styles.spinnerDark}/> : '✓'}</button>}
              <button type="button" className={`${styles.taskMain} ${isLifecycleView ? styles.lifecycleTaskMain : ''} ${isContextMode ? styles.contextTaskMain : ''}`} onClick={(isLifecycleView && !isContextMode) ? undefined : () => void openDetail(item)} disabled={isLifecycleView && !isContextMode}><span className={styles.taskTitle}>{item.title}{item.isProjectRoot&&<i className={styles.projectRootBadge}>项目目标</i>}</span><span className={styles.taskMeta}><span className={styles.spacePill}><i/> {item.spaceName}</span>{item.sectionId&&<span className={styles.spacePill}>▤ {projectSections.find((section)=>section.id===item.sectionId)?.name ?? '已分组'}</span>}{item.handlingMode==='other' && item.counterpartName && <span className={styles.spacePill}><i/> {item.counterpartName}</span>}{riskLabels.filter(([key])=>item.risk?.[key]).map(([key,label])=><span key={key} className={styles.riskPill}>{label}</span>)}<span className={styles.taskDate}>{dateLabel(item.createdAt)}</span></span>
                {isContextMode && <span className={styles.contextMeta}>{item.path && item.path.length > 1 && <span className={styles.pathTrail}><b>路径</b>{item.path.map((part, index) => <span key={part.id} className={styles.pathPart}>{index > 0 && <i>›</i>}{part.title}</span>)}</span>}{isSearchMode && item.matches && item.matches.length > 0 && <span className={styles.matchList}><b>命中</b>{Array.from(new Set(item.matches.map((match) => matchNames[match.type] ?? match.type))).slice(0, 4).map((label) => <span key={label} className={styles.matchTag}>{label}</span>)}</span>}{isSearchMode && (item.sourceLabel || item.sourceUrl) && <span className={styles.reviewOutcome}><b>来源</b>{item.sourceLabel || item.sourceUrl}</span>}{isReviewMode && item.reviewKind === 'completed' && item.resultNote && <span className={styles.reviewOutcome}><b>成果</b>{item.resultNote}</span>}{isReviewMode && item.reviewKind === 'cancelled' && item.cancellationReason && <span className={styles.reviewOutcome}><b>取消原因</b>{item.cancellationReason}</span>}{isReviewMode && item.reviewKind === 'waiting' && <span className={styles.reviewOutcome}><b>跟进</b>{item.followUpDate ? dateLabel(item.followUpDate) : '尚未设置'}</span>}</span>}
              </button>
              {isLifecycleView ? <div className={styles.lifecycleRowActions}><span>{view === 'archived' ? '归档批次' : '删除批次'}</span><button type="button" className={styles.historyButton} onClick={() => void openLifecycleHistory(item)}>查看历史</button><button type="button" className={view === 'trash' ? styles.lifecycleRestoreButton : styles.lifecycleActionButton} onClick={() => void restoreLifecycleItem(item)} disabled={Boolean(lifecycleActionId)}>{lifecycleActionId === item.id ? '处理中…' : view === 'archived' ? '取消归档' : '恢复'}</button></div> : isContextMode ? <span className={styles.contextRowAction}>打开详情 <span>→</span></span> : <><div className={styles.rowAttributes}><StatusEditor task={item} popoverKey={attributePopover} onPopoverChange={setAttributePopover} save={saveAttribute} /><PriorityEditor task={item} popoverKey={attributePopover} onPopoverChange={setAttributePopover} save={saveAttribute} /><DatesEditor task={item} popoverKey={attributePopover} onPopoverChange={setAttributePopover} save={saveAttribute} /><HandlingEditor task={item} popoverKey={attributePopover} onPopoverChange={setAttributePopover} save={saveAttribute} /></div><button className={styles.rowEdit} aria-label={`编辑 ${item.title}`} onClick={() => void openDetail(item)}>↗</button></>}
            </article>)}
          </div>
          {(isSearchMode || isReviewMode) && activeTotal > activeItems.length && <div className={styles.pagination}><button type="button" className={styles.secondaryButton} disabled={activeLoading || (isSearchMode ? searchOffset : reviewOffset) <= 0} onClick={() => isSearchMode ? void loadSearch(searchQuery, Math.max(0, searchOffset - 50)) : void loadReview(reviewKind!, Math.max(0, reviewOffset - 50))}>上一页</button><span>第 {Math.floor((isSearchMode ? searchOffset : reviewOffset) / 50) + 1} 页 · 共 {activeTotal} 条</span><button type="button" className={styles.secondaryButton} disabled={activeLoading || (isSearchMode ? searchOffset + activeItems.length >= activeTotal : reviewOffset + activeItems.length >= activeTotal)} onClick={() => isSearchMode ? void loadSearch(searchQuery, searchOffset + 50) : void loadReview(reviewKind!, reviewOffset + 50)}>下一页</button></div>}
          <div className={styles.listFooter}>{!activeLoading && activeTotal > 0 && <span>显示 {activeItems.length} 件，共 {activeTotal} 件</span>}{!isContextMode && items.length < total && <button className={styles.loadMore} onClick={() => void loadMoreItems()} disabled={loadingMore}>{loadingMore ? '加载中…' : '加载更多'}</button>}</div>
        </div>
      </section>

      {selected && <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetail(); }}>
        <section className={styles.detailPanel} aria-labelledby="detail-title">
          <header className={styles.detailHeader}><button className={styles.backButton} type="button" onClick={closeDetail} aria-label="返回事项列表">←</button><div className={styles.detailHeaderTitle}><span className={styles.detailEyebrow}>事项详情</span><h2 id="detail-title">编辑事项</h2></div><div className={styles.detailHeaderActions}><select aria-label="状态操作" value={transitionStatus} onChange={(event)=>setTransitionStatus(event.target.value)} disabled={transitioning}><option value="">{statusNames[selected.status] ?? selected.status}</option>{(nextStatuses[selected.status]??[]).map((status)=><option key={status} value={status}>{status==='todo'&&(selected.status==='done'||selected.status==='cancelled')?'重新打开':statusNames[status]}</option>)}</select>{transitionStatus && <button type="button" className={styles.secondaryButton} onClick={()=>void submitTransition()} disabled={transitioning}>{transitioning?'更新中…':'应用状态'}</button>}<button type="submit" form="detail-editor-form" className={styles.primaryButton} disabled={bodySaving || !detailTitle.trim() || (!hasBodyChanges && !hasPlanningChanges && detailTitle.trim() === (detail?.title ?? detailTitle))}>{bodySaving?'保存中…':'保存'}</button>{detail && <div className={styles.lifecycleMenuWrap}><button type="button" className={styles.secondaryButton} aria-haspopup="menu" aria-expanded={lifecycleMenuOpen} onClick={()=>setLifecycleMenuOpen((open)=>!open)}>更多</button>{lifecycleMenuOpen && <div className={styles.lifecycleMenu} role="menu"><button type="button" role="menuitem" onClick={()=>openLifecycleDialog('archive')}>归档事项</button><button type="button" role="menuitem" className={styles.lifecycleDangerItem} onClick={()=>openLifecycleDialog('delete')}>移入回收站</button></div>}</div>}<button className={styles.closeButton} type="button" onClick={closeDetail} aria-label="关闭详情">×</button></div></header>
          {detailLoading ? <div className={styles.detailLoading}><span className={styles.spinnerDark}/> 正在读取详情</div> : detailError && !detail ? <div className={styles.errorBanner}><span>{detailError}</span><button onClick={() => selected && void openDetail(selected)}>重试</button></div> : detail && <>
            <form id="detail-editor-form" className={styles.detailForm} onSubmit={(event) => { event.preventDefault(); void saveContent(); }}>
              <label className={styles.fieldLabel} htmlFor="task-title">标题</label>
              <input id="task-title" className={styles.titleField} value={detailTitle} onChange={(event) => { setDetailTitle(event.target.value); if (editRequest.current?.title !== event.target.value.trim()) editRequest.current = null; }} maxLength={200} autoFocus />
              <div className={styles.detailAttributeBar} aria-label="快速编辑事项属性"><StatusEditor task={detail} popoverKey={attributePopover} onPopoverChange={setAttributePopover} save={saveAttribute} align="left" /><PriorityEditor task={detail} popoverKey={attributePopover} onPopoverChange={setAttributePopover} save={saveAttribute} align="left" /><DatesEditor task={detail} popoverKey={attributePopover} onPopoverChange={setAttributePopover} save={saveAttribute} align="left" /><HandlingEditor task={detail} popoverKey={attributePopover} onPopoverChange={setAttributePopover} save={saveAttribute} align="left" /><span className={styles.detailSpaceHint}><span className={styles.spacePill}><i/> {detail.spaceName}</span>{detail.isProjectRoot&&<span className={styles.projectRootBadge}>项目目标</span>}</span></div>
              {detail.sourceUrl&&<div className={styles.sourceLink}><span>来源</span><a href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">{detail.sourceLabel||detail.sourceUrl}</a></div>}
              {restoredDraft && <div className={restoredDraft.kind === 'conflict' ? styles.draftConflict : styles.draftNotice} role="status">
                {restoredDraft.kind === 'restored'
                  ? <span>已恢复本机未提交草稿（基于第 {restoredDraft.draft.baseVersion} 版，保存于 {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(restoredDraft.draft.updatedAt))}）。这些内容尚未写入服务器。</span>
                  : <span>服务器已更新到第 {restoredDraft.serverVersion} 版；本机还有基于第 {restoredDraft.draft.baseVersion} 版的未提交草稿。请选择保留哪一份，不会被静默覆盖。</span>}
                <span className={styles.draftActions}>
                  {restoredDraft.kind === 'conflict' && <button type="button" className={styles.secondaryButton} onClick={() => useMyDraft()}>使用我的草稿</button>}
                  <button type="button" className={styles.secondaryButton} onClick={() => void discardDraft()}>{restoredDraft.kind === 'conflict' ? '以服务器为准' : '放弃草稿'}</button>
                </span>
              </div>}
              <section className={styles.bodyPanel} aria-label="内容说明">
                <div className={styles.bodyPanelHead}><h3>内容说明</h3><span className={styles.bodyRequiredHint}>正文为空也可以直接开始写</span></div>
                <RichBodyEditor ref={richBodyEditorRef} value={description} mode={bodyView} disabled={bodySaving} isLegacyPlaintext={descriptionFormat==='plaintext'} onModeChange={setBodyView} onConvert={convertToMarkdown} onChange={(next) => { setDescription(next); resetBodyRequests(); }} />
                <div className={styles.bodyMeta}>
                  <span className={codePointLength(description)>BODY_MAX_CODE_POINTS?styles.bodyOverLimit:''}>{codePointLength(description)}/{BODY_MAX_CODE_POINTS} 字符</span>
                  {descriptionFormat==='plaintext' && <span className={styles.bodyHint}>旧纯文本正文不会被自动解释为 Markdown。</span>}
                  {bodyFlags.hasUnsupportedSyntax && <span className={styles.bodyHint}>存在超出共同子集的写法，已按原样保留。</span>}
                  {bodyFlags.hasTaskListSyntax && <span className={styles.bodyHint}>检测到 - [ ] 复选框：可在下方小步骤清单转换或保留。</span>}
                </div>
                <div className={styles.bodyActions}><span className={styles.bodySaveState}>{bodySaving ? '保存中…' : (hasBodyChanges || hasPlanningChanges || detailTitle.trim() !== detail.title) ? '未保存' : '已保存'}{draftUnsupported ? ' · 本机无法保存草稿' : draftSavedAt && (hasBodyChanges || hasPlanningChanges || detailTitle.trim() !== detail.title) ? ' · 本机草稿（未提交）' : ''}</span><button type="button" className={styles.secondaryButton} onClick={()=>{ const next=!bodyRevisionsOpen; setBodyRevisionsOpen(next); if(next) void loadBodyRevisions(); }}>{bodyRevisionsOpen ? '收起正文历史' : '正文历史'}</button></div>
                {bodyRevisionsOpen && <ol className={styles.revisionList}>{bodyRevisionsLoading ? <li>正在读取正文历史…</li> : bodyRevisions.length === 0 ? <li>暂无正文历史；保存一次正文后会生成第一版。</li> : bodyRevisions.map((revision)=><li key={revision.id}><div className={styles.revisionHead}><span>第 {revision.taskVersion} 版 · {revision.format==='markdown_v1' ? 'Markdown' : '纯文本'}</span><time dateTime={revision.createdAt}>{new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(revision.createdAt))}</time></div><p>{revision.content.length>140 ? revision.content.slice(0,140)+'…' : revision.content}</p><button type="button" className={styles.secondaryButton} onClick={()=>{ setDescription(revision.content); setBodyView('visual'); resetBodyRequests(); setNotice('已把第 '+revision.taskVersion+' 版内容复制到编辑区，保存后才会成为新版本'); }}>复制到编辑区</button></li>)}</ol>}
              </section>
              <section className={styles.timelinePanel} aria-label="追加进展与历史时间线">
                <h3>追加进展</h3>
                <details className={styles.progressAudio}><summary>录制语音作为本次进展{progressAudioAssetIds.length?`（${progressAudioAssetIds.length}段待提交）`:''}</summary><AudioRecorder mode="staged" taskId={detail.id} expectedVersion={detail.version} onVersionChange={()=>undefined} onAttached={()=>undefined} onPendingChange={onProgressRecordingPending} onStagedAsset={(assetId)=>setProgressAudioAssetIds((ids)=>ids.includes(assetId)?ids:[...ids,assetId])} onDiscardStaged={(assetId)=>setProgressAudioAssetIds((ids)=>ids.filter((id)=>id!==assetId))} commitToken={progressCommitToken} /></details>
                <textarea value={progressText} onChange={(event)=>setProgressText(event.target.value)} placeholder="记录刚发生的进展；历史不可修改，写错请追加更正" />
                <div className={styles.timelineActions}><small className={styles.charCount}>{[...progressText].length}/5000</small><button type="button" className={styles.primaryButton} onClick={()=>void appendProgress()} disabled={progressSaving||(!progressText.trim()&&!progressAudioAssetIds.length)}>{progressSaving?'提交中…':progressAudioAssetIds.length?'追加进展与录音':'追加进展'}</button></div>
                <div className={styles.timelineHeader}><h3>历史时间线</h3>{eventsHasMore&&<button type="button" className={styles.secondaryButton} onClick={()=>events.length>0&&void loadEvents(detail.id,events[0])} disabled={eventsLoading}>{eventsLoading?'加载中…':'查看更早事件'}</button>}</div>
                {events.length===0?<p className={styles.dateHint}>{eventsLoading?'正在读取历史…':'暂无历史事件。'}</p>:<ol className={styles.timelineList}>{events.map((event)=><li key={event.id}><div className={styles.timelineHead}><span>{eventNames[event.type]??event.type}</span><time dateTime={event.occurredAt}>{new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(event.occurredAt))}</time></div>{eventDetail(event)&&<p>{eventDetail(event)}</p>}{Array.isArray(event.payload.mediaAttachments)&&<div className={styles.progressMedia}>{(event.payload.mediaAttachments as Array<{id:string;linkId:string;removedAt:string|null;originalName:string;mimeType:string;byteSize:number;durationMs:number|null;contentUrl:string}>).map((asset)=><div key={asset.linkId}>{asset.removedAt?<span>录音附件已移除：{asset.originalName}</span>:<><span>{asset.originalName}{asset.durationMs?` · ${Math.ceil(asset.durationMs/1000)}秒`:''}</span><audio controls preload="metadata" src={apiUrl(asset.contentUrl)} aria-label={`播放进展录音 ${asset.originalName}`} /><a href={apiUrl(asset.contentUrl)} download={asset.originalName}>下载</a><button type="button" onClick={()=>void removeProgressAudio(asset.linkId,asset.originalName)}>移除此处录音</button></>}</div>)}</div>}</li>)}</ol>}
              </section>
<section className={styles.checklistPanel} aria-label="小步骤清单">
                <div className={styles.checklistHead}>
                  <h3>小步骤清单</h3>
                  <span className={styles.checklistCount}>{checklistStats.checked}/{checklistStats.total} 已完成 · 不参与事项计数</span>
                </div>
                <p className={styles.dateHint}>小步骤只有文本、勾选与排序：没有独立日期或处理方，勾选不会改变事项状态，也不会出现在今天/搜索里。</p>
                {checklistLoading
                  ? <p className={styles.checklistEmpty}>正在读取小步骤…</p>
                  : checklist.length === 0
                    ? <p className={styles.checklistEmpty}>还没有小步骤。需要独立日期或跟进的工作请另建事项。</p>
                    : <ol className={styles.checklistList}>
                        {checklist.map((item, index) => <li key={item.id} className={item.isChecked ? styles.checklistDone : ''}>
                          <input type="checkbox" checked={item.isChecked} disabled={checklistBusy === item.id} onChange={() => void toggleChecklistItem(item)} aria-label={'勾选小步骤 ' + item.text} />
                          {editingItemId === item.id
                            ? <span className={styles.checklistEdit}>
                                <input value={editingText} onChange={(event) => setEditingText(event.target.value)} aria-label="小步骤文本" maxLength={500} />
                                <button type="button" className={styles.secondaryButton} onClick={() => void saveChecklistText(item)} disabled={checklistBusy === item.id}>保存</button>
                                <button type="button" className={styles.secondaryButton} onClick={() => setEditingItemId('')}>取消</button>
                              </span>
                            : <button type="button" className={styles.checklistText} onClick={() => { setEditingItemId(item.id); setEditingText(item.text); }} aria-label={'编辑小步骤 ' + item.text}>{item.text}</button>}
                          <span className={styles.checklistActions}>
                            <button type="button" onClick={() => void moveChecklistItem(item, 'up')} disabled={index === 0 || checklistBusy === item.id} aria-label={'上移 ' + item.text}>↑</button>
                            <button type="button" onClick={() => void moveChecklistItem(item, 'down')} disabled={index === checklist.length - 1 || checklistBusy === item.id} aria-label={'下移 ' + item.text}>↓</button>
                            <button type="button" onClick={() => void removeChecklistItem(item)} disabled={checklistBusy === item.id} aria-label={'删除 ' + item.text}>删除</button>
                          </span>
                        </li>)}
                      </ol>}
                <div className={styles.checklistAdd}>
                  <input value={checklistText} onChange={(event) => setChecklistText(event.target.value)} placeholder="添加一条小步骤（无日期、无处理方）" aria-label="添加小步骤" maxLength={500} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addChecklistItem(); } }} />
                  <button type="button" className={styles.secondaryButton} onClick={() => void addChecklistItem()} disabled={checklistBusy === 'create' || !checklistText.trim()}>{checklistBusy === 'create' ? '添加中…' : '添加小步骤'}</button>
                </div>
                {staticChecklistCandidates.length > 0 && !staticChecklistDismissed && <div className={styles.checklistImport}>
                  <span>正文里有 {staticChecklistCandidates.length} 行 `- [ ]` 复选框，目前只是静态文本。</span>
                  <button type="button" className={styles.secondaryButton} onClick={() => void importStaticChecklist()} disabled={checklistImporting}>{checklistImporting ? '转换中…' : '转为小步骤'}</button>
                  <button type="button" className={styles.secondaryButton} onClick={() => setStaticChecklistDismissed(true)}>保留静态文本</button>
                </div>}
                {checklistError && <p className={styles.checklistError} role="alert">{checklistError}</p>}
                {checklistStats.unchecked > 0 && <p className={styles.dateHint}>完成事项前会提示仍有 {checklistStats.unchecked} 项未勾选；勾选不会被自动批量完成。</p>}
              </section>
              <TaskAttachments key={`attachments:${detail.id}`} taskId={detail.id} expectedVersion={detail.version} onVersionChange={(version)=>{setDetail((current)=>current?{...current,version}:current);void loadEvents(detail.id)}} onInsertImage={insertAssetIntoBody} onPendingChange={onAttachmentPendingChange} />
              <TaskTreePanel key={`tree:${detail.id}`} task={{id:detail.id,title:detail.title,spaceId:detail.spaceId,parentId:detail.parentId,version:detail.version,structureVersion:detail.structureVersion,spaceStructureVersion:detail.spaceStructureVersion,status:detail.status}} onOpen={(id)=>void openTaskFromTree(id)} onRefresh={()=>void refreshTreeDetail()} onChildCountChange={setDetailChildCount}/><TaskReferencesPanel key={`references:${detail.id}`} taskId={detail.id} expectedStructureVersion={detail.structureVersion} onOpen={(id)=>void openTaskFromTree(id)} onStructureVersionChange={(version)=>setDetail((current)=>current?{...current,structureVersion:version}:current)} />
              <details className={styles.moreInfo}><summary>更多信息</summary><div className={styles.moreInfoGrid}><span>创建于</span><b>{new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(detail.createdAt))}</b><span>整理状态</span><b>{detail.isProcessed ? '已整理' : '待整理'}</b><span>版本</span><b>{detail.version}</b></div></details>
              {detail.status==='waiting' && <div className={styles.detailInfo}><span>等待原因</span><b>{detail.waitingReason}</b></div>}
              {detail.status==='cancelled' && <div className={styles.detailInfo}><span>取消原因</span><b>{detail.cancellationReason}</b></div>}
                            <details className={styles.arrangementPanel}><summary>安排 <span>日期、归属、处理方式与下一步</span></summary>
<section className={styles.placementPanel} aria-label="归属">
                <h3>归属</h3>
                <div className={styles.dateGrid}>
                  <label className={styles.fieldLabel}>空间<select value={placementSpace} onChange={(event) => { setPlacementSpace(event.target.value); setPlacementProject(''); }}>{spaces.map((space)=><option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
                  <label className={styles.fieldLabel}>项目<select value={placementProject} onChange={(event) => setPlacementProject(event.target.value)}><option value="">无项目</option>{projects.filter((project) => project.spaceId === placementSpace).map((project)=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
                </div>
                <p className={styles.dateHint}>移动到其他空间时，目标项目必须同属该空间；改变归属需显式保存。</p>
                <button type="button" className={styles.primaryButton} onClick={() => void savePlacement()} disabled={placementSaving || !hasPlacementChanges}>{placementSaving ? '保存中…' : '保存归属'}</button>
                <div className={styles.dateGrid}>
                  <label className={styles.fieldLabel}>分组
                    <select value={placementSection} onChange={(event) => setPlacementSection(event.target.value)} disabled={!canAssignSection || sectionsLoading}>
                      <option value="">未分组</option>{projectSections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
                    </select>
                  </label>
                </div>
                <p className={styles.dateHint}>{canAssignSection ? '分组只安排项目根的直接子项；更深层子项按层级组织。' : '只有项目根的直接子项可以安排分组。'}</p>
                <button type="button" className={styles.secondaryButton} onClick={() => void saveSection()} disabled={sectionSaving || !hasSectionChanges}>{sectionSaving ? '保存中…' : '保存分组'}</button>
              </section>
              <section className={styles.handlingPanel} aria-label="处理安排">
                <h3>处理安排</h3>
                <label className={styles.fieldLabel}>处理方式<select value={handlingMode} onChange={(event) => setHandlingMode(event.target.value)} disabled={detail.status === 'done' || detail.status === 'cancelled'}><option value="self">自己处理</option><option value="other">交给别人</option></select></label>
                {handlingMode === 'other' && <label className={styles.fieldLabel}>交给谁<input value={counterpartName} onChange={(event) => setCounterpartName(event.target.value)} placeholder="例如：张三（工程）/ 物业" maxLength={100} /></label>}
                <p className={styles.dateHint}>这只是本人记录该由谁处理，不代表对方已收到，也不会自动改变状态与日期。</p>
                {(detail.status === 'done' || detail.status === 'cancelled') && <p className={styles.dateHint}>结束事项不能改处理方式，请先重新打开。</p>}
                <button type="button" className={styles.primaryButton} onClick={() => void saveHandling()} disabled={handlingSaving || !hasHandlingChanges || (handlingMode === 'other' && !counterpartName.trim())}>{handlingSaving ? '保存中…' : '保存处理安排'}</button>
              </section>
              <section className={styles.planningPanel} aria-label="安排与执行">
                <h3>安排与执行</h3>
                <label className={styles.fieldLabel}>优先级<select value={priority} onChange={(event)=>setPriority(event.target.value)}><option value="none">无</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
                <div className={styles.dateGrid}>
                  <label className={styles.fieldLabel}>计划日期<input type="date" value={plannedDate} onChange={(event)=>setPlannedDate(event.target.value)} /></label>
                  <label className={styles.fieldLabel}>截止日期<input type="date" value={dueDate} onChange={(event)=>setDueDate(event.target.value)} /></label>
                  <label className={styles.fieldLabel}>下次跟进<input type="date" value={followUpDate} onChange={(event)=>setFollowUpDate(event.target.value)} disabled={detail.status==='done'||detail.status==='cancelled'} /></label>
                </div>
                {(plannedDate||dueDate||followUpDate) && <p className={styles.dateHint}>允许填写过去日期；系统不会自动改为今天。</p>}
                {plannedDate&&dueDate&&plannedDate>dueDate&&<p className={styles.formWarning} role="alert">计划日期不能晚于截止日期。</p>}
                {followUpDate&&dueDate&&followUpDate>dueDate&&<p className={styles.formWarning}>跟进日期晚于截止日期，可能无法及时处理。</p>}
                {(detail.status==='done'||detail.status==='cancelled')&&<p className={styles.dateHint}>结束事项不能新增跟进日期；如需安排，请先重新打开。</p>}
                <label className={styles.fieldLabel}>下一步动作<textarea value={nextAction} onChange={(event)=>setNextAction(event.target.value)} placeholder="例如：联系供应商确认交付时间" /><small className={styles.charCount}>{[...nextAction].length}/500</small></label>
                {detail.status === 'done' && <label className={styles.fieldLabel}>成果说明<textarea value={resultNote} onChange={(event)=>setResultNote(event.target.value)} placeholder="完成后留下结果、决策或可复用信息" maxLength={5000} /><small className={styles.charCount}>{[...resultNote].length}/5000 · 会出现在完成回顾中</small></label>}
                <label className={styles.fieldLabel}>阻塞原因<textarea value={blockedReason} onChange={(event)=>setBlockedReason(event.target.value)} placeholder="没有阻塞可留空" /><small className={styles.charCount}>{[...blockedReason].length}/1000</small></label>
              </section>
                            </details>
              <details className={styles.advancedPanel}><summary>高级操作 <span>小步骤提升为独立事项、启用项目视图</span></summary><div className={styles.advancedPanelBody}>
              <ChecklistPromotionPanel key={`promotion:${detail.id}`} taskId={detail.id} expectedVersion={detail.version} expectedStructureVersion={detail.structureVersion} onOpen={(id)=>void openTaskFromTree(id)} onStructureVersionChange={(version)=>setDetail((current)=>current?{...current,structureVersion:version}:current)} />
              {!detail.isProjectRoot && <EnableProjectPanel key={`enable-project:${detail.id}`} taskId={detail.id} expectedVersion={detail.version} expectedStructureVersion={detail.structureVersion} onEnabled={onProjectEnabled} />}
              </div></details>
              {detailError && <div className={styles.detailError} role="alert"><span>{detailError}</span><small className={styles.retainHint}>输入已保留，可修改后重试</small></div>}
              <div className={styles.detailActions}><span className={styles.unifiedSaveState}>{bodySaving ? '保存中…' : (hasBodyChanges || hasPlanningChanges || detailTitle.trim() !== detail.title) ? '有未保存修改' : '已保存'}</span><button type="button" className={styles.secondaryButton} onClick={() => closeDetail()}>关闭</button></div>
            </form>
            {lifecycleDialog && <div className={styles.lifecycleOverlay} onMouseDown={(event)=>{if(event.target===event.currentTarget&&!lifecycleBusy)setLifecycleDialog(null)}}><section className={styles.lifecycleDialog} role="dialog" aria-modal="true" aria-labelledby="lifecycle-dialog-title"><div className={styles.lifecycleDialogHeader}><div><span className={styles.detailEyebrow}>影响范围操作</span><h3 id="lifecycle-dialog-title">{lifecycleDialog.operation==='archive'?'归档事项':'移入回收站'}</h3></div><button type="button" className={styles.closeButton} onClick={()=>setLifecycleDialog(null)} disabled={lifecycleBusy} aria-label="关闭操作窗口">×</button></div>{lifecycleDialog.step==='save'?<><p>当前详情还有未提交的标题、正文或安排修改。生命周期操作不会替你猜测这些内容，请先选择如何处理。</p><div className={styles.lifecycleSaveChoices}><button type="button" className={styles.primaryButton} onClick={()=>void continueLifecycleWithSavedContent()} disabled={lifecycleBusy}>{lifecycleBusy?'处理中…':'保存后继续'}</button><button type="button" className={styles.secondaryButton} onClick={()=>void continueLifecycleWithDraft()} disabled={lifecycleBusy}>保留本机草稿并继续</button></div><p className={styles.lifecycleHint}>保留本机草稿只保存到当前浏览器，不代表服务器已保存；提交型进展、录音和独立安排不会被带入。</p></>:<><p>{lifecycleDialog.operation==='archive'?'归档会隐藏事项及其历史内容，但不会删除数据。':'移入回收站会软删除事项及相关结构，后续可按删除批次恢复。'}请选择实际影响范围：</p><fieldset className={styles.lifecycleScopes}><legend>处理范围</legend><label><input type="radio" name="lifecycle-scope" checked={lifecycleDialog.scope==='single'} onChange={()=>setLifecycleDialog((current)=>current?{...current,scope:'single'}:current)} /> 仅当前事项</label><label className={detailChildCount===0?styles.lifecycleDisabled:''}><input type="radio" name="lifecycle-scope" checked={lifecycleDialog.scope==='subtree'} onChange={()=>setLifecycleDialog((current)=>current?{...current,scope:'subtree'}:current)} disabled={detailChildCount===0} /> 整个主子树{detailChildCount===0?'（没有直接子事项）':`（已发现 ${detailChildCount} 个直接子事项，后代由服务端一并处理）`}</label></fieldset><p className={styles.lifecycleWarning}>{lifecycleDialog.scope==='subtree'?'将影响当前事项和全部主子事项；服务端会再次检查所有后代是否已结束。':detailChildCount>0?'当前事项仍有子事项；若后代未结束，单独操作会被服务端拒绝。':'只影响当前事项。'}</p><div className={styles.lifecycleDialogActions}><button type="button" className={styles.secondaryButton} onClick={()=>setLifecycleDialog(null)} disabled={lifecycleBusy}>取消</button><button type="button" className={styles.dangerButton} onClick={()=>void executeLifecycle()} disabled={lifecycleBusy}>{lifecycleBusy?'处理中…':lifecycleDialog.operation==='archive'?'确认归档':'确认移入回收站'}</button></div></>}</section></div>}
            {!detail.isProcessed && <button className={styles.processDetail} onClick={() => void markProcessed(detail)} disabled={Boolean(processingId)}><span>✓</span> 完成整理，移出收件箱</button>}
          </>}
        </section>
      </div>}
      {historyTask && <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryTask(null); }}><section className={styles.historyDialog} aria-labelledby="history-dialog-title"><header className={styles.historyDialogHeader}><div><span className={styles.detailEyebrow}>只读回顾</span><h2 id="history-dialog-title">{historyTask.title}</h2></div><button type="button" className={styles.closeButton} onClick={() => setHistoryTask(null)} aria-label="关闭历史">×</button></header><p className={styles.historyHint}>{historyTask.deletedAt ? '回收站事项的历史保留；此处只读查看，不改变恢复状态。' : '归档事项的历史保留；此处只读查看，不改变归档状态。'}</p>{eventsLoading ? <div className={styles.detailLoading}><span className={styles.spinnerDark}/> 正在读取历史</div> : events.length === 0 ? <p className={styles.dateHint}>暂无历史事件。</p> : <ol className={styles.timelineList}>{events.map((event)=><li key={event.id}><div className={styles.timelineHead}><span>{eventNames[event.type] ?? event.type}</span><time dateTime={event.occurredAt}>{new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(event.occurredAt))}</time></div>{eventDetail(event)&&<p>{eventDetail(event)}</p>}</li>)}</ol>}</section></div>}
      <nav className={styles.mobileNav} aria-label="移动端导航"><button className={view === 'inbox' ? styles.mobileActive : ''} onClick={() => setView('inbox')}><span>▦</span>收件箱</button><button className={styles.mobileCapture} onClick={() => captureComposerRef.current?.focus()}>＋</button><button className={view === 'all' ? styles.mobileActive : ''} onClick={() => setView('all')}><span>◉</span>全部事项</button></nav>
    </main>
  );
}

export default function HomePage() {
  const [state, setState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const returnToLogin = useCallback(() => setState('login'), []);
  useEffect(() => { apiFetch('/api/auth/me').then((response) => setState(response.ok ? 'ready' : 'login')).catch(() => setState('login')); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await apiFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? '登录失败');
      setPassword(''); setState('ready');
    } catch (err) { setError(err instanceof Error ? err.message : '登录失败'); }
    finally { setBusy(false); }
  }
  if (state === 'checking') return <main className={styles.authScreen}><p>正在检查登录状态…</p></main>;
  if (state === 'login') return <main className={styles.authScreen}><form className={styles.loginCard} onSubmit={submit}><span className={styles.brandMark}>知</span><h1>欢迎回来</h1><p>登录你的个人事务空间</p><label>账号<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <div className={styles.authError} role="alert">{error}</div>}<button type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button><small>仅限已初始化的本人账号，不开放注册。</small></form></main>;
  return <InboxPage onSignOut={async () => { await apiFetch('/api/auth/logout', { method: 'POST' }); setState('login'); }} onUnauthorized={returnToLogin} />;
}

function AccountMenu({ onSignOut, signingOut }: { onSignOut?: () => void | Promise<void>; signingOut?: boolean }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const response = await apiFetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? '修改密码失败');
      setCurrent(''); setNext(''); setMessage('密码已修改，其他设备上的会话已撤销。');
    } catch (err) { setMessage(err instanceof Error ? err.message : '修改密码失败'); }
    finally { setBusy(false); }
  }
  return <div className={styles.settings}><button type="button" className={styles.accountMenuButton} onClick={() => setOpen(!open)}>账号</button>{open && <form className={styles.passwordMenu} onSubmit={change}><label>当前密码<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label><label>新密码（12–128字符）<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} required /></label>{message && <p role="status">{message}</p>}<button disabled={busy}>{busy ? '保存中…' : '修改密码'}</button>{onSignOut && <button type="button" className={styles.menuSignOut} disabled={signingOut} onClick={() => void onSignOut()}>{signingOut ? '退出中…' : '退出登录'}</button>}</form>}</div>;
}
