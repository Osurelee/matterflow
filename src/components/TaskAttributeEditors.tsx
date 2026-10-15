'use client';

/**
 * UX-03 行内属性编辑器（FRONTEND_REDESIGN_PRD C-01/C-02、P-02/P-08）：
 * 状态、优先级、日期（计划/截止/跟进，标注语义）、处理方式在触发行/详情属性条
 * 附近弹层中完成「选择即保存」，不进入整张详情表单，也没有统一总保存。
 *
 * 交互契约：
 * - 弹层锚定在触发控件附近；Esc/点击遮罩只取消当前未确认的选择（P-06）。
 * - 进入等待/取消在同一弹层补充必填原因；完成走小步骤确认守卫（C-01）。
 * - 交给谁为本人文本记录，不引入联系人目录（PRD 1.2）。
 * - 输入法组合期间不通过 Enter 提交；原因/名字仅在显式确认按钮提交（4.2）。
 * - 保存、失败、冲突的反馈都出现在动作附近；版本冲突后由父级刷新版本，可就地重试。
 */
import { useEffect, useRef, useState } from 'react';
import styles from './TaskAttributeEditors.module.css';

export const statusNames: Record<string, string> = {
  todo: '待处理', in_progress: '进行中', waiting: '等待中', done: '已完成', cancelled: '已取消',
};
export const priorityNames: Record<string, string> = { none: '无', low: '低', medium: '中', high: '高' };
const nextStatuses: Record<string, readonly string[]> = {
  todo: ['in_progress', 'waiting', 'done', 'cancelled'],
  in_progress: ['todo', 'waiting', 'done', 'cancelled'],
  waiting: ['todo', 'in_progress', 'done', 'cancelled'],
  done: ['todo'],
  cancelled: ['todo'],
};
const dateFieldNames: Record<DateField, string> = { plannedDate: '计划', dueDate: '截止', followUpDate: '跟进' };

export type DateField = 'plannedDate' | 'dueDate' | 'followUpDate';
export type AttrKind = DateField | 'priority' | 'status' | 'handling';

export type AttrTask = {
  id: string;
  status: string;
  version: number;
  priority: string;
  plannedDate: string | null;
  dueDate: string | null;
  followUpDate: string | null;
  handlingMode: string;
  counterpartName: string;
  risk?: { overdue: boolean; followUpDue: boolean; plannedDue: boolean };
};

export type AttrPayload = {
  priority?: string;
  plannedDate?: string | null;
  dueDate?: string | null;
  followUpDate?: string | null;
  status?: string;
  waitingReason?: string;
  cancellationReason?: string;
  handlingMode?: string;
  counterpartName?: string;
};

export type AttrSaveResult = 'saved' | 'noop' | 'failed' | 'conflict';
export type AttrSaveHandler = (task: AttrTask, kind: AttrKind, payload: AttrPayload) => Promise<AttrSaveResult>;

type CommonProps = {
  task: AttrTask;
  popoverKey: string | null;
  onPopoverChange: (key: string | null) => void;
  save: AttrSaveHandler;
  /** 详情属性条内左对齐，列表行内右对齐（避免贴边溢出） */
  align?: 'left' | 'right';
};

function isEnded(status: string) {
  return status === 'done' || status === 'cancelled';
}

function shanghaiDateAfter(days: number) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function shanghaiDaysUntilMonday() {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date());
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  return (8 - index) % 7 || 7;
}

