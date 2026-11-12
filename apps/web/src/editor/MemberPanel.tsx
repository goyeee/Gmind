import { useEffect, useRef, useState } from 'react';
import { api, apiPost, ApiError } from '../api/client';
import type { PresenceMember } from './collab';
import { Avatar, type MemberOption } from './TaskFields';
import './member-panel.css';

/**
 * 协作成员面板 — M2 Task 6（FR-COL-005）起家，2026-10-25 按 Figma 原型
 * ShareModal（members/invite 两 tab）重排：
 *
 * 协作成员 tab：全量协作者名单（GET /api/files/:id/collaborators，owner 首位 +
 * 协作者行），每行 = 头像 / 昵称（创建者徽标）+「部门 · 分组」归属副行（无挂靠
 * 兜底「未归属部门」）+ 在线态（presence 融合：编辑中徽标 / 在线绿点）+ owner
 * 视角的移除钮（DELETE /files/:id/collaborators/:userId，收回访问权）。原
 * 「正在编辑/正在查看」分组退役——在线语义融进行内标记（编辑中徽标优先于绿点）。
 *
 * 邀请协作 tab（owner 专属，canInvite）：主路径 = 搜索候选下拉（300ms 防抖，q 模糊
 * 昵称/手机号/邮箱，第一页 50 条，服务端已排除 owner/既有协作者）→ 点击候选加入
 * 「待邀请」列表（X 移除/清空）→「确定」批量拉取为协作者（POST collaborators，
 * 直接生效无需接受）→ 成功回协作成员 tab；次要折叠入口保留粘贴邮箱/手机号批量
 * 邀请（站外联系人唯一通道，裁定 2026-10-11）。角色三档（可编辑/可评论/仅查看）
 * 为原型 mock——一期角色集只有 owner/editor，不设权限下拉（如实登记，四级权限
 * 随二期体系）。
 *
 * rows 附 data-member-user 供测试/样式钩用；面板关闭时整棵不渲染。
 */

export interface MemberPanelProps {
  members: PresenceMember[];
  /** 2026-10-25 起不再消费（名单行 isOwner 来自 collaborators 投影）；保留接口
   *  兼容 EditorPage 既有装配。 */
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
   *  离线成员不在 presence（名单行仍渲染，来自 collaborators 目录）时照常定位。 */
  focusUserId?: string | null;
}

/** 联系人拆分（brief 口径）：逗号/分号/顿号/任意空白（含换行）皆作分隔。 */
const CONTACT_SPLIT_RE = /[,\s;；、]+/;

/** 单次邀请上限（与 server invite-request.schema 的 50 同口径，客户端先拦免往返）。 */
const INVITE_MAX = 50;
/** 候选下拉每页条数（原型下拉滚动语义的真实化：搜索驱动 + 首页 50 条）。 */
const PICKER_PAGE_SIZE = 50;

/** 可拉取用户目录行（GET /files/:id/invitable-users 契约；deptName/groupNames
 *  为 2026-10-25 归属行扩展）。 */
interface InvitableUser {
  userId: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  deptName: string | null;
  groupNames: string[];
}

/** 协作者名单行（GET /files/:id/collaborators 契约；归属行同上扩展）。 */
interface CollaboratorRow {
  userId: string;
  nickname: string;
  role: string;
  isOwner: boolean;
  avatar: string | null;
  deptName: string | null;
  groupNames: string[];
}

/** 归属副行文案：部门 · 分组1 · 分组2；全空兜底「未归属部门」（原型口径）。 */
function affiliationText(deptName: string | null, groupNames: string[]): string {
  return [deptName, ...groupNames].filter(Boolean).join(' · ') || '未归属部门';
}

/**
 * 邀请协作（owner 专属，2026-10-25 按原型 invite tab 形态重做）：搜索候选下拉 +
 * 待邀请列表 + 「清空 / 确定」批量拉取；站外联系人粘贴框保留为折叠次要入口。
 * 错误 toast 直接透出服务端 message（NFR-USE-005 两段式沿用）。
 */
