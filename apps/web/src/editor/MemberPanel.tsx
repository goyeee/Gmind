import { useEffect, useRef, useState } from 'react';
import { api, apiPost, apiPatch, ApiError } from '../api/client';
import type { PresenceMember } from './collab';
import { Avatar, type MemberOption } from './TaskFields';
import './member-panel.css';

const CONTACT_SPLIT_RE = /[,\s;；、]+/;
const INVITE_MAX = 50;
const PICKER_PAGE_SIZE = 50;
type CollaboratorRole = 'editor' | 'commenter' | 'viewer';
const ROLE_LABEL: Record<CollaboratorRole | 'owner', string> = { owner: '所有者', editor: '可编辑', commenter: '可评论', viewer: '仅查看' };

interface InvitableUser { userId: string; nickname: string; phone: string | null; email: string | null; deptName: string | null; groupNames: string[] }
export interface CollaboratorRow { userId: string; nickname: string; role: string; isOwner: boolean; avatar: string | null; deptName: string | null; groupNames: string[] }
type Pending = { user: InvitableUser; role: CollaboratorRole };

function affiliationText(deptName: string | null, groupNames: string[]): string {
  return [deptName, ...groupNames].filter(Boolean).join(' · ') || '未归属部门';
}

/** 弹窗共享的协作者数据源：打开时拉取，邀请/移除/改角色后统一刷新。 */
export function useCollaborators(open: boolean, fileId: string, showToast: (message: string) => void) {
  const [collabs, setCollabs] = useState<CollaboratorRow[] | null>(null);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const reload = () => setReloadTick((v) => v + 1);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError('');
    api<CollaboratorRow[]>(`/files/${fileId}/collaborators`)
      .then((rows) => { if (alive) setCollabs(rows); })
      .catch(() => { if (alive) setError('成员名单加载失败，请点击重试'); });
    return () => { alive = false; };
  }, [open, fileId, reloadTick]);

  const remove = async (target: CollaboratorRow): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/files/${fileId}/collaborators/${target.userId}`, { method: 'DELETE' });
      showToast(`已移除 ${target.nickname}`);
      reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '移除失败，请稍后重试');
    } finally { setBusy(false); }
  };

  const changeRole = async (target: CollaboratorRow, role: CollaboratorRole): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await apiPatch(`/files/${fileId}/collaborators/${target.userId}`, { role });
      setCollabs((rows) => rows?.map((r) => r.userId === target.userId ? { ...r, role } : r) ?? null);
      showToast(`已将 ${target.nickname} 设为${ROLE_LABEL[role]}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '角色修改失败，请稍后重试');
      reload();
    } finally { setBusy(false); }
  };

  return { collabs, error, busy, reload, remove, changeRole };
}

