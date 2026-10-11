import { useEffect, useState } from 'react';
import { api, apiPost, ApiError } from '../api/client';
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
 * 邀请区（2026-10-11 需求方裁定重做）：canInvite（EditorPage 以当前用户 id ===
 * ownerUserId 判定，WorkspacePage 行菜单同口径）时面板底部附邀请区——主路径
 * 站内用户 picker（搜索/分页/勾选/一键拉取为协作者，直接生效无需接受），次要
 * 折叠入口保留粘贴邮箱/手机号批量邀请（站外联系人唯一通道；受邀联系人在接受前
 * 不是用户，成员面板数据面无 from 刷新，故无 onInvited 回调——裁定见任务报告）。
 * 拉取成功后目录自动重取（新协作者已被服务端排除出可拉列表）。
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
  /** 定位目标 userId（M6 T9 评审修复轮）：顶栏头像点击随面板打开传入——滚动该
   *  成员行进视口并短时高亮；null = 无定位目标（members-btn/溢出位/面板关闭）。
   *  离线成员不在 presence（面板无该行）时定位 no-op。 */
  focusUserId?: string | null;
}

/** 联系人拆分（brief 口径）：逗号/分号/顿号/任意空白（含换行）皆作分隔。 */
const CONTACT_SPLIT_RE = /[,\s;；、]+/;

/** 单次邀请上限（与 server invite-request.schema 的 50 同口径，客户端先拦免往返）。 */
const INVITE_MAX = 50;
/** 站内用户目录每页条数（与 server size 上限 50 同族，picker 定值 20）。 */
const PICKER_PAGE_SIZE = 20;

/** 可拉取用户目录行（GET /files/:id/invitable-users 契约）。 */
interface InvitableUser {
  userId: string;
  nickname: string;
  phone: string | null;
  email: string | null;
}

/**
 * 邀请区（2026-10-11 需求方裁定重做，取代 M4 Task 2 的纯粘贴框）：owner 专属。
 * 主路径 = 站内用户 picker——搜索（300ms 防抖）/分页浏览/勾选（跨页跨搜索保留
 * 选择）/「一键拉取」直接加成协作者（POST /files/:id/collaborators，无需对方接受）；
 * 次要入口 = 折叠的「邀请站外联系人」粘贴框（原 textarea 批量邀请流，站外联系人
 * 唯一通道，testid invite-input/invite-submit 契约不变）。
 * 错误 toast 直接透出服务端 message（NFR-USE-005 两段式沿用）。
 */
