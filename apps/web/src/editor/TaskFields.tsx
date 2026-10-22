import { useEffect, useMemo, useRef, useState, type ReactElement, type CSSProperties } from 'react';
import type * as Y from 'yjs';
import {
  assigneeEntriesOf,
  CUSTOM_TEXT_MAX_LENGTH,
  getNode,
  rootIdOf,
  subtreeIds,
  type CustomColumnDef,
  type NodeSnapshot,
} from '@gmind/core';
import type { DeriveNode, TaskStatus } from '@gmind/shared';
import { colorForUser } from '@gmind/engine';
import { api } from '../api/client';
import type { PresenceMember } from './collab';
import './task-table.css';

/**
 * 任务字段公共控件（M7c-C3/C4 抽公共）：TaskTable 与快速设置弹层/右侧任务面板
 * 三处共用的最小件——状态元数据、成员头像、智能日期输入、成员多选、文档派生
 * 节点构建与成员候选装配；自定义属性单字段输入（CustomFieldInput，表格自定义
 * 列消费侧）供快速卡/任务面板两处共用。
 *
 * 抽公共裁决（速度优先）：
 * - STATUS_META / Avatar / SmartDateInput 自 TaskTable 原样迁出（类名/testid
 *   行为不变，TaskTable 改为从这里 import——表格视图形态零改动）；
 * - 成员候选口径沿用 TaskTable 既有裁定：GET /files/:id/collaborators（owner+
 *   协作者）∪ presence 在线成员 ∪ 文档内已出现的负责人 ID（昵称回退=id 前 8 位），
 *   存用户 ID。TaskTable 保留自身装配（its useTaskMembers 等价实现已在本模块，
 *   表格侧暂不切换避免回归面扩大，属已知妥协——两条同源 GET 幂等无害）；
 * - deriveNodesOfDoc：doc 快照 → shared DeriveNode 平铺数组（TaskTable.nodes
 *   的去表格列版），effectiveProgress/isOverdue/childrenOf 业务口径仍以
 *   @gmind/shared 为唯一实现（禁止内联第二份）。
 */

/** 企微浅色系状态元数据（todo 灰 / doing 蓝 / done 绿 / blocked 橙；同 TaskTable）。 */
export const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  todo: { label: '待开始', color: '#86909c', bg: '#f2f3f5' },
  doing: { label: '进行中', color: '#3370ff', bg: '#e8f3ff' },
  done: { label: '已完成', color: '#34c724', bg: '#e8f7e8' },
  blocked: { label: '阻塞', color: '#ff8800', bg: '#fff3e8' },
};

export const STATUS_KEYS = Object.keys(STATUS_META) as TaskStatus[];

export interface MemberOption {
  userId: string;
  nickname: string;
  /** 头像地址（2026-10-11）：预置 `/avatars/preset-N.svg` 或上传键 `users/{id}/...`；
   *  null/缺省 = 未自定义——Avatar 组件按 userId 稳定哈希自动分配 5 个预置之一。 */
  avatar?: string | null;
}

/** 预置 SVG 头像库（5 个；public/avatars/preset-1..5.svg 直出）。 */
export const PRESET_AVATAR_COUNT = 5;

/** 未自定义头像时的稳定预置分配：userId 字符码和 %5（与成员色 colorForUser 同思路——
 *  同一用户恒得同一预置，无需落库迁移存量用户）。 */
export function presetAvatarOf(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash + userId.charCodeAt(i)) % 997;
  return `/avatars/preset-${(hash % PRESET_AVATAR_COUNT) + 1}.svg`;
}

/** 头像地址 → <img> src：上传键经公开读取端点直出；预置路径原样（vite public）。 */
export function avatarSrcOf(avatar: string | null | undefined, userId: string): string {
  if (!avatar) return presetAvatarOf(userId);
  return avatar.startsWith('users/') ? `/api/images/${avatar}` : avatar;
}

/** 选中态 chip 样式（企微浅底 + 主题色描边；同 TaskTable）。 */
export function chipActive(color: string): CSSProperties {
  return { color, borderColor: color, background: `${color}14` };
}