export function InviteSection({ fileId, showToast, onInvited }: { fileId: string; showToast(message: string): void; onInvited(): void }) {
  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState(''); // 防抖后的生效关键词
  const [dropOpen, setDropOpen] = useState(false);
  const [dir, setDir] = useState<{ items: InvitableUser[]; total: number } | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, InvitableUser>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const searchWrapRef = useRef<HTMLDivElement | null>(null);

  // 搜索防抖（300ms）：生效关键词变化即重取第一页
  useEffect(() => {
    const t = setTimeout(() => setQ(keyword.trim()), 300);
    return () => clearTimeout(t);
  }, [keyword]);

  // 目录拉取：q/fileId/拉取后 reloadTick 变化即重取；失败按空目录降级
  useEffect(() => {
    let alive = true;
    api<{ items: InvitableUser[]; total: number }>(
      `/files/${fileId}/invitable-users?q=${encodeURIComponent(q)}&page=1&size=${PICKER_PAGE_SIZE}`,
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
  }, [fileId, q, reloadTick]);

  // 下拉外点关闭（只关下拉，不动面板/待邀请区）
  useEffect(() => {
    if (!dropOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!searchWrapRef.current?.contains(e.target as Node)) setDropOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [dropOpen]);

  const addPending = (u: InvitableUser): void => {
    setPending((prev) => {
      if (prev.has(u.userId)) return prev;
      const next = new Map(prev);
      next.set(u.userId, u);
      return next;
    });
  };

  const pull = (): void => {
    if (pending.size === 0) {
      showToast('请先选择要邀请的成员');
      return;
    }
    if (pending.size > INVITE_MAX) {
      showToast(`单次最多拉取 ${INVITE_MAX} 位协作者`);
      return;
    }
    setSubmitting(true);
    void apiPost<{ added: number; skipped: number }>(`/files/${fileId}/collaborators`, {
      userIds: [...pending.keys()],
    })
      .then((res) => {
        showToast(
          res.skipped > 0
            ? `已邀请 ${res.added} 人，${res.skipped} 位已是协作者或无效`
            : `已邀请 ${res.added} 人`,
        );
        setPending(new Map());
        setKeyword('');
        setDropOpen(false);
        setReloadTick((t) => t + 1); // 重取目录（新协作者已被服务端排除）
        onInvited(); // 回协作成员 tab（原型 confirm 后跳 members 语义）
      })
      .catch((e: unknown) => {
        showToast(e instanceof Error ? e.message : '邀请失败，请稍后重试');
      })
      .finally(() => setSubmitting(false));
  };

  // 候选 = 服务端已排除 owner/协作者，再前端滤掉已加入待邀请的行
  const cands = (dir?.items ?? []).filter((u) => !pending.has(u.userId));

  return (
    <section className="member-invite" data-testid="invite-section">
      <h3 className="member-group-title">邀请协作</h3>
      <div className="member-invite-searchwrap" ref={searchWrapRef}>
        <input
          className="member-invite-search"
          data-testid="invite-user-search"
          aria-label="搜索站内用户（昵称/手机号/邮箱）"
          placeholder="搜索姓名、手机号或邮箱，选择要邀请的成员"
          value={keyword}
          onFocus={() => setDropOpen(true)}
          onChange={(e) => {
            setKeyword(e.target.value);
            setDropOpen(true);
          }}
        />
        {dropOpen && (
          <ul className="member-invite-drop" data-testid="invite-user-list">
            {cands.map((u) => (
              <li key={u.userId}>
                <button
                  type="button"
                  className="member-invite-row"
                  data-testid="invite-user-row"
                  data-member-user={u.userId}
                  onClick={() => addPending(u)}
                >
                  <Avatar userId={u.userId} nickname={u.nickname} size={26} />
                  <span className="member-invite-name">{u.nickname}</span>
                  <span className="member-invite-contact">{u.phone ?? u.email ?? ''}</span>
                  <span className="member-invite-affil">{affiliationText(u.deptName, u.groupNames)}</span>
                </button>
              </li>
            ))}
            {cands.length === 0 && (
              <li className="member-invite-empty">{q === '' ? '暂无可邀请的站内用户' : '没有可添加的成员'}</li>
            )}
            {dir && dir.total > PICKER_PAGE_SIZE && (
              <li className="member-invite-more">共 {dir.total} 人，输入关键词缩小范围</li>
            )}
          </ul>
        )}
      </div>
      <h4 className="member-invite-pending-title">
        待邀请
        {pending.size > 0 && (
          <span className="member-group-count" data-testid="invite-selected-count">
            已选 {pending.size} 人
          </span>
        )}
      </h4>
      {pending.size === 0 ? (
        <p className="member-invite-hint-line">搜索并选择成员，点击「确定」加为协作者</p>
      ) : (
        <ul className="member-invite-pending" data-testid="invite-pending-list">
          {[...pending.values()].map((u) => (
            <li key={u.userId} className="member-invite-pending-row" data-testid="invite-pending-row">
              <Avatar userId={u.userId} nickname={u.nickname} size={26} />
              <span className="member-invite-name">{u.nickname}</span>
              <span className="member-invite-affil">{affiliationText(u.deptName, u.groupNames)}</span>
              <button
                type="button"
                className="member-invite-remove"
                aria-label={`移除 ${u.nickname}`}
                onClick={() =>
                  setPending((prev) => {
                    const next = new Map(prev);
                    next.delete(u.userId);
                    return next;
                  })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="member-invite-footer">
        <button
          type="button"
          className="member-invite-clear"
          disabled={pending.size === 0}
          onClick={() => setPending(new Map())}
        >
          清空
        </button>
        <button
          type="button"
          className="member-invite-pull"
          data-testid="invite-pull-submit"
          disabled={submitting || pending.size === 0}
          onClick={pull}
        >
          确定
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

/** 协作者名单行：头像 +（昵称 + 归属副行）+ 身份/在线标记 + owner 视角移除钮。 */
function MemberRow({
  row,
  avatar,
  online,
  editing,
  isSelf,
  canRemove,
  onRemove,
}: {
  row: CollaboratorRow;
  avatar?: string | null;
  online: boolean;
  editing: boolean;
  isSelf: boolean;
  canRemove: boolean;
  onRemove(): void;
}) {
  return (
    <li className={'member-row' + (online ? ' member-row-online' : '')} data-testid="member-row" data-member-user={row.userId}>
      <span className="member-avatar" aria-hidden>
        <Avatar userId={row.userId} nickname={row.nickname} avatar={avatar} size={22} />
        {online && !editing && <span className="member-online-dot" aria-hidden />}
      </span>
      <span className="member-row-main">
        <span className="member-name">
          {row.nickname}
          {isSelf && <em className="member-self-mark">（我）</em>}
          {row.isOwner && (
            <span className="member-owner-badge" data-testid="owner-badge">
              创建者
            </span>
          )}
          {editing && (
            <span className="member-editing-badge" data-testid="member-editing-badge">
              编辑中
            </span>
          )}
        </span>
        <span className="member-row-sub">{affiliationText(row.deptName, row.groupNames)}</span>
      </span>
      {canRemove && !row.isOwner && (
        <button type="button" className="member-remove-btn" data-testid="member-remove-btn" aria-label={`移除 ${row.nickname}`} onClick={onRemove}>
          移除
        </button>
      )}
    </li>
  );
}

export function MemberPanel({ members, open, onClose, fileId, canInvite, showToast, focusUserId, memberIndex }: MemberPanelProps & { memberIndex?: Map<string, MemberOption> }) {
  const [tab, setTab] = useState<'members' | 'invite'>('members');
  const [collabs, setCollabs] = useState<CollaboratorRow[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // 名单拉取：面板打开（或拉取/移除后 reloadTick 变化）时取全量协作者目录；
  // 失败降级空名单（面板结构仍在，在线区不受影响口径不再适用——名单即主体）。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api<CollaboratorRow[]>(`/files/${fileId}/collaborators`)
      .then((rows) => {
        if (alive) setCollabs(rows);
      })
      .catch(() => {
        if (alive) setCollabs([]);
      });
    return () => {
      alive = false;
    };
  }, [open, fileId, reloadTick]);

  // 定位目标行（M6 T9 评审修复轮）：面板打开且带目标时，行 scrollIntoView 进视口
  // + 短时高亮（2s 后移除）。行元素按 data-member-user 直查（effect 在渲染后运行，
  // 面板 open 才有行）；目标行不存在或目标为空时 no-op。
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
  }, [open, focusUserId, collabs]);

  if (!open) return null;
  const presenceByUser = new Map(members.map((m) => [m.userId, m]));
  const rows = collabs ?? [];
  const onlineCount = rows.filter((r) => presenceByUser.has(r.userId)).length;

  const remove = (target: CollaboratorRow): void => {
    if (removing) return;
    setRemoving(true);
    void api(`/files/${fileId}/collaborators/${target.userId}`, { method: 'DELETE' })
      .then(() => {
        showToast(`已移除 ${target.nickname}`);
        setReloadTick((t) => t + 1);
      })
      .catch((e: unknown) => {
        showToast(e instanceof Error ? e.message : '移除失败，请稍后重试');
      })
      .finally(() => setRemoving(false));
  };

  return (
    <aside className="member-panel" data-testid="member-panel">
      <header className="member-panel-header">
        <span className="member-panel-title">协作成员</span>
        <span className="member-panel-sub" data-testid="member-online-count">
          {collabs === null ? '' : `在线 ${onlineCount}/${rows.length}`}
        </span>
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
      {canInvite && (
        <div className="member-tabs" role="tablist" aria-label="成员面板页签">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'members'}
            className={tab === 'members' ? 'member-tab active' : 'member-tab'}
            data-testid="member-tab-members"
            onClick={() => setTab('members')}
          >
            协作成员 {rows.length > 0 ? rows.length : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'invite'}
            className={tab === 'invite' ? 'member-tab active' : 'member-tab'}
            data-testid="member-tab-invite"
            onClick={() => setTab('invite')}
          >
            邀请协作
          </button>
        </div>
      )}
      {(!canInvite || tab === 'members') && (
        <section className="member-group" data-testid="member-group-all">
          {collabs === null ? (
            <p className="member-group-empty">加载中…</p>
          ) : rows.length === 0 ? (
            <p className="member-group-empty">暂无协作成员</p>
          ) : (
            <ul className="member-rows">
              {rows.map((r) => {
                const p = presenceByUser.get(r.userId);
                return (
                  <MemberRow
                    key={r.userId}
                    row={r}
                    avatar={memberIndex?.get(r.userId)?.avatar}
                    online={!!p}
                    editing={!!p?.editing}
                    isSelf={!!p?.isSelf}
                    canRemove={!!canInvite}
                    onRemove={() => remove(r)}
                  />
                );
              })}
            </ul>
          )}
        </section>
      )}
      {canInvite && tab === 'invite' && (
        <InviteSection
          fileId={fileId}
          showToast={showToast}
          onInvited={() => {
            // 原型 confirm 后跳 members 语义：回协作成员 tab 并重拉全量名单
            //（新协作者行立即出现——InviteSection 内部的 reloadTick 只重取目录）
            setTab('members');
            setReloadTick((t) => t + 1);
          }}
        />
      )}
    </aside>
  );
}
