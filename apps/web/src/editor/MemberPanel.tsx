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
 */

export interface MemberPanelProps {
  members: PresenceMember[];
  ownerUserId: string | null;
  open: boolean;
  onClose(): void;
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
            <MemberRow key={m.userId} member={m} isOwner={m.userId === ownerUserId} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function MemberPanel({ members, ownerUserId, open, onClose }: MemberPanelProps) {
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
    </aside>
  );
}
