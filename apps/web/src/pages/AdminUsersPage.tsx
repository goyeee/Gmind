import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminUserListItem, SystemRole } from '@gmind/shared';
import { createAdminUser, fetchAdminUsers, updateAdminUser } from '../api/admin';
import { api } from '../api/client';
import { WorkspaceShell } from './WorkspaceShell';

/**
 * 账号管理页（/admin/users，移植 mindgrid 账号体系）：成员列表 + 添加账号 + 角色/状态/昵称管理。
 *
 * - 权限形态：入口只对 super_admin 渲染（WorkspacePage 按 /users/me 判定）；member 直敲
 *   URL 时列表加载 403，服务端两段式文案进错误条（不做前端路由门，后端 AdminGuard 兜底）；
 * - 自己那行：停用/降级控件禁用 + title 提示（后端另有 409 防呆兜底，双保险）；
 * - 只停用不删除：停用走 confirm（停用后该账号立即退出且无法登录，可再启用）；
 * - 全部动作错误（409/404/400）服务端 message 已两段式，直接 toast；成功即时回刷列表。
 */

/** 手机号口径与 server createAdminAccountSchema 同源（/^1\d{10}$/）。 */
const PHONE_RE = /^1\d{10}$/;

const ROLE_LABEL: Record<SystemRole, string> = { super_admin: '超级管理员', member: '成员' };

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