/** 邀请协作：搜索/推荐 → 待邀请（逐项角色）→ 直接添加并通知。 */
export function InviteSection({ fileId, showToast, onInvited }: { fileId: string; showToast(message: string): void; onInvited(): void }) {
  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');
  const [dropOpen, setDropOpen] = useState(false);
  const [dir, setDir] = useState<{ items: InvitableUser[]; total: number } | null>(null);
  const [dirError, setDirError] = useState('');
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const searchWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(keyword.trim()), 300);
    return () => clearTimeout(t);
  }, [keyword]);

  useEffect(() => {
    let alive = true;
    setDirError('');
    api<{ items: InvitableUser[]; total: number }>(`/files/${fileId}/invitable-users?q=${encodeURIComponent(q)}&page=1&size=${PICKER_PAGE_SIZE}`)
      .then((res) => { if (alive) setDir(res); })
      .catch(() => { if (alive) setDirError('成员目录加载失败，请点击重试'); });
    return () => { alive = false; };
  }, [fileId, q, reloadTick]);

  useEffect(() => {
    if (!dropOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!searchWrapRef.current?.contains(e.target as Node)) setDropOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [dropOpen]);

  const addPending = (u: InvitableUser): void => {
    setPending((prev) => prev.has(u.userId) ? prev : new Map(prev).set(u.userId, { user: u, role: 'editor' }));
  };
  const cands = (dir?.items ?? []).filter((u) => !pending.has(u.userId));

  const pull = (): void => {
    if (pending.size === 0) return showToast('请先选择要邀请的成员');
    if (pending.size > INVITE_MAX) return showToast(`单次最多拉取 ${INVITE_MAX} 位协作者`);
    setSubmitting(true);
    void apiPost<{ added: number; skipped: number }>(`/files/${fileId}/collaborators`, {
      members: [...pending.values()].map((p) => ({ userId: p.user.userId, role: p.role })),
    })
      .then((res) => {
        showToast(res.skipped > 0 ? `已邀请 ${res.added} 人，${res.skipped} 位已是协作者或无效` : `已邀请 ${res.added} 人`);
        setPending(new Map());
        setKeyword('');
        setDropOpen(false);
        setReloadTick((t) => t + 1);
        onInvited();
      })
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : '邀请失败，请稍后重试'))
      .finally(() => setSubmitting(false));
  };

  return (
    <section className="member-invite" data-testid="invite-section">
      <div className="member-invite-scroll">
        <div className="member-invite-searchwrap" ref={searchWrapRef}>
          <input
            className="member-invite-search"
            data-testid="invite-user-search"
            aria-label="搜索站内用户（昵称/手机号/邮箱）"
            placeholder="搜索姓名、手机号或邮箱，选择要邀请的成员"
            value={keyword}
            onFocus={() => setDropOpen(true)}
            onChange={(e) => { setKeyword(e.target.value); setDropOpen(true); }}
          />
          {dropOpen && (
            <ul className="member-invite-drop" data-testid="invite-user-list">
              {cands.map((u) => (
                <li key={u.userId}>
                  <button type="button" className="member-invite-row" data-testid="invite-user-row" data-member-user={u.userId} onClick={() => addPending(u)}>
                    <Avatar userId={u.userId} nickname={u.nickname} size={26} />
                    <span className="member-invite-name">{u.nickname}</span>
                    <span className="member-invite-contact">{u.phone ?? u.email ?? ''}</span>
                    <span className="member-invite-affil">{affiliationText(u.deptName, u.groupNames)}</span>
                  </button>
                </li>
              ))}
              {cands.length === 0 && !dirError && <li className="member-invite-empty">{q === '' ? '暂无可邀请的站内用户' : '没有可添加的成员'}</li>}
              {dirError && <li className="member-invite-empty">{dirError} <button type="button" data-testid="invite-directory-retry" onClick={() => setReloadTick((v) => v + 1)}>重试</button></li>}
              {dir && dir.total > PICKER_PAGE_SIZE && <li className="member-invite-more">共 {dir.total} 人，输入关键词缩小范围</li>}
            </ul>
          )}
        </div>
        <h4 className="member-invite-pending-title">
          待邀请
          {pending.size > 0 && <span className="member-group-count" data-testid="invite-selected-count">已选 {pending.size} 人</span>}
        </h4>
        {pending.size === 0 ? (
          <p className="member-invite-hint-line">搜索并选择成员，点击「确定」加为协作者</p>
        ) : (
          <ul className="member-invite-pending" data-testid="invite-pending-list">
            {[...pending.values()].map(({ user: u, role }) => (
              <li key={u.userId} className="member-invite-pending-row" data-testid="invite-pending-row">
                <Avatar userId={u.userId} nickname={u.nickname} size={26} />
                <span className="member-invite-name">{u.nickname}</span>
                <span className="member-invite-affil">{affiliationText(u.deptName, u.groupNames)}</span>
                <select data-testid="invite-pending-role" aria-label={`${u.nickname} 的协作权限`} value={role} onChange={(e) => {
                  const nextRole = e.target.value as CollaboratorRole;
                  setPending((prev) => new Map(prev).set(u.userId, { user: u, role: nextRole }));
                }}>
                  <option value="editor">可编辑</option><option value="commenter">可评论</option><option value="viewer">仅查看</option>
                </select>
                <button type="button" className="member-invite-remove" aria-label={`移除 ${u.nickname}`} onClick={() => setPending((prev) => { const next = new Map(prev); next.delete(u.userId); return next; })}>×</button>
              </li>
            ))}
          </ul>
        )}
        {pending.size === 0 && cands.length > 0 && (
          <section className="member-invite-recommended">
            <h4>可邀请成员</h4>
            <ul>
              {cands.slice(0, 5).map((u) => (
                <li key={u.userId} data-testid="invite-recommended-row">
                  <Avatar userId={u.userId} nickname={u.nickname} size={32} />
                  <span className="member-invite-name">{u.nickname}<small>{affiliationText(u.deptName, u.groupNames)}</small></span>
                  <button type="button" data-testid="invite-recommended-add" onClick={() => addPending(u)}>添加</button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <button type="button" className="member-invite-contacts-toggle" data-testid="invite-contacts-toggle" aria-expanded={contactsOpen} onClick={() => setContactsOpen((v) => !v)}>
          邀请站外联系人{contactsOpen ? ' ▴' : ' ▾'}
        </button>
        {contactsOpen && <ContactsInvite fileId={fileId} showToast={showToast} />}
      </div>
      <div className="member-invite-footer">
        <span>{pending.size > 0 ? `已选择 ${pending.size} 人` : '添加后立即成为协作者，并收到站内通知'}</span>
        <div>
          <button type="button" className="member-invite-clear" disabled={pending.size === 0} onClick={() => setPending(new Map())}>清空</button>
          <button type="button" className="member-invite-pull" data-testid="invite-pull-submit" disabled={submitting || pending.size === 0} onClick={pull}>{submitting ? '邀请中…' : '确定'}</button>
        </div>
      </div>
    </section>
  );
}

function ContactsInvite({ fileId, showToast }: { fileId: string; showToast(message: string): void }) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = (): void => {
    const contacts = draft.split(CONTACT_SPLIT_RE).filter((c) => c !== '');
    if (contacts.length === 0) return showToast('请先粘贴要邀请的邮箱或手机号');
    if (contacts.length > INVITE_MAX) return showToast(`单次最多邀请 ${INVITE_MAX} 个联系人`);
    setSubmitting(true);
    void apiPost<{ invited: number; skipped: number }>(`/files/${fileId}/invites`, { contacts })
      .then((res) => {
        showToast(res.skipped > 0 ? `已邀请 ${res.invited} 位，${res.skipped} 位已在邀请中` : `已邀请 ${res.invited} 位`);
        setDraft('');
      })
      .catch((e: unknown) => {
        const base = e instanceof Error ? e.message : '邀请失败';
        showToast(e instanceof ApiError && e.status === 400 ? `${base}，请修正后重新发送` : base);
      })
      .finally(() => setSubmitting(false));
  };
  return (
    <div className="member-invite-contacts">
      <p className="member-invite-hint">粘贴邮箱或手机号，逗号/空格/换行分隔，上限 50</p>
      <textarea className="member-invite-input" data-testid="invite-input" aria-label="邀请联系人（邮箱或手机号，逗号/空格/换行分隔）" value={draft} placeholder="如 a@example.com, 13900000001" onChange={(e) => setDraft(e.target.value)} />
      <button type="button" className="member-invite-submit" data-testid="invite-submit" disabled={submitting} onClick={submit}>发送邀请</button>
    </div>
  );
}

function MemberRow({ row, avatar, online, editing, isSelf, canManage, busy, onRemove, onRole }: {
  row: CollaboratorRow; avatar?: string | null; online: boolean; editing: boolean; isSelf: boolean; canManage: boolean; busy: boolean; onRemove(): void; onRole(role: CollaboratorRole): void;
}) {
  const role = row.isOwner ? 'owner' : row.role as CollaboratorRole;
  return (
    <li className={'member-row' + (online ? ' member-row-online' : '')} data-testid="member-row" data-member-user={row.userId}>
      <span className="member-avatar" aria-hidden>
        <Avatar userId={row.userId} nickname={row.nickname} avatar={avatar} size={32} />
        {online && !editing && <span className="member-online-dot" aria-hidden />}
      </span>
      <span className="member-row-main">
        <span className="member-name">{row.nickname}{isSelf && <em className="member-self-mark">（我）</em>}{editing && <span className="member-editing-badge" data-testid="member-editing-badge">编辑中</span>}</span>
        <span className="member-row-sub">{affiliationText(row.deptName, row.groupNames)}</span>
      </span>
      {row.isOwner ? <span className="member-owner-badge" data-testid="owner-badge">所有者</span> : canManage && ROLE_LABEL[role] ? (
        <>
          <select className="member-role-select" data-testid="member-role-select" aria-label={`${row.nickname} 的协作权限`} value={role} disabled={busy} onChange={(e) => onRole(e.target.value as CollaboratorRole)}>
            <option value="editor">可编辑</option><option value="commenter">可评论</option><option value="viewer">仅查看</option>
          </select>
          <button type="button" className="member-remove-btn" data-testid="member-remove-btn" aria-label={`移除 ${row.nickname}`} disabled={busy} onClick={onRemove}>移除</button>
        </>
      ) : <span className="member-role-readonly">{ROLE_LABEL[role] ?? row.role}</span>}
    </li>
  );
}

export function MembersSection({ open, rows, members, memberIndex, canManage, busy, focusUserId, error, onRetry, onInvite, onRemove, onRole }: {
  open: boolean; rows: CollaboratorRow[] | null; members: PresenceMember[]; memberIndex?: Map<string, MemberOption>; canManage: boolean; busy: boolean; focusUserId?: string | null; error: string; onRetry(): void; onInvite(): void; onRemove(row: CollaboratorRow): void; onRole(row: CollaboratorRow, role: CollaboratorRole): void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const list = rows ?? [];
  const presenceByUser = new Map(members.map((m) => [m.userId, m]));
  const onlineCount = list.filter((r) => presenceByUser.has(r.userId)).length;

  useEffect(() => {
    if (!open || !focusUserId) return;
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-member-user="${CSS.escape(focusUserId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('member-row-located');
    const timer = setTimeout(() => row.classList.remove('member-row-located'), 2000);
    return () => { clearTimeout(timer); row.classList.remove('member-row-located'); };
  }, [open, focusUserId, rows]);

  return (
    <section className="member-group" data-testid="member-group-all" ref={rootRef}>
      <div className="member-group-scroll">
        {rows === null && !error ? <p className="member-group-empty">加载中…</p> : error ? (
          <p className="member-group-empty">{error} <button type="button" onClick={onRetry}>重试</button></p>
        ) : (
          <ul className="member-rows">
            {list.map((r) => {
              const p = presenceByUser.get(r.userId);
              return <MemberRow key={r.userId} row={r} avatar={memberIndex?.get(r.userId)?.avatar ?? r.avatar} online={!!p} editing={!!p?.editing} isSelf={!!p?.isSelf} canManage={canManage} busy={busy} onRemove={() => onRemove(r)} onRole={(role) => onRole(r, role)} />;
            })}
          </ul>
        )}
        {rows !== null && !error && list.every((r) => r.isOwner) && (
          <div className="member-empty">
            <b>还没有邀请其他人</b><span>邀请同事一起编辑、评论和跟进任务</span>
            {canManage && <button type="button" onClick={onInvite}>邀请协作</button>}
          </div>
        )}
      </div>
      <footer className="member-list-footer">
        <span data-testid="member-online-count">{rows === null ? '' : `共 ${list.length} 人 · ${onlineCount} 人在线`}</span>
        {canManage && <button type="button" onClick={onInvite}>邀请更多成员</button>}
      </footer>
    </section>
  );
}