/** 成员头像（2026-10-11 头像功能）：有 avatar（或稳定预置分配）渲染圆形 <img>，
 *  加载失败/无昵称回退首字符文字圆；底色 = 成员色 15% 透明（colorForUser 同源）。 */
export function Avatar({
  userId,
  nickname,
  avatar,
  size = 18,
}: {
  userId: string;
  nickname: string;
  avatar?: string | null;
  size?: number;
}) {
  const color = colorForUser(userId);
  const [imgFailed, setImgFailed] = useState(false);
  const src = avatarSrcOf(avatar, userId);
  if (!imgFailed) {
    return (
      <img
        className="tt-avatar tt-avatar-img"
        style={{ width: size, height: size }}
        src={src}
        alt={nickname}
        title={nickname}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return (
    <span
      className="tt-avatar"
      style={{
        width: size,
        height: size,
        background: `${color}22`,
        color,
        fontSize: Math.round(size * 0.55),
      }}
      title={nickname}
    >
      {nickname.charAt(0) || '？'}
    </span>
  );
}

/**
 * 成员候选装配（collaborators ∪ presence ∪ 文档内既有负责人 ID）：C3/C4 共用。
 * docOwnerIds 以 join 串进 memo 依赖（调用方每次渲染新建数组，不致重算风暴）。
 */
export function useTaskMembers(
  fileId: string,
  presence: PresenceMember[],
  docOwnerIds: readonly string[],
): Map<string, MemberOption> {
  const [collaborators, setCollaborators] = useState<MemberOption[]>([]);
  useEffect(() => {
    let alive = true;
    api<Array<{ userId: string; nickname: string; avatar?: string | null }>>(`/files/${fileId}/collaborators`)
      .then((list) => {
        if (alive) setCollaborators(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [fileId]);
  const ownerKey = docOwnerIds.join('|');
  return useMemo(() => {
    const map = new Map<string, MemberOption>();
    for (const c of collaborators) map.set(c.userId, c);
    for (const p of presence) {
      if (!map.has(p.userId)) map.set(p.userId, { userId: p.userId, nickname: p.nickname });
    }
    for (const o of ownerKey.split('|')) {
      if (o !== '' && !map.has(o)) map.set(o, { userId: o, nickname: o.slice(0, 8) });
    }
    return map;
  }, [collaborators, presence, ownerKey]);
}

/**
 * 成员多选 chips（C3/C4 同一份交互语义：点击切换选中，选中高亮成员色）。
 * testid 前缀由调用方给（`task-panel-owner` 等，拼 `-{userId}`）。
 */
export function MemberMultiSelect({
  memberIndex,
  selected,
  onToggle,
  testIdPrefix,
  emptyHint = '暂无文档成员，邀请协作者后可指派',
}: {
  memberIndex: Map<string, MemberOption>;
  selected: string[];
  onToggle: (userId: string) => void;
  testIdPrefix: string;
  emptyHint?: string;
}): ReactElement {
  if (memberIndex.size === 0) {
    return <span className="tt-pop-empty">{emptyHint}</span>;
  }
  return (
    <span className="task-member-list">
      {[...memberIndex.values()].map((m) => {
        const on = selected.includes(m.userId);
        const color = colorForUser(m.userId);
        return (
          <button
            key={m.userId}
            type="button"
            className="tt-chip"
            data-testid={`${testIdPrefix}-${m.userId}`}
            title={m.nickname}
            aria-pressed={on}
            style={on ? chipActive(color) : undefined}
            onClick={() => onToggle(m.userId)}
          >
            <Avatar userId={m.userId} nickname={m.nickname} avatar={m.avatar} size={14} />
            {m.nickname}
          </button>
        );
      })}
    </span>
  );
}

/**
 * doc 快照 → shared DeriveNode 平铺数组（root 不入列；order = 父 childIds 下标）。
 * C3/C4 的进度 Σ / 逾期 / 子级判定全走 @gmind/shared 派生规则（口径唯一实现）。
 * 多画布（计划三 Task 4 评审修复）：canvasId 限定当前画布子树——异根画布的任务
 * 面板/人员进度不再拉平第一画布数据；缺省走 core 缺省解析（meta.activeCanvasId）。
 */
export function deriveNodesOfDoc(doc: Y.Doc, canvasId?: string): DeriveNode[] {
  const snaps = new Map<string, NodeSnapshot>();
  const rootId = rootIdOf(doc, canvasId);
  for (const id of subtreeIds(doc, rootId, canvasId)) {
    const snap = getNode(doc, id, canvasId);
    if (!snap || snap.deleted) continue;
    snaps.set(id, snap);
  }
  const root = snaps.get(rootId);
  const out: DeriveNode[] = [];
  for (const [id, snap] of snaps) {
    if (id === rootId) continue;
    const parent = snap.parentId === '' ? root : snaps.get(snap.parentId);
    // 人员进度列条目拉平（assigneeEntriesOf 纯读；无条目不出该键——快照零新增键面）
    const assignees = assigneeEntriesOf(doc, id, canvasId);
    out.push({
      id,
      parentId: snap.parentId === '' ? null : snap.parentId,
      title: snap.text,
      collapsed: snap.collapsed,
      order: parent ? Math.max(0, parent.childIds.indexOf(id)) : 0,
      task: { ...snap.task, owners: [...snap.task.owners] },
      ...(assignees.length > 0
        ? {
            customAssignees: assignees.map(({ user, progress, weight }) => ({
              user,
              progress,
              weight,
            })),
          }
        : {}),
    });
  }
  return out;
}

/**
 * 进度字段（C3/C4 同款）：自动汇总父级 = Σ 有效进度只读；
 * 手动父级/叶子 = 数字输入（Enter/失焦提交，钳 0-100 取整）。
 */
export function ProgressField({
  auto,
  effective,
  progress,
  onCommit,
  testId,
}: {
  auto: boolean;
  effective: number;
  progress: number;
  onCommit: (v: number) => void;
  testId?: string;
}): ReactElement {
  if (auto) {
    return (
      <span className="task-progress-sigma" title="由子任务自动汇总">
        Σ {effective}%
      </span>
    );
  }
  return (
    <input
      type="number"
      min={0}
      max={100}
      defaultValue={progress}
      key={progress}
      data-testid={testId}
      className="task-progress-input"
      aria-label="任务进度"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={(e) => {
        const n = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
        if (n !== progress) onCommit(n);
      }}
    />
  );
}

/**
 * 智能日期输入（自 TaskTable 迁出，行为/类名不变）：聚焦空值预填当月 1 日
 * （本地临时态），真正选日/改值才提交；未选日离开自动清除预填、零写入。
 * 新增可选 testId（task-panel-date-* 等挂点；C3 快速卡已随 2026-10-10 删除）。
 */
export function SmartDateInput({
  value,
  onCommit,
  overdue,
  today,
  done,
  testId,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  /** 预期日期列：逾期红字 / 当天橙字。 */
  overdue?: boolean;
  today?: boolean;
  /** 完成日期列：已填绿字。 */
  done?: boolean;
  testId?: string;
}) {
  const [local, setLocal] = useState(value ?? '');
  const provisional = useRef<string | null>(null);
  // 外部值同步守卫只豁免**自身**（Kimi P2 回归修复）：旧实现按
  // [data-smart-date] 全局判焦——面板里提交日期后焦点滞留在任一日期框，会让同页
  // 所有 SmartDateInput 的同步被跳过，且此后 value 不再变化、effect 永不再触发
  // （当帧起永久陈旧）。改为与 inputRef 比对：仅本输入框聚焦（正在编辑本格）才
  // 跳过，他处焦点（含另一实例）照常同步。
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // 外部值变化同步（远端协同/撤销）：焦点不在本输入框时落值，编辑中不打断
    if (document.activeElement !== inputRef.current) {
      setLocal(value ?? '');
    }
  }, [value]);
  const color = overdue ? '#f53f3f' : today ? '#ff8800' : done ? '#34c724' : undefined;
  return (
    <input
      ref={inputRef}
      type="date"
      data-smart-date="1"
      data-testid={testId}
      className="tt-date"
      style={color ? { color } : undefined}
      aria-label="任务日期"
      value={local}
      onFocus={() => {
        if (!local) {
          const d = new Date();
          const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
          provisional.current = p;
          setLocal(p);
        }
      }}
      onChange={(e) => {
        const v = e.target.value;
        if (provisional.current) {
          if (v === provisional.current) {
            setLocal(v);
            return; // 仍是预填值，不提交
          }
          provisional.current = null; // 用户真正选了日期
        }
        setLocal(v);
        onCommit(v || null);
      }}
      onBlur={() => {
        if (provisional.current) {
          // 没选日就离开 → 去掉预填的年月（预填是本地临时态，零写入）
          provisional.current = null;
          setLocal('');
        }
      }}
    />
  );
}

// ───────────────────── 自定义属性字段（表格自定义列消费侧，任务 2）─────────────────────

/**
 * 人员列编辑器（assignee 类型，2026-10-12 起为唯一人员列——原 person 纯名单类型
 * 已按需求方裁定去除）：每人一行 [头像+昵称] [0-100 进度输入 %] [比重输入（仅自定义
 * 比重模式）] [×移除]，底部成员多选添加（新人默认进度 0——「选了人就必须有进度」）。
 * 比重（2026-10-12 裁定）：列级「按人数平分 / 自定义比重」开关（写列定义 weighted）；
 * 平分模式存量的 weight 不参与合成（core 读侧解析）。整值替换提交（core 整值 LWW
 * 口径）：任何行变化构造 v2 Record 提交；移除到 0 人提交 null（删键）。
 * 值结构 v2 = Record<user, {progress, weight?}>；旧版 number 简形读侧兼容。
 * 表格单元格弹层与任务面板（CustomFieldInput assignee 分支）共用本组件。
 */
export interface AssigneeRow {
  user: string;
  progress: number;
  weight?: number;
}

/** 解析 assignee 值（v2 对象 / 旧 number 简形兼容）为行数组；坏形状项跳过。 */
export function assigneeRowsOf(value: unknown): AssigneeRow[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const out: AssigneeRow[] = [];
  for (const [user, raw] of Object.entries(value as Record<string, unknown>)) {
    const norm = typeof raw === 'number' ? { progress: raw } : (raw as { progress?: unknown; weight?: unknown } | null);
    if (typeof norm?.progress !== 'number') continue;
    const weight = typeof norm.weight === 'number' && norm.weight > 0 ? norm.weight : undefined;
    out.push(weight === undefined ? { user, progress: norm.progress } : { user, progress: norm.progress, weight });
  }
  return out;
}

export function AssigneeField({
  value,
  memberIndex,
  onCommit,
  testId,
  def,
  onToggleWeighted,
}: {
  value: unknown;
  memberIndex: Map<string, MemberOption>;
  onCommit: (v: Record<string, { progress: number; weight?: number }> | null) => void;
  testId: string;
  /** 列定义（含 weighted 比重开关）；缺省 = 不显示开关（任务面板等只读模式场景）。 */
  def?: CustomColumnDef;
  /** 比重模式切换回调（写列 schema weighted）；缺省不渲染开关。 */
  onToggleWeighted?: (weighted: boolean) => void;
}): ReactElement {
  const rows = assigneeRowsOf(value);
  const weighted = def?.weighted === true;
  const asRecord = (): Record<string, { progress: number; weight?: number }> =>
    Object.fromEntries(rows.map((r) => [r.user, r.weight === undefined ? { progress: r.progress } : { progress: r.progress, weight: r.weight }]));
  const commit = (next: Record<string, { progress: number; weight?: number }>): void => {
    onCommit(Object.keys(next).length > 0 ? next : null);
  };
  return (
    <span className="task-assignee" data-testid={testId}>
      {onToggleWeighted && (
        <label className="task-assignee-weighted-toggle" data-testid={`${testId}-weighted-toggle`}>
          <input
            type="checkbox"
            checked={weighted}
            onChange={(e) => onToggleWeighted(e.target.checked)}
          />
          自定义比重
        </label>
      )}
      {rows.length === 0 && <span className="task-custom-placeholder">选择成员并更新进度</span>}
      {rows.map((row) => (
        <span key={row.user} className="task-assignee-row" data-testid={`${testId}-row-${row.user}`}>
          <Avatar userId={row.user} nickname={memberIndex.get(row.user)?.nickname ?? row.user.slice(0, 8)} avatar={memberIndex.get(row.user)?.avatar} />
          <span className="task-assignee-name">
            {memberIndex.get(row.user)?.nickname ?? row.user.slice(0, 8)}
          </span>
          <AssigneeProgressInput
            testId={`${testId}-progress-${row.user}`}
            progress={row.progress}
            onCommit={(p) => {
              const next = asRecord();
              const cur = next[row.user]!;
              next[row.user] = cur.weight === undefined ? { progress: p } : { progress: p, weight: cur.weight };
              commit(next);
            }}
          />
          {weighted && (
            <AssigneeWeightSelect
              testId={`${testId}-weight-${row.user}`}
              weight={row.weight ?? 1}
              onCommit={(w) => {
                const next = asRecord();
                next[row.user] = { progress: next[row.user]!.progress, weight: w };
                commit(next);
              }}
            />
          )}
          <button
            type="button"
            className="task-assignee-remove"
            data-testid={`${testId}-remove-${row.user}`}
            title="移除该成员"
            onClick={() => {
              const next = asRecord();
              delete next[row.user];
              commit(next);
            }}
          >
            ×
          </button>
        </span>
      ))}
      <MemberMultiSelect
        memberIndex={memberIndex}
        selected={rows.map((r) => r.user)}
        onToggle={(userId) => {
          const next = asRecord();
          if (userId in next) delete next[userId];
          else next[userId] = { progress: 0 }; // 新人默认进度 0
          commit(next);
        }}
        testIdPrefix={`${testId}-member`}
        emptyHint="暂无文档成员，邀请协作者后可指派"
      />
    </span>
  );
}

/** 自定义比重模式行内的比重下拉（需求方 2026-10-12 裁定：0.3~0.8 弱化档 + 1 平权，
 *  下拉选择替代数字输入——避免填入过大数不好评估；只需将需弱化权重的人员调低）。
 *  weight 缺省（未显式选择）= 1 平权；选中即提交、Esc 还原。 */
const ASSIGNEE_WEIGHT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1（平权）' },
  { value: 0.8, label: '0.8' },
  { value: 0.7, label: '0.7' },
  { value: 0.6, label: '0.6' },
  { value: 0.5, label: '0.5' },
  { value: 0.4, label: '0.4' },
  { value: 0.3, label: '0.3' },
];

function AssigneeWeightSelect({
  weight,
  onCommit,
  testId,
}: {
  weight: number;
  onCommit: (v: number) => void;
  testId: string;
}): ReactElement {
  // 下拉只有固定档位：当前 weight 无精确匹配档（如旧数据 3）时显示数值占位，选中档位即归一。
  const known = ASSIGNEE_WEIGHT_OPTIONS.some((o) => o.value === weight);
  return (
    <span className="task-assignee-weight" title="比重（合成总进度的权重，1 为平权，可弱化至 0.3）">
      <select
        data-testid={testId}
        value={known ? weight : ''}
        aria-label="比重"
        onChange={(e) => onCommit(Number(e.target.value))}
      >
        {!known && <option value={weight}>{weight}</option>}
        {ASSIGNEE_WEIGHT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** 人员进度行内的 0-100 数字输入（失焦/Enter 提交、Esc 还原、钳制取整；
 *  外部值同步守卫同 SmartDateInput——自身聚焦中不被远端值打断）。 */
function AssigneeProgressInput({
  progress,
  onCommit,
  testId,
}: {
  progress: number;
  onCommit: (v: number) => void;
  testId: string;
}): ReactElement {
  const [local, setLocal] = useState(String(progress));
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setLocal(String(progress));
  }, [progress]);
  const commit = (): void => {
    const n = Number(local);
    const clamped = local.trim() !== '' && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : progress;
    if (clamped !== progress) onCommit(clamped);
    setLocal(String(clamped));
  };
  return (
    <span className="task-assignee-progress">
      <input
        ref={inputRef}
        data-testid={testId}
        value={local}
        inputMode="numeric"
        aria-label="进度（0-100）"
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setLocal(String(progress)); // 还原
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      %
    </span>
  );
}

/**
 * 自定义属性单字段输入（TaskPanel「自定义属性」小节；原与已删除的 TaskQuickCard
 * 共用，2026-10-10 起 TaskPanel 独用）：按列
 * 类型渲染同族编辑器——text=单行输入（placeholder「填写…」，空提交=清空删键）/
 * progress=0-100 数字输入（Enter/失焦提交，钳 0-100 取整，空=清空）/
 * date=SmartDateInput / assignee=AssigneeField（人员列；person 纯名单类型已随
 * 2026-10-12 裁定去除）。即改即存：onCommit 由调用方接 core setCustomField +
 * afterUserWrite，GmindCoreError 两段式文案在调用方 toast（TaskPanel write 模式）。
 *
 * 值口径：value 读自 getNode(doc,id).custom?.[colId]（防御归一后的 plain 值），
 * 非本列类型形状（crafted 遗留）按空值处理；未变更零提交（onCommit 内不重复写）。
 */
export function CustomFieldInput({
  def,
  value,
  memberIndex,
  onCommit,
  testIdPrefix,
}: {
  def: CustomColumnDef;
  value: unknown;
  memberIndex: Map<string, MemberOption>;
  onCommit: (
    v: string | number | Record<string, { progress: number; weight?: number }> | null,
  ) => void;
  testIdPrefix: string;
}): ReactElement {
  const testId = `${testIdPrefix}-${def.id}`;
  switch (def.type) {
    case 'text':
      return (
        <CustomTextField def={def} value={value} onCommit={onCommit} testId={testId} />
      );
    case 'assignee':
      return (
        <AssigneeField value={value} memberIndex={memberIndex} onCommit={onCommit} testId={testId} def={def} />
      );
    case 'progress':
      return (
        <CustomProgressField def={def} value={value} onCommit={onCommit} testId={testId} />
      );
    case 'date':
      return (
        <SmartDateInput
          testId={testId}
          value={typeof value === 'string' ? value : null}
          onCommit={(v) => {
            if (v !== (typeof value === 'string' ? value : null)) onCommit(v); // 未变更零写入
          }}
        />
      );
  }
}

/** text 列：单行受控输入（外部值同步守卫同 SmartDateInput——自身聚焦中不被远端
 *  值打断）；Enter/失焦提交，trim 后空串=清空（null），未变更零提交。 */
function CustomTextField({
  def,
  value,
  onCommit,
  testId,
}: {
  def: CustomColumnDef;
  value: unknown;
  onCommit: (v: string | string | null) => void;
  testId: string;
}): ReactElement {
  const current = typeof value === 'string' ? value : '';
  const [local, setLocal] = useState(current);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // 外部值变化同步（远端协同/撤销）：焦点不在本输入框时落值，编辑中不打断
    if (document.activeElement !== inputRef.current) setLocal(current);
  }, [current]);
  const commit = (): void => {
    const next = local.trim();
    if (next === current) return; // 未变更零写入
    onCommit(next === '' ? null : next);
  };
  return (
    <input
      ref={inputRef}
      className="task-custom-input"
      data-testid={testId}
      value={local}
      maxLength={CUSTOM_TEXT_MAX_LENGTH}
      placeholder="填写…"
      aria-label={`自定义属性 ${def.name}`}
      onChange={(e) => setLocal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={commit}
    />
  );
}

/** progress 列：0-100 数字输入（ProgressField 同款失焦提交 + key 重挂同步外部值；
 *  无父级 Σ 语义——custom 值不参与任务派生，独立字段）。空串=清空（null）。 */
function CustomProgressField({
  def,
  value,
  onCommit,
  testId,
}: {
  def: CustomColumnDef;
  value: unknown;
  onCommit: (v: number | null) => void;
  testId: string;
}): ReactElement {
  const num = typeof value === 'number' ? value : null;
  return (
    <input
      type="number"
      min={0}
      max={100}
      defaultValue={num ?? undefined}
      key={num === null ? 'empty' : num}
      data-testid={testId}
      className="task-progress-input task-custom-progress"
      aria-label={`自定义属性 ${def.name}`}
      placeholder="0-100"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        if (raw === '') {
          if (num !== null) onCommit(null); // 清空 = 删键；本就空零写入
          return;
        }
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n)) return; // 非法输入不提交（key 重挂兜底回显）
        const clamped = Math.max(0, Math.min(100, n));
        if (clamped !== num) onCommit(clamped);
      }}
    />
  );
}
