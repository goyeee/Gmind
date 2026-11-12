import { useCallback, useEffect, useRef, useState } from 'react';
import { emailSchema, type AdminUserListItem, type OrgDepartment, type OrgGroup, type SystemRole } from '@gmind/shared';
import { createAdminUser, fetchAdminUsers, updateAdminUser } from '../api/admin';
import { api } from '../api/client';
import { createOrgDepartment, createOrgGroup, deleteOrgDepartment, deleteOrgGroup, fetchOrgDirectory } from '../api/org';
import { WorkspaceShell } from './WorkspaceShell';

/**
 * 账号管理页（/admin/users，移植 mindgrid 账号体系）——第二期批次 A 升级为「组织管理」三页签：
 * 账号管理（成员列表 + 添加 + 角色/状态/昵称 + 部门/分组挂靠）、部门管理、分组管理。
 *
 * - 权限形态：入口只对 super_admin 渲染；member 直敲 URL 时列表加载 403 进错误条（后端兜底）；
 * - 自己那行：停用/降级控件禁用 + title 提示（后端 409 防呆双保险）；
 * - 只停用不删除：停用走 confirm；全部动作错误服务端 message 两段式直接 toast，成功即时回刷；
 * - 添加账号（2026-11-12 邮箱化）：{email, nickname} 建号即启用成员、无密码——首次登录
 *   前先走登录页「忘记密码」邮箱验证码设密。
 */

const ROLE_LABEL: Record<SystemRole, string> = { super_admin: '超级管理员', member: '成员' };

/** 分组标签底色调色板（按分组 id 哈希取，纯展示）。 */
const GROUP_COLORS = ['#3370ff', '#00b42a', '#ff7d00', '#7c3aed', '#f53f3f', '#0891b1'];
function groupColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GROUP_COLORS[Math.abs(h) % GROUP_COLORS.length]!;
}