function fmtTime(iso: string | null): string {
  // createdAt 历史脏数据防御回退 null（服务端 toItem）：显示占位而非抛错。
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

/** GET /users/me 在本页的最小消费面：自己那行的禁用判定 + 昵称缺省。 */
interface MeShape {
  id: string;
  nickname: string;
}

export function AdminUsersPage() {
  const [me, setMe] = useState<MeShape | null>(null);
  const [users, setUsers] = useState<AdminUserListItem[] | null>(null);
  const [error, setError] = useState('');
  // 分页 + 搜索（2026-10-21 需求方反馈「加载慢/无分页」：开发库 2 万+ 账号全量
  // 拉取不可行）。q 输入 300ms 防抖落 qDebounced，搜索变化回第 1 页。
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  const [total, setTotal] = useState(0);
  const [qText, setQText] = useState('');
  const [q, setQ] = useState('');

  // 添加账号对话框（手机号+昵称）；失败（409 已注册/400 格式）保持弹窗开、文案走 toast
  const [addOpen, setAddOpen] = useState(false);
  const [addPhone, setAddPhone] = useState('');
  const [addNickname, setAddNickname] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 改昵称对话框（PATCH 契约含 nickname；行内编辑的可选实现取弹窗形态，与工作台重命名一致）
  const [renameTarget, setRenameTarget] = useState<AdminUserListItem | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // 成功/失败动作轻提示（形态同 WorkspacePage/SettingsPage toast）
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(message: string): void {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
    setToast(message);
  }

  const reload = useCallback(async () => {
    // 列表失败（member 403 / 网络）进错误条不进空态：空态语义=「库里没有人」，两者必须区分
    const res = await fetchAdminUsers(page, PAGE_SIZE, q);
    setUsers(res.items);
    setTotal(res.total);
  }, [page, q]);

  useEffect(() => {
    void api<MeShape>('/users/me').then(setMe).catch(() => undefined);
  }, []);
  useEffect(() => {
    void reload().catch((e) => setError(msgOf(e)));
  }, [reload]);

  // 搜索防抖：输入停 300ms 才发请求，且回第 1 页
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qText.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [qText]);

  /** 动作统一通道：成功即回刷（即时刷新口径），失败 toast 服务端两段式文案。 */
  async function act(fn: () => Promise<unknown>, successMessage?: string): Promise<void> {
    try {
      await fn();
      await reload();
      if (successMessage) showToast(successMessage);
    } catch (e) {
      showToast(msgOf(e));
    }
  }

  function openAdd(): void {
    setAddPhone('');
    setAddNickname('');
    setAddOpen(true);
  }

  async function submitAdd(): Promise<void> {
    // 客户端预检与服务端 schema 同文案（省一次往返）；并发窗口的重复注册仍由 409 兜底。
    // 错误统一走 toast（契约口径：服务端 {message} 已两段式，直接 toast），弹窗保持开以供改输入
    if (!PHONE_RE.test(addPhone)) return showToast('手机号格式不正确，请检查后重试');
    const nickname = addNickname.trim();
    if (!nickname) return showToast('昵称不能为空，请填写后重试');
    setSubmitting(true);
    try {
      await createAdminUser({ phone: addPhone, nickname });
      setAddOpen(false);
      // 升序列表新增在末页——跳过去让新行立刻可见（无搜索词时；有搜索词则命中即现）
      if (q === '') {
        const lastPage = Math.max(1, Math.ceil((total + 1) / PAGE_SIZE));
        if (lastPage !== page) {
          setPage(lastPage); // effect 驱动 reload
        } else {
          await reload();
        }
      } else {
        await reload();
      }
      showToast('已添加，该成员可用手机号+验证码登录');
    } catch (e) {
      showToast(msgOf(e));
    } finally {
      setSubmitting(false);
    }
  }

  /** 停用须 confirm（文案=后果+可逆说明）；启用无确认。 */
  function toggleStatus(u: AdminUserListItem): void {
    if (u.status === 'active') {
      if (!window.confirm('停用后该账号立即退出且无法登录，可再启用。确定停用该账号吗？')) return;
    }
    void act(
      () => updateAdminUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' }),
      u.status === 'active' ? '已停用' : '已启用',
    );
  }

  function changeRole(u: AdminUserListItem, role: SystemRole): void {
    if (role === u.systemRole) return;
    void act(() => updateAdminUser(u.id, { systemRole: role }), `已切换为${ROLE_LABEL[role]}`);
  }

  function openRename(u: AdminUserListItem): void {
    setRenameTarget(u);
    setRenameValue(u.nickname);
  }

  async function submitRename(): Promise<void> {
    if (!renameTarget) return;
    const nickname = renameValue.trim();
    if (!nickname) return showToast('昵称不能为空，请填写后重试');
    const target = renameTarget;
    setRenameTarget(null);
    await act(() => updateAdminUser(target.id, { nickname }), '昵称已更新');
  }

  const loading = users === null && !error;

  return (
    <WorkspaceShell activeNav={null}>
      <main className="ws-content admin-users-page" data-testid="admin-users-page">
        <div className="ws-section-head">
          <h2>账号管理</h2>
          <div className="admin-head-actions">
            <input
              className="search-input admin-user-search"
              data-testid="admin-user-search"
              placeholder="搜索昵称 / 手机号 / 邮箱"
              value={qText}
              onChange={(e) => setQText(e.target.value)}
            />
            <button className="primary ws-head-action" data-testid="add-user-btn" onClick={openAdd}>
              添加账号
            </button>
          </div>
        </div>
        {error && <p className="error" data-testid="admin-users-error">{error}</p>}

      {loading && <p className="admin-users-hint" data-testid="admin-users-loading">加载中…</p>}
      {users !== null && users.length === 0 && (
        <p className="admin-users-hint" data-testid="admin-users-empty">暂无成员，点击「添加账号」创建</p>
      )}

      {users !== null && users.length > 0 && (
        <>
          <div className="admin-user-table" data-testid="admin-user-table">
          <div className="admin-table-head">
            <span>昵称</span>
            <span>手机号</span>
            <span>角色</span>
            <span>状态</span>
            <span>注册时间</span>
            <span>文件数</span>
            <span>操作</span>
          </div>
          {users.map((u) => {
            const self = u.id === me?.id;
            return (
              <div key={u.id} className="admin-table-row" data-testid="admin-user-row" data-self={self || undefined}>
                <span className="cell nickname">{u.nickname}</span>
                <span className="cell" data-testid="user-phone">
                  {u.phone ?? '—'}
                </span>
                <span className="cell">
                  <span className={'role-badge ' + (u.systemRole === 'super_admin' ? 'admin' : 'member')} data-testid="user-role">
                    {ROLE_LABEL[u.systemRole]}
                  </span>
                </span>
                <span className="cell">
                  <span className={'status-cell ' + (u.status === 'active' ? 'on' : 'off')} data-testid="user-status">
                    <i className="status-dot" />
                    {u.status === 'active' ? '启用' : '停用'}
                  </span>
                </span>
                <span className="cell">{fmtTime(u.createdAt)}</span>
                <span className="cell" data-testid="user-file-count">
                  {u.fileCount}
                </span>
                <span className="cell ops">
                  <select
                    data-testid="role-select"
                    value={u.systemRole}
                    aria-label={`切换 ${u.nickname} 的角色`}
                    disabled={self}
                    title={self ? '不能取消自己的超级管理员身份，请让其他超级管理员操作' : undefined}
                    onChange={(e) => changeRole(u, e.target.value as SystemRole)}
                  >
                    <option value="super_admin">超级管理员</option>
                    <option value="member">成员</option>
                  </select>
                  <button
                    data-testid="toggle-status-btn"
                    className={u.status === 'active' ? 'danger' : ''}
                    disabled={self}
                    title={self ? '不能停用自己的账号，请让其他超级管理员操作' : undefined}
                    onClick={() => toggleStatus(u)}
                  >
                    {u.status === 'active' ? '停用' : '启用'}
                  </button>
                  <button data-testid="rename-user-btn" onClick={() => openRename(u)}>
                    改昵称
                  </button>
                </span>
              </div>
            );
          })}
          </div>
          {/* 分页器（2026-10-21）：页码钳制在 [1, 总页数]；搜索中同样分页 */}
          <div className="admin-pager" data-testid="admin-pager">
            <span className="admin-pager-total" data-testid="admin-pager-total">
              共 {total} 人
            </span>
            <button
              data-testid="admin-pager-prev"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </button>
            <span data-testid="admin-pager-info">
              {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页
            </span>
            <button
              data-testid="admin-pager-next"
              disabled={page >= Math.ceil(total / PAGE_SIZE)}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </>
      )}

      {toast && (
        <div className="workspace-toast" data-testid="toast" role="alert">
          {toast}
        </div>
      )}

      {addOpen && (
        <div className="modal-mask" data-testid="add-user-modal">
          <div className="modal">
            <h3>添加账号</h3>
            <input
              autoFocus
              data-testid="add-user-phone"
              placeholder="手机号（11 位，登录时用）"
              value={addPhone}
              onChange={(e) => setAddPhone(e.target.value)}
            />
            <input
              data-testid="add-user-nickname"
              placeholder="昵称（1~32 字）"
              maxLength={32}
              value={addNickname}
              onChange={(e) => setAddNickname(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitAdd();
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setAddOpen(false)}>取消</button>
              <button className="primary" data-testid="add-user-confirm" disabled={submitting} onClick={() => void submitAdd()}>
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="modal-mask" data-testid="rename-user-modal">
          <div className="modal">
            <h3>修改昵称</h3>
            <input
              autoFocus
              data-testid="rename-user-input"
              maxLength={32}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename();
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setRenameTarget(null)}>取消</button>
              <button className="primary" data-testid="rename-user-confirm" onClick={() => void submitRename()}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
      </main>
    </WorkspaceShell>
  );
}
