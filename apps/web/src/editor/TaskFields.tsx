import { useEffect, useMemo, useRef, useState, type ReactElement, type CSSProperties } from 'react';
import type * as Y from 'yjs';
import { getNode, ROOT_NODE_ID, subtreeIds, type NodeSnapshot } from '@gmind/core';
import type { DeriveNode, TaskStatus } from '@gmind/shared';
import { colorForUser } from '@gmind/engine';
import { api } from '../api/client';
import type { PresenceMember } from './collab';
import './task-table.css';

/**
 * 任务字段公共控件（M7c-C3/C4 抽公共）：TaskTable 与快速设置弹层/右侧任务面板
 * 三处共用的最小件——状态元数据、成员头像、智能日期输入、成员多选、文档派生
 * 节点构建与成员候选装配。
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
}

/** 选中态 chip 样式（企微浅底 + 主题色描边；同 TaskTable）。 */
export function chipActive(color: string): CSSProperties {
  return { color, borderColor: color, background: `${color}14` };
}

/** 成员头像：底色 = 成员色 15% 透明，字色 = 成员色（colorForUser 与 awareness 同源）。 */
export function Avatar({
  userId,
  nickname,
  size = 18,
}: {
  userId: string;
  nickname: string;
  size?: number;
}) {
  const color = colorForUser(userId);
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
    api<Array<{ userId: string; nickname: string }>>(`/files/${fileId}/collaborators`)
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
 * testid 前缀由调用方给（`quickcard-owner` / `task-panel-owner`，拼 `-{userId}`）。
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
            <Avatar userId={m.userId} nickname={m.nickname} size={14} />
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
 */
export function deriveNodesOfDoc(doc: Y.Doc): DeriveNode[] {
  const snaps = new Map<string, NodeSnapshot>();
  for (const id of subtreeIds(doc, ROOT_NODE_ID)) {
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) continue;
    snaps.set(id, snap);
  }
  const root = snaps.get(ROOT_NODE_ID);
  const out: DeriveNode[] = [];
  for (const [id, snap] of snaps) {
    if (id === ROOT_NODE_ID) continue;
    const parent = snap.parentId === '' ? root : snaps.get(snap.parentId);
    out.push({
      id,
      parentId: snap.parentId === '' ? null : snap.parentId,
      title: snap.text,
      collapsed: snap.collapsed,
      order: parent ? Math.max(0, parent.childIds.indexOf(id)) : 0,
      task: { ...snap.task, owners: [...snap.task.owners] },
    });
  }
  return out;
}

/**
 * 进度字段（C3/C4 同款）：叶子 = 数字输入（Enter/失焦提交，钳 0-100 取整），
 * 父级 = Σ 有效进度只读（@gmind/shared effectiveProgress 口径）。
 */
export function ProgressField({
  hasChildren,
  effective,
  progress,
  onCommit,
  testId,
}: {
  hasChildren: boolean;
  effective: number;
  progress: number;
  onCommit: (v: number) => void;
  testId?: string;
}): ReactElement {
  if (hasChildren) {
    return (
      <span className="task-progress-sigma" title="由子任务自动汇总">
        Σ {effective}%（自动）
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
 * 新增可选 testId（C3/C4 的 quickcard-date-* / task-panel-date-* 挂点）。
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