function InviteSection({ fileId, showToast }: { fileId: string; showToast(message: string): void }) {
  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState(''); // 防抖后的生效关键词
  const [page, setPage] = useState(1);
  const [dir, setDir] = useState<{ items: InvitableUser[]; total: number } | null>(null);
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // 搜索防抖（300ms）：生效关键词变化重置回第 1 页
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(keyword.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [keyword]);

  // 目录拉取：q/page/fileId/拉取后 reloadTick 变化即重取；失败按空目录降级
  useEffect(() => {
    let alive = true;
    api<{ items: InvitableUser[]; total: number }>(
      `/files/${fileId}/invitable-users?q=${encodeURIComponent(q)}&page=${page}&size=${PICKER_PAGE_SIZE}`,
    )
      .then((res) => {
        if (alive) setDir(res);
      })
      .catch(() => {
        if (alive) setDir({ items: [], total: 0 });
      });
    return () => {
      alive = false;
    };
  }, [fileId, q, page, reloadTick]);

  const toggle = (u: InvitableUser): void => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(u.userId)) next.delete(u.userId);
      else next.set(u.userId, u.nickname);
      return next;
    });
  };

  const totalPages = dir ? Math.max(1, Math.ceil(dir.total / PICKER_PAGE_SIZE)) : 1;

  const pull = (): void => {
    if (selected.size === 0) {
      showToast('请先勾选要拉取的站内用户');
      return;
    }
    if (selected.size > INVITE_MAX) {
      showToast(`单次最多拉取 ${INVITE_MAX} 位协作者`);
      return;
    }
    setSubmitting(true);
    void apiPost<{ added: number; skipped: number }>(`/files/${fileId}/collaborators`, {
      userIds: [...selected.keys()],
    })
      .then((res) => {
        showToast(
          res.skipped > 0
            ? `已拉取 ${res.added} 位协作者，${res.skipped} 位已是协作者或无效`
            : `已拉取 ${res.added} 位协作者`,
        );
        setSelected(new Map());
        setPage(1);
        setReloadTick((t) => t + 1); // 重取目录（新协作者已被排除出可拉列表）
      })
      .catch((e: unknown) => {
        showToast(e instanceof Error ? e.message : '拉取失败，请稍后重试');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <section className="member-invite" data-testid="invite-section">
      <h3 className="member-group-title">邀请协作</h3>
      <input
        className="member-invite-search"
        data-testid="invite-user-search"
        aria-label="搜索站内用户（昵称/手机号/邮箱）"
        placeholder="搜索站内用户（昵称/手机号/邮箱）"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />
      <ul className="member-invite-list" data-testid="invite-user-list">
        {(dir?.items ?? []).map((u) => (
          <li key={u.userId}>
            <label className="member-invite-row" data-testid="invite-user-row" data-member-user={u.userId}>
              <input
                type="checkbox"
                checked={selected.has(u.userId)}
                onChange={() => toggle(u)}
              />
              <span className="member-invite-name">{u.nickname}</span>
              <span className="member-invite-contact">{u.phone ?? u.email ?? ''}</span>
            </label>
          </li>
        ))}
        {dir && dir.items.length === 0 && (
          <li className="member-invite-empty">{q === '' ? '暂无可拉取的站内用户' : '无匹配用户'}</li>
        )}
      </ul>
      <div className="member-invite-pager">
        <button
          type="button"
          data-testid="invite-page-prev"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          上一页
        </button>
        <span className="member-invite-page-info" data-testid="invite-page-info">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          data-testid="invite-page-next"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          下一页
        </button>
      </div>
      <div className="member-invite-footer">
        <span className="member-invite-selected" data-testid="invite-selected-count">
          已选 {selected.size} 人
        </span>
        <button
          type="button"
          className="member-invite-pull"
          data-testid="invite-pull-submit"
          disabled={submitting || selected.size === 0}
          onClick={pull}
        >
          一键拉取
        </button>
      </div>
      <button
        type="button"
        className="member-invite-contacts-toggle"
        data-testid="invite-contacts-toggle"
        aria-expanded={contactsOpen}
        onClick={() => setContactsOpen((v) => !v)}
      >
        邀请站外联系人{contactsOpen ? ' ▴' : ' ▾'}
      </button>
      {contactsOpen && <ContactsInvite fileId={fileId} showToast={showToast} />}
    </section>
  );
}

/** 站外联系人批量粘贴邀请（原 M4 Task 2 主路径，2026-10-11 起折叠为次要入口）。 */
function ContactsInvite({ fileId, showToast }: { fileId: string; showToast(message: string): void }) {
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
        // skipped = 重邀 no-op（pending/accepted）分开计数（M5 清偿）：合并成一个总数会
        // 把「已在邀请中」伪装成「本次新邀」；M=0 保持旧文案形态「已邀请 N 位」。
        showToast(
          res.skipped > 0
            ? `已邀请 ${res.invited} 位，${res.skipped} 位已在邀请中`
            : `已邀请 ${res.invited} 位`,
        );
        setDraft('');
      })
      .catch((e: unknown) => {
        // NFR-USE-005：400 批量拒绝时服务端已把非法条目逐条回列（原因半），前端
        // 统一补「修正后重发」动作半；其余错误维持服务端 message 原样
        const base = e instanceof Error ? e.message : '邀请失败';
        showToast(
          e instanceof ApiError && e.status === 400 ? `${base}，请修正后重新发送` : base,
        );
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="member-invite-contacts">
      <p className="member-invite-hint">粘贴邮箱或手机号，逗号/空格/换行分隔，上限 50</p>
      <textarea
        className="member-invite-input"
        data-testid="invite-input"
        aria-label="邀请联系人（邮箱或手机号，逗号/空格/换行分隔）"
        value={draft}
        placeholder="如 a@example.com, 13900000001"
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="button" className="member-invite-submit" data-testid="invite-submit" disabled={submitting} onClick={submit}>
        发送邀请
      </button>
    </div>
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

export function MemberPanel({ members, ownerUserId, open, onClose, fileId, canInvite, showToast, focusUserId }: MemberPanelProps) {
  // 定位目标行（M6 T9 评审修复轮）：面板打开且带目标时，行 scrollIntoView 进视口
  // + 短时高亮（2s 后移除）。行元素按 data-member-user 直查（effect 在渲染后运行，
  // 面板 open 才有行）；目标行不存在（离线成员不在 presence）或目标为空时 no-op。
  useEffect(() => {
    if (!open || !focusUserId) return;
    const row = document.querySelector<HTMLElement>(
      `[data-testid="member-row"][data-member-user="${CSS.escape(focusUserId)}"]`,
    );
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('member-row-located');
    const timer = setTimeout(() => row.classList.remove('member-row-located'), 2_000);
    return () => {
      clearTimeout(timer);
      row.classList.remove('member-row-located');
    };
  }, [open, focusUserId]);
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