function Chip({
  children, onClick, active, disabled, tone, ariaLabel, add,
}: {
  children: React.ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean;
  tone?: 'todo' | 'inProgress' | 'waiting' | 'done' | 'cancelled' | 'overdue' | 'due' | 'accent' | 'muted';
  ariaLabel?: string; add?: boolean;
}) {
  const toneClass = tone ? styles[`tone_${tone}`] ?? '' : '';
  return (
    <button
      type="button"
      className={`${styles.chip} ${toneClass} ${add ? styles.chipAdd : ''} ${active ? styles.chipActive : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={active}
    >{children}</button>
  );
}

/** 状态编辑：合法流转 + 就近补充等待/取消原因（C-01）。 */
export function StatusEditor({ task, popoverKey, onPopoverChange, save, align }: CommonProps) {
  const key = `status:${task.id}`;
  const open = popoverKey === key;
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) { setTarget(''); setReason(''); setError(''); setSaving(false); }
  }, [open]);

  function close(focus = false) {
    onPopoverChange(null);
    if (focus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function confirm() {
    if (!target || saving) return;
    if ((target === 'waiting' || target === 'cancelled') && !reason.trim()) {
      setError(target === 'waiting' ? '进入等待需要说明等待原因' : '取消事项需要说明取消原因');
      return;
    }
    setSaving(true); setError('');
    const result = await save(task, 'status', {
      status: target,
      ...(target === 'waiting' ? { waitingReason: reason.trim() } : {}),
      ...(target === 'cancelled' ? { cancellationReason: reason.trim() } : {}),
    });
    setSaving(false);
    if (result === 'saved' || result === 'noop') { close(true); return; }
    if (result === 'conflict') { setError('事项版本已变化（可能在别处被修改）；已刷新版本，请重新选择后重试。'); return; }
    setError('更新失败，输入已保留；可重试。');
  }

  const options = nextStatuses[task.status] ?? [];
  return (
    <span className={styles.anchor}>
      <span ref={triggerRef} className={styles.triggerWrap}>
        <Chip
          tone={task.status === 'in_progress' ? 'inProgress' : task.status === 'waiting' ? 'waiting' : task.status === 'done' ? 'done' : task.status === 'cancelled' ? 'cancelled' : 'todo'}
          active={open}
          ariaLabel={`状态：${statusNames[task.status] ?? task.status}，点击修改`}
          onClick={() => onPopoverChange(open ? null : key)}
        >{statusNames[task.status] ?? task.status}</Chip>
      </span>
      {open && (
        <span className={`${styles.panel} ${align === 'left' ? styles.panelLeft : ''}`} role="dialog" aria-label="修改状态">
          <span className={styles.panelTitle}>状态流转</span>
          <span className={styles.panelCurrent}>当前：{statusNames[task.status] ?? task.status}</span>
          <span className={styles.options}>
            {options.map((status) => {
              const label = isEnded(task.status) && status === 'todo' ? '重新打开' : status === 'todo' ? '回到待处理' : statusNames[status] ?? status;
              const chosen = target === status;
              return (
                <button
                  key={status}
                  type="button"
                  className={`${styles.option} ${chosen ? styles.optionChosen : ''}`}
                  disabled={saving}
                  aria-pressed={chosen}
                  onClick={() => { setTarget(status); setError(''); }}
                >{label}</button>
              );
            })}
          </span>
          {(target === 'waiting' || target === 'cancelled') && (
            <label className={styles.reasonField}>
              {target === 'waiting' ? '等待原因（必填）' : '取消原因（必填）'}
              <textarea
                value={reason}
                onChange={(event) => { setReason(event.target.value); setError(''); }}
                placeholder={target === 'waiting' ? '例如：等物业回复维修时间' : '例如：需求已撤销'}
                maxLength={1000}
                disabled={saving}
                aria-label={target === 'waiting' ? '等待原因' : '取消原因'}
              />
            </label>
          )}
          {target === 'done' && <span className={styles.hint}>未勾完的小步骤会先提示确认；完成会按规则清理跟进。</span>}
          {error && <span className={styles.fieldError} role="alert">{error}</span>}
          <span className={styles.panelActions}>
            <button type="button" className={styles.panelCancel} onClick={() => close()} disabled={saving}>取消</button>
            <button
              type="button" className={styles.panelConfirm} onClick={() => void confirm()} disabled={saving || !target}
            >{saving ? '更新中…' : target === 'waiting' ? '确认转为等待中' : target === 'cancelled' ? '确认取消事项' : target ? `标记为${statusNames[target] ?? target}` : '请选择'}</button>
          </span>
        </span>
      )}
    </span>
  );
}

/** 优先级编辑：选择即保存（P-02）。 */
export function PriorityEditor({ task, popoverKey, onPopoverChange, save, align }: CommonProps) {
  const key = `priority:${task.id}`;
  const open = popoverKey === key;
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (open) { setError(''); setSaving(false); } }, [open]);

  function close(focus = false) {
    onPopoverChange(null);
    if (focus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function pick(priority: string) {
    if (saving || priority === task.priority) { close(true); return; }
    setSaving(true); setError('');
    const result = await save(task, 'priority', { priority });
    setSaving(false);
    if (result === 'saved') { close(true); return; }
    if (result === 'conflict') { setError('事项版本已变化；已刷新版本，请重试。'); return; }
    setError('保存失败，请重试。');
  }

  const tone = task.priority === 'high' ? 'overdue' : task.priority === 'medium' ? 'due' : task.priority === 'low' ? 'inProgress' : 'muted';
  return (
    <span className={styles.anchor}>
      <span ref={triggerRef} className={styles.triggerWrap}>
        <Chip
          tone={tone}
          active={open}
          ariaLabel={`优先级：${priorityNames[task.priority] ?? task.priority}，点击修改`}
          onClick={() => onPopoverChange(open ? null : key)}
        >{task.priority === 'none' ? '优先级' : `优先级 ${priorityNames[task.priority] ?? task.priority}`}</Chip>
      </span>
      {open && (
        <span className={`${styles.panel} ${align === 'left' ? styles.panelLeft : ''}`} role="dialog" aria-label="修改优先级">
          <span className={styles.panelTitle}>优先级</span>
          <span className={styles.panelCurrent}>当前：{priorityNames[task.priority] ?? task.priority}；选择后立即保存</span>
          <span className={styles.options}>
            {(['none', 'low', 'medium', 'high'] as const).map((priority) => (
              <button
                key={priority}
                type="button"
                className={`${styles.option} ${task.priority === priority ? styles.optionCurrent : ''}`}
                disabled={saving}
                onClick={() => void pick(priority)}
              >
                {priorityNames[priority]}
                {task.priority === priority ? ' · 当前' : ''}
              </button>
            ))}
          </span>
          {saving && <span className={styles.hint}>保存中…</span>}
          {error && <span className={styles.fieldError} role="alert">{error}</span>}
        </span>
      )}
    </span>
  );
}

/** 日期编辑（计划/截止/跟进）：语义标注、就近调整、选择即保存（C-02、P-08）。 */
export function DatesEditor({ task, popoverKey, onPopoverChange, save, align }: CommonProps) {
  const key = `dates:${task.id}`;
  const open = popoverKey === key;
  const [drafts, setDrafts] = useState<{ plannedDate: string; dueDate: string; followUpDate: string }>({
    plannedDate: task.plannedDate ?? '', dueDate: task.dueDate ?? '', followUpDate: task.followUpDate ?? '',
  });
  const [focusField, setFocusField] = useState<DateField | ''>('');
  const [error, setError] = useState('');
  const [busyField, setBusyField] = useState<DateField | ''>('');
  const prevRef = useRef<{ plannedDate: string | null; dueDate: string | null; followUpDate: string | null }>({
    plannedDate: task.plannedDate, dueDate: task.dueDate, followUpDate: task.followUpDate,
  });
  const plannedInputRef = useRef<HTMLInputElement>(null);
  const dueInputRef = useRef<HTMLInputElement>(null);
  const followUpInputRef = useRef<HTMLInputElement>(null);

  // 服务端确认值推进时，仅同步没有本地待保存草稿的字段（P-06 不覆盖未提交输入）
  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      if (current.plannedDate === (prevRef.current.plannedDate ?? '')) next.plannedDate = task.plannedDate ?? '';
      if (current.dueDate === (prevRef.current.dueDate ?? '')) next.dueDate = task.dueDate ?? '';
      if (current.followUpDate === (prevRef.current.followUpDate ?? '')) next.followUpDate = task.followUpDate ?? '';
      return next;
    });
    prevRef.current = { plannedDate: task.plannedDate, dueDate: task.dueDate, followUpDate: task.followUpDate };
  }, [task.plannedDate, task.dueDate, task.followUpDate]);

  useEffect(() => {
    if (open) {
      setDrafts({ plannedDate: task.plannedDate ?? '', dueDate: task.dueDate ?? '', followUpDate: task.followUpDate ?? '' });
      prevRef.current = { plannedDate: task.plannedDate, dueDate: task.dueDate, followUpDate: task.followUpDate };
      setError(''); setBusyField('');
      const field = focusField;
      requestAnimationFrame(() => {
        if (field === 'plannedDate') plannedInputRef.current?.focus();
        else if (field === 'dueDate') dueInputRef.current?.focus();
        else if (field === 'followUpDate') followUpInputRef.current?.focus();
      });
    }
  }, [open]);

  function openFor(field: DateField | null) {
    setFocusField(field ?? '');
    onPopoverChange(open ? null : key);
  }

  async function saveField(field: DateField, value: string) {
    if (busyField) return;
    const normalized = value || null;
    if ((task[field] ?? null) === normalized) return;
    if (field === 'followUpDate' && normalized && isEnded(task.status)) {
      setError('结束事项不能安排跟进，请先重新打开。');
      return;
    }
    if (field === 'plannedDate' && normalized && (drafts.dueDate || task.dueDate || '') && normalized > (drafts.dueDate || task.dueDate || '')) {
      setError('计划日期不能晚于截止日期。');
      return;
    }
    setBusyField(field); setError('');
    const result = await save(task, field, { [field]: normalized } as AttrPayload);
    setBusyField('');
    if (result === 'conflict') { setError('事项版本已变化；已刷新版本，请重试。'); return; }
    if (result === 'failed') { setError('保存失败，输入已保留；可重试。'); return; }
    // saved / noop：弹层保持打开，便于继续调整其余日期
  }

  const setDraft = (field: DateField) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setDrafts((current) => ({ ...current, [field]: event.target.value }));
  };

  const chipFor = (field: DateField) => {
    const value = task[field];
    const name = dateFieldNames[field];
    if (!value) return null;
    const overdue = field === 'dueDate' && task.risk?.overdue;
    const due = (field === 'followUpDate' && task.risk?.followUpDue) || (field === 'plannedDate' && task.risk?.plannedDue);
    return (
      <Chip
        key={field}
        tone={overdue ? 'overdue' : due ? 'due' : 'muted'}
        active={open}
        ariaLabel={`${name}日期 ${value}，点击调整`}
        onClick={() => openFor(field)}
      >{name} {value.slice(5)}</Chip>
    );
  };

  const hasAnyDate = Boolean(task.plannedDate || task.dueDate || task.followUpDate);
  const followUpHint = drafts.followUpDate && (drafts.dueDate || task.dueDate || '') && drafts.followUpDate > (drafts.dueDate || task.dueDate || '');
  return (
    <span className={styles.anchor}>
      <span className={styles.triggerWrap}>
        {chipFor('plannedDate')}
        {chipFor('dueDate')}
        {chipFor('followUpDate')}
        {!hasAnyDate && (
          <Chip add active={open} ariaLabel="安排日期" onClick={() => openFor(null)}>＋日期</Chip>
        )}
      </span>
      {open && (
        <span className={`${styles.panel} ${align === 'left' ? styles.panelLeft : ''} ${styles.panelWide}`} role="dialog" aria-label="调整日期">
          <span className={styles.panelTitle}>日期安排</span>
          <span className={styles.panelCurrent}>每个日期独立保存，语义互不混用</span>
          {(['plannedDate', 'dueDate', 'followUpDate'] as const).map((field) => (
            <span key={field} className={styles.dateRow}>
              <label className={styles.dateLabel}>
                {field === 'plannedDate' ? '计划日期' : field === 'dueDate' ? '截止日期' : '下次跟进'}
                <input
                  ref={field === 'plannedDate' ? plannedInputRef : field === 'dueDate' ? dueInputRef : followUpInputRef}
                  type="date"
                  value={drafts[field]}
                  onChange={setDraft(field)}
                  onBlur={() => void saveField(field, drafts[field])}
                  disabled={busyField === field || (field === 'followUpDate' && isEnded(task.status))}
                  aria-label={field === 'plannedDate' ? '计划日期' : field === 'dueDate' ? '截止日期' : '下次跟进'}
                />
              </label>
              {(task[field] || drafts[field]) && (
                <button
                  type="button" className={styles.clearButton}
                  disabled={busyField === field}
                  onClick={() => { setDrafts((current) => ({ ...current, [field]: '' })); void saveField(field, ''); }}
                >清除</button>
              )}
              {field === 'followUpDate' && !isEnded(task.status) && <span className={styles.dateQuickActions}><button className={styles.dateQuickAction} type="button" onClick={() => { const next = shanghaiDateAfter(1); setDrafts((current) => ({ ...current, followUpDate: next })); void saveField('followUpDate', next); }} disabled={Boolean(busyField)}>推迟到明天</button><button className={styles.dateQuickAction} type="button" onClick={() => { const next = shanghaiDateAfter(shanghaiDaysUntilMonday()); setDrafts((current) => ({ ...current, followUpDate: next })); void saveField('followUpDate', next); }} disabled={Boolean(busyField)}>下周一</button></span>}
              {busyField === field && <span className={styles.hint}>保存中…</span>}
            </span>
          ))}
          {error && <span className={styles.fieldError} role="alert">{error}</span>}
          {followUpHint && <span className={styles.hintWarn}>跟进日期晚于截止日期，可能无法及时处理。</span>}
          <span className={styles.panelActions}>
            <button type="button" className={styles.panelConfirm} onClick={() => onPopoverChange(null)}>完成</button>
          </span>
        </span>
      )}
    </span>
  );
}

/** 处理方式编辑：交给谁为本人文本记录，不自动改状态与日期（PRD 1.2、M3-04）。 */
export function HandlingEditor({ task, popoverKey, onPopoverChange, save, align }: CommonProps) {
  const key = `handling:${task.id}`;
  const open = popoverKey === key;
  const [mode, setMode] = useState(task.handlingMode);
  const [name, setName] = useState(task.counterpartName);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) { setMode(task.handlingMode); setName(task.counterpartName); setError(''); setSaving(false); }
  }, [open, task.handlingMode, task.counterpartName]);

  function close(focus = false) {
    onPopoverChange(null);
    if (focus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function confirm() {
    if (saving) return;
    if (mode === 'other' && !name.trim()) { setError('交给别人时必须填写交给谁（本人记录，不代表对方已收到）'); return; }
    setSaving(true); setError('');
    const result = await save(task, 'handling', { handlingMode: mode, ...(mode === 'other' ? { counterpartName: name.trim() } : {}) });
    setSaving(false);
    if (result === 'saved') { close(true); return; }
    if (result === 'conflict') { setError('事项版本已变化；已刷新版本，请重试。'); return; }
    setError('保存失败，输入已保留；可重试。');
  }

  const ended = isEnded(task.status);
  return (
    <span className={styles.anchor}>
      <span ref={triggerRef} className={styles.triggerWrap}>
        <Chip
          tone={task.handlingMode === 'other' ? 'accent' : 'muted'}
          active={open}
          disabled={ended}
          ariaLabel={ended ? '结束事项不能改处理方式' : task.handlingMode === 'other' ? `交给 ${task.counterpartName}，点击修改` : '自己处理，点击改为交给别人'}
          onClick={() => onPopoverChange(open ? null : key)}
        >{task.handlingMode === 'other' ? `⇢ ${task.counterpartName}` : '自己'}</Chip>
      </span>
      {open && (
        <span className={`${styles.panel} ${align === 'left' ? styles.panelLeft : ''}`} role="dialog" aria-label="修改处理安排">
          <span className={styles.panelTitle}>处理安排</span>
          {ended ? (
            <span className={styles.hint}>结束事项不能改处理方式，请先重新打开。</span>
          ) : (
            <>
              <label className={styles.inlineSelect}>
                处理方式
                <select value={mode} onChange={(event) => { setMode(event.target.value); setError(''); }} disabled={saving}>
                  <option value="self">自己处理</option>
                  <option value="other">交给别人</option>
                </select>
              </label>
              {mode === 'other' && (
                <label className={styles.reasonField}>
                  交给谁（本人记录，对方不会收到通知）
                  <input
                    value={name}
                    onChange={(event) => { setName(event.target.value); setError(''); }}
                    placeholder="例如：张三（工程）"
                    maxLength={100}
                    disabled={saving}
                    aria-label="交给谁"
                  />
                </label>
              )}
              <span className={styles.hint}>不会自动改变状态与日期。</span>
              {error && <span className={styles.fieldError} role="alert">{error}</span>}
              <span className={styles.panelActions}>
                <button type="button" className={styles.panelCancel} onClick={() => close()} disabled={saving}>取消</button>
                <button type="button" className={styles.panelConfirm} onClick={() => void confirm()} disabled={saving}>{saving ? '保存中…' : '保存处理安排'}</button>
              </span>
            </>
          )}
        </span>
      )}
    </span>
  );
}