type OrgTab = 'accounts' | 'departments' | 'groups';
const ORG_TABS: Array<{ key: OrgTab; label: string }> = [
  { key: 'accounts', label: '账号管理' },
  { key: 'departments', label: '部门管理' },
  { key: 'groups', label: '分组管理' },
];

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
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
  // 分页 + 搜索（2026-10-21 需求方反馈「加载慢/无分页」）。q 输入 300ms 防抖落 q，回第 1 页。
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  const [total, setTotal] = useState(0);
  const [qText, setQText] = useState('');
  const [q, setQ] = useState('');

  // 组织管理三页签（批次 A）+ 组织目录（部门/分组）
  const [orgTab, setOrgTab] = useState<OrgTab>('accounts');
  const [departments, setDepartments] = useState<OrgDepartment[]>([]);
  const [groups, setGroups] = useState<OrgGroup[]>([]);
  const [deptName, setDeptName] = useState('');
  const [groupName, setGroupName] = useState('');
  // 分组多选编辑中的账号（行内 popover，单开）
  const [groupsEditorFor, setGroupsEditorFor] = useState<string | null>(null);

  // 添加账号对话框；失败保持弹窗开、文案走 toast
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addNickname, setAddNickname] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 改昵称对话框
  const [renameTarget, setRenameTarget] = useState<AdminUserListItem | null>(null);
  const [renameValue, setRenameValue] = useState('');

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

  const reloadDirectory = useCallback(async () => {
    const dir = await fetchOrgDirectory();
    setDepartments(dir.departments);
    setGroups(dir.groups);
  }, []);

  useEffect(() => {
    void api<MeShape>('/users/me').then(setMe).catch(() => undefined);
    void reloadDirectory().catch(() => undefined);
  }, [reloadDirectory]);
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
      await Promise.all([reload(), reloadDirectory()]);
      if (successMessage) showToast(successMessage);
    } catch (e) {
      showToast(msgOf(e));
    }
  }

  function openAdd(): void {
    setAddEmail('');
    setAddNickname('');
    setAddOpen(true);
  }

  async function submitAdd(): Promise<void> {
    // 邮箱预检走 shared emailSchema（trim+lowercase+格式，文案与 server 端单点一致）
    const parsedEmail = emailSchema.safeParse(addEmail);
    if (!parsedEmail.success) return showToast(parsedEmail.error.issues[0]?.message ?? '邮箱格式不正确，请检查后重试');
    const nickname = addNickname.trim();
    if (!nickname) return showToast('昵称不能为空，请填写后重试');
    setSubmitting(true);
    try {
      await createAdminUser({ email: parsedEmail.data, nickname });
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
      showToast('已添加，该成员尚未设密码，首次登录请走「忘记密码」设置');
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

  /** 部门挂靠（行内下拉即改；未设置=清空）。 */
  function changeDepartment(u: AdminUserListItem, departmentId: string): void {
    void act(
      () => updateAdminUser(u.id, { departmentId: departmentId === '' ? null : departmentId }),
      departmentId === '' ? '已移出部门' : '部门已更新',
    );
  }

  /** 分组挂靠（popover 多选，变更即存全量）。 */
  function toggleGroup(u: AdminUserListItem, groupId: string): void {
    const next = u.groupIds.includes(groupId) ? u.groupIds.filter((g) => g !== groupId) : [...u.groupIds, groupId];
    void act(() => updateAdminUser(u.id, { groupIds: next }));
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

  async function submitDept(): Promise<void> {
    const name = deptName.trim();
    if (!name) return showToast('部门名称不能为空');
    setDeptName('');
    await act(() => createOrgDepartment(name), '部门已创建');
  }

  async function submitGroup(): Promise<void> {
    const name = groupName.trim();
    if (!name) return showToast('分组名称不能为空');
    setGroupName('');
    await act(() => createOrgGroup(name), '分组已创建');
  }

  function removeDept(d: OrgDepartment): void {
    if (!window.confirm(`确定删除部门「${d.name}」吗？`)) return;
    void act(() => deleteOrgDepartment(d.id), '部门已删除');
  }

  function removeGroup(g: OrgGroup): void {
    if (!window.confirm(`确定删除分组「${g.name}」吗？`)) return;
    void act(() => deleteOrgGroup(g.id), '分组已删除');
  }

  const loading = users === null && !error;

  return (
    <WorkspaceShell activeNav={null}>
      <main className="ws-content admin-users-page" data-testid="admin-users-page">
        <div className="ws-section-head">
          <h2>组织管理</h2>
          {orgTab === 'accounts' && (
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
          )}
        </div>

        {/* 三页签（批次 A）：账号 / 部门 / 分组 */}
        <div className="org-tabs" data-testid="org-tabs" role="tablist">
          {ORG_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={orgTab === t.key}
              className={orgTab === t.key ? 'active' : ''}
              data-testid={`org-tab-${t.key}`}
              onClick={() => setOrgTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {error && <p className="error" data-testid="admin-users-error">{error}</p>}

        {orgTab === 'accounts' && (
          <>
            {loading && <p className="admin-users-hint" data-testid="admin-users-loading">加载中…</p>}
            {users !== null && users.length === 0 && (
              <p className="admin-users-hint" data-testid="admin-users-empty">暂无成员，点击「添加账号」创建</p>
            )}

            {users !== null && users.length > 0 && (
              <>
                <div className="admin-user-table" data-testid="admin-user-table">
                  <div className="admin-table-head">
                    <span>昵称</span>
                    <span>邮箱</span>
                    <span>所属部门</span>
                    <span>分组</span>
                    <span>角色</span>
                    <span>状态</span>
                    <span>文件数</span>
                    <span>操作</span>
                  </div>
                  {users.map((u) => {
                    const self = u.id === me?.id;
                    return (
                      <div key={u.id} className="admin-table-row" data-testid="admin-user-row" data-self={self || undefined}>
                        <span className="cell nickname">{u.nickname}</span>
                        <span className="cell" data-testid="user-email">
                          {u.email ?? '—'}
                        </span>
                        <span className="cell">
                          <select
                            className="dept-select"
                            data-testid="account-dept-select"
                            value={u.departmentId ?? ''}
                            aria-label={`设置 ${u.nickname} 的部门`}
                            onChange={(e) => changeDepartment(u, e.target.value)}
                          >
                            <option value="">未设置</option>
                            {departments.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name}
                              </option>
                            ))}
                          </select>
                        </span>
                        <span className="cell groups-cell">
                          {u.groupIds.map((gid) => {
                            const g = groups.find((x) => x.id === gid);
                            return g ? (
                              <span key={gid} className="group-tag" style={{ background: groupColor(gid) }}>
                                {g.name}
                              </span>
                            ) : null;
                          })}
                          <button
                            className="groups-edit-btn"
                            data-testid={`account-groups-btn-${u.id}`}
                            title="设置分组"
                            onClick={() => setGroupsEditorFor(groupsEditorFor === u.id ? null : u.id)}
                          >
                            {u.groupIds.length === 0 ? '+ 分组' : '编辑'}
                          </button>
                          {groupsEditorFor === u.id && (
                            <>
                              <div className="popover-mask" onClick={() => setGroupsEditorFor(null)} />
                              <div className="groups-popover" data-testid={`groups-popover-${u.id}`}>
                                {groups.length === 0 && <p className="groups-empty">暂无分组，请在「分组管理」页签创建</p>}
                                {groups.map((g) => (
                                  <label key={g.id} className="groups-popover-item">
                                    <input
                                      type="checkbox"
                                      checked={u.groupIds.includes(g.id)}
                                      onChange={() => toggleGroup(u, g.id)}
                                    />
                                    <span className="group-tag" style={{ background: groupColor(g.id) }}>
                                      {g.name}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            </>
                          )}
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
                {/* 分页器：页码钳制在 [1, 总页数]；搜索中同样分页 */}
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
          </>
        )}

        {orgTab === 'departments' && (
          <div className="org-manage" data-testid="org-departments-panel">
            <div className="org-manage-add">
              <input
                data-testid="dept-name-input"
                placeholder="部门名称（1~32 字）"
                maxLength={32}
                value={deptName}
                onChange={(e) => setDeptName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitDept();
                }}
              />
              <button className="primary ws-head-action" data-testid="dept-add-btn" onClick={() => void submitDept()}>
                + 新增部门
              </button>
            </div>
            {departments.length === 0 && <p className="admin-users-hint" data-testid="dept-empty">暂无部门，先新增一个吧</p>}
            <div className="org-manage-list">
              {departments.map((d) => (
                <div key={d.id} className="org-manage-row" data-testid="dept-item">
                  <span className="org-manage-name">{d.name}</span>
                  <button className="danger" data-testid={`dept-delete-${d.id}`} onClick={() => removeDept(d)}>
                    删除
                  </button>
                </div>
              ))}
              {/* 未分配部门汇总行（2026-10-25 原型）：部门列表末行固定列出无挂靠账号，
                  仅存在未分配成员时渲染；挂靠走账号页签的行内部门下拉。 */}
              {(users ?? []).some((u) => !u.departmentId) && (
                <div className="org-manage-row org-manage-unassigned" data-testid="dept-unassigned-row">
                  <span className="org-manage-name">未分配部门</span>
                  <span className="org-manage-members" data-testid="dept-unassigned-names">
                    {(users ?? [])
                      .filter((u) => !u.departmentId)
                      .map((u) => u.nickname)
                      .join('、')}
                  </span>
                  <span className="org-manage-count">
                    {(users ?? []).filter((u) => !u.departmentId).length} 人
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {orgTab === 'groups' && (
          <div className="org-manage" data-testid="org-groups-panel">
            <div className="org-manage-add">
              <input
                data-testid="group-name-input"
                placeholder="分组名称（1~32 字）"
                maxLength={32}
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitGroup();
                }}
              />
              <button className="primary ws-head-action" data-testid="group-add-btn" onClick={() => void submitGroup()}>
                + 新增分组
              </button>
            </div>
            {groups.length === 0 && <p className="admin-users-hint" data-testid="group-empty">暂无分组，先新增一个吧</p>}
            <div className="org-manage-list">
              {groups.map((g) => (
                <div key={g.id} className="org-manage-row" data-testid="group-item">
                  <span className="group-tag" style={{ background: groupColor(g.id) }}>
                    {g.name}
                  </span>
                  <button className="danger" data-testid={`group-delete-${g.id}`} onClick={() => removeGroup(g)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>
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
                data-testid="add-user-email"
                placeholder="邮箱（登录身份标识）"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
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
