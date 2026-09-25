import { useState } from 'react';
import { apiPost } from '../api/client';
import type { PresenceMember } from './collab';
import './member-panel.css';

/**
 * 在线成员面板 — M2 Task 6（FR-COL-005）。
 *
 * 数据面 = awareness states 本地计算（collab.onPresence），无轮询：
 * - 「正在编辑 / 正在查看」两组按 editing flag 分组（editing = 最近 60s 内有本地
 *   用户写，裁定口径见 collab.ts 文件头）；
 * - 每行：首字符色块头像（底色 = colorForUser 的用户色）/ 昵称 / 进入时间（HH:MM）；
 * - 创建者标识：member.userId === ownerUserId（ownerUserId 来自
 *   GET /api/files/:id 扩展字段，EditorPage 透传）。
 * rows 附 data-member-user 供测试/样式钩用；面板关闭时整棵不渲染。
 *
 * 邀请区（M4 Task 2，FR-SHR-004 UI 面，M3b 缺口收口）：canInvite（EditorPage 以
 * 当前用户 id === ownerUserId 判定，WorkspacePage 行菜单同口径）时面板底部附
 * 批量邀请区——粘贴邮箱/手机号整批 POST /files/:id/invites，成功/失败经 showToast
 * 走 EditorPage 既有 toast（testid toast）。受邀联系人在接受前不是用户，成员面板
 * 数据面（在线 presence）无从刷新，故无 onInvited 回调（裁定见任务报告）。
 */

export interface MemberPanelProps {
  members: PresenceMember[];
  ownerUserId: string | null;
  open: boolean;
  onClose(): void;
  /** 邀请区依赖：文件 id（POST /files/:id/invites）与 owner 专属可见开关。 */
  fileId: string;
  canInvite?: boolean;
  /** toast 通道：复用 EditorPage 既有 toast（testid toast，role alert）。 */
  showToast(message: string): void;
}

/** 联系人拆分（brief 口径）：逗号/分号/顿号/任意空白（含换行）皆作分隔。 */
const CONTACT_SPLIT_RE = /[,\s;；、]+/;

/** 单次邀请上限（与 server invite-request.schema 的 50 同口径，客户端先拦免往返）。 */
const INVITE_MAX = 50;

/** 批量邀请区（M4 Task 2）：仅 canInvite 时渲染。错误 toast 直接透出服务端
 *  message——400 时服务端已把非法条目逐条拼接（「联系人格式非法：a、b」），原样
 *  展示即「逐条列出」，前端不再二次解析（M3b 实际契约无 invalid 数组）。 */
function InviteSection({ fileId, showToast }: { fileId: string; showToast(message: string): void }) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = (): void => {
    const contacts = draft.split(CONTACT_SPLIT_RE).filter((c) => c !== '');
    if (contacts.length === 0) {
      showToast('请先粘贴要邀请的邮箱或手机号');
      return;
    }
    if (contacts.length > INVITE_MAX) {
      showToast(`单次最多邀请 ${INVITE_MAX} 个联系人`);
      return;
    }
    setSubmitting(true);
    void apiPost<{ invited: number; skipped: number }>(`/files/${fileId}/invites`, { contacts })
      .then((res) => {
        // skipped = 重邀 no-op（pending/accepted 计数）：对邀请人而言该批联系人均已覆盖
        showToast(`已邀请 ${res.invited + res.skipped} 位`);
        setDraft('');
      })
      .catch((e: unknown) => {
        showToast(e instanceof Error ? e.message : '邀请失败');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <section className="member-invite" data-testid="invite-section">
      <h3 className="member-group-title">邀请协作</h3>
      <p className="member-invite-hint">粘贴邮箱或手机号，逗号/空格/换行分隔，上限 50</p>
      <textarea
        className="member-invite-input"
        data-testid="invite-input"
        value={draft}
        placeholder="如 a@example.com, 13900000001"
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="button" className="member-invite-submit" data-testid="invite-submit" disabled={submitting} onClick={submit}>
        发送邀请
      </button>
    </section>
  );
}

function formatJoinedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--:--';
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function MemberRow({ member, isOwner }: { member: PresenceMember; isOwner: boolean }) {
  return (
    <li className="member-row" data-testid="member-row" data-member-user={member.userId}>
      <span className="member-avatar" style={{ background: member.color }} aria-hidden>
        {member.nickname.charAt(0) || '？'}
      </span>
      <span className="member-name">{member.nickname}</span>
      {isOwner && (
        <span className="member-owner-badge" data-testid="owner-badge">
          创建者
        </span>
      )}
      <span className="member-joined">{formatJoinedAt(member.joinedAt)}</span>
    </li>
  );
}

function MemberGroup({
  testId,
  title,
  members,
  ownerUserId,
}: {
  testId: string;
  title: string;
  members: PresenceMember[];
  ownerUserId: string | null;
}) {
  return (
    <section className="member-group" data-testid={testId}>
      <h3 className="member-group-title">
        {title}
        <span className="member-group-count">{members.length}</span>
      </h3>
      {members.length === 0 ? (
        <p className="member-group-empty">暂无</p>
      ) : (
        <ul className="member-rows">
          {members.map((m) => (
            // 键用 awareness clientID：同账号多标签页 userId 相同，键须按连接唯一
            <MemberRow key={m.clientID} member={m} isOwner={m.userId === ownerUserId} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function MemberPanel({ members, ownerUserId, open, onClose, fileId, canInvite, showToast }: MemberPanelProps) {
  if (!open) return null;
  const editing = members.filter((m) => m.editing);
  const viewing = members.filter((m) => !m.editing);
  return (
    <aside className="member-panel" data-testid="member-panel">
      <header className="member-panel-header">
        <span className="member-panel-title">在线成员</span>
        <button
          type="button"
          className="member-panel-close"
          data-testid="member-panel-close"
          aria-label="关闭成员面板"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <MemberGroup testId="member-group-editing" title="正在编辑" members={editing} ownerUserId={ownerUserId} />
      <MemberGroup testId="member-group-viewing" title="正在查看" members={viewing} ownerUserId={ownerUserId} />
      {canInvite && <InviteSection fileId={fileId} showToast={showToast} />}
    </aside>
  );
}
