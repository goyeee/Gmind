import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiPatch, apiPost } from '../api/client';
import { codeSchema, emailSchema, NICKNAME_LENGTH_MESSAGE, PASSWORD_LENGTH_MESSAGE } from '@gmind/shared';
import { Avatar, PRESET_AVATAR_COUNT } from '../editor/TaskFields';
import { clearMeCache } from '../editor/collab';
import { WorkspaceShell } from './WorkspaceShell';
import { useCodeCountdown } from './useCodeCountdown';
import { Lucide } from '../components/lucide-data';

/**
 * 账号设置页（M5 Task 1 三区 → 2026-11-12 账号体系重做邮箱化）：六卡。
 * 2026-10-21 收进 WorkspaceShell 外壳（用户菜单页，侧栏无高亮项），样式对齐工作台重设计。
 *
 * - 账号资料（2026-11-12 新增）：昵称行内编辑 → PATCH /api/users/me（自助改昵称）。
 * - 登录密码（2026-11-12 重做）：恒「当前密码+新密码」核身（强度 6~64，文案单点
 *   PASSWORD_LENGTH_MESSAGE）；无密码账号（管理员建号形态）hasPassword=false →
 *   引导文案+禁用表单（登录页「忘记密码」是唯一设密通道）。
 * - 换绑账号（2026-11-12 重做，/users/me/rebind 已拆两端点）：邮箱区=新邮箱+
 *   email_bind 验证码+当前密码 → POST /users/me/email；手机号区=新手机号+当前密码
 *   （无验证码，短信未就绪）→ POST /users/me/phone；被占 409 服务端文案两段式
 *   原文透出。
 * - 绑定微信（2026-11-12 占位）：扫码登录/绑定未开通，点击 toast 说明。
 * - 头像 / 通知偏好：原样（FR-CMT-006；FR-FIL-010 回收站提醒恒发）。
 */

/** 身份形态（GET /api/users/me，UserGuard 装配 phone/email/hasPassword/avatarUrl）。 */
interface MeIdentity {
  id: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  hasPassword: boolean;
  /** 头像（2026-10-11）：null=未自定义（前端按 userId 稳定分配预置 SVG）。 */
  avatarUrl: string | null;
}

type EmailOptOutType = 'mention' | 'reply' | 'permission';

interface NotifyPrefs {
  emailOptOut: EmailOptOutType[];
  /** 站内通知总开关（2026-10-28 P1）：false=不生成站内通知。 */
  notifyEnabled?: boolean;
  /** 邮件摘要开关（2026-10-28 P1）：false=不发每日未读摘要。 */
  digestEnabled?: boolean;
}

const PREF_ITEMS: Array<{ key: EmailOptOutType; label: string; desc: string; icon: string }> = [
  { key: 'mention', label: '提及', desc: '有人 @ 我时发邮件提醒', icon: 'AtSign' },
  { key: 'reply', label: '回复', desc: '有人回复我的评论时发邮件提醒', icon: 'Reply' },
  { key: 'permission', label: '权限', desc: '文件协作权限变动时发邮件提醒', icon: 'ShieldCheck' },
];

/** 当前绑定手机号掩码（2026-11-18 原型对齐）：138 **** 1234 形态；未绑定原样返回。 */
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '未绑定';
  return `${phone.slice(0, 3)} **** ${phone.slice(7)}`;
}

/** 改密/换绑/改昵称的客户端预检（2026-11-12）：文案与 server 端单点同源（shared 导出
 *  常量与 schema）；邮箱与验证码直接复用 shared schema 对象 safeParse（zod 不进 web
 *  依赖），密码长度/昵称长度/手机号格式为轻量手写，格式错误提交前即拦截。 */

/** shared schema safeParse 的首个 issue message（文案在 shared 单点维护）。 */
function checkSchema(result: { success: true } | { success: false; error: { issues: Array<{ message: string }> } }): string | null {
  return result.success ? null : result.error.issues[0]?.message ?? '输入有误，请检查后重试';
}

/** 手机号口径与 server rebindPhoneSchema 同源（/^1\d{10}$/；文案与 server 端一致，
 *  shared 未导出 phone schema，本地留一份同源拷贝——Task 3 minor ④ 的已知取舍）。 */
const PHONE_RE = /^1\d{10}$/;
const PHONE_FORMAT_MESSAGE = '手机号格式不正确，请检查后重试';

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作未完成：网络异常或服务暂不可用，请稍后重试';
}

/** 头像上传（2026-10-11）：multipart 原生 fetch（api client 只发 JSON）；成功后服务端
 *  已直接定为当前头像，返回 avatarUrl 供本地同步。 */
async function uploadAvatar(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const token = localStorage.getItem('gmind.token');
  const res = await fetch('/api/users/me/avatar', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token ?? ''}` },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { avatarUrl?: string; message?: string };
  if (!res.ok || !data.avatarUrl) {
    throw new Error(data.message ?? '头像上传失败，请调整后重试');
  }
  return data.avatarUrl;
}

export function SettingsPage() {
  const [me, setMe] = useState<MeIdentity | null>(null);
  const [optOut, setOptOut] = useState<ReadonlySet<EmailOptOutType>>(new Set());
  // 总开关（2026-10-28 P1）：缺省 true；PATCH 全量替换语义——任何一次写都须带全两键
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [digestEnabled, setDigestEnabled] = useState(true);

  // 登录密码卡：恒「当前密码+新密码」（hasPassword=false 时整体禁用）
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // 换绑卡·邮箱区：新邮箱 + email_bind 验证码 + 当前密码
  const [newEmail, setNewEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const emailCountdown = useCodeCountdown();

  // 换绑卡·手机号区：新手机号 + 当前密码（无验证码，短信未就绪）
  const [newPhone, setNewPhone] = useState('');
  const [phonePassword, setPhonePassword] = useState('');
  const [phoneError, setPhoneError] = useState('');

  // 账号资料卡：昵称行内编辑
  const [nicknameEditing, setNicknameEditing] = useState(false);
  const [nicknameValue, setNicknameValue] = useState('');
  const [profileError, setProfileError] = useState('');

  const [prefError, setPrefError] = useState('');
  const [error, setError] = useState('');
  // 偏好写入版本号（2026-11-18 装载竞态修复，全量 e2e 实证）：用户每次点开关 +1。
  // reload 发起时记录版本，响应落地时若版本已变（期间用户动过开关），偏好三态
  // 不再覆盖——否则迟到的初始 GET 旧值会把用户刚做的选择「回冲」掉。
  const prefsVersionRef = useRef(0);

  // 成功动作轻提示（形态同 WorkspacePage/EditorPage toast）
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(message: string): void {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
    setToast(message);
  }

  const reload = useCallback(async () => {
    const versionAtStart = prefsVersionRef.current;
    const [meData, prefs] = await Promise.all([api<MeIdentity>('/users/me'), api<NotifyPrefs>('/users/me/notify-prefs')]);
    setMe(meData);
    // 发起后用户动过开关 → 这份响应的偏好已是旧值，跳过（me 身份数据照常应用）
    if (versionAtStart !== prefsVersionRef.current) return;
    setOptOut(new Set(prefs.emailOptOut));
    setNotifyEnabled(prefs.notifyEnabled !== false);
    setDigestEnabled(prefs.digestEnabled !== false);
  }, []);

  useEffect(() => {
    void reload().catch((e) => setError(msgOf(e)));
  }, [reload]);

  // 账号资料卡·部门/分组只读行（2026-11-18 原型对齐，需求方拍板新增）：
  // 数据源 GET /org/directory（EditorPage 筛选同款端点），取本人 membership 映射名称；
  // 未分配/接口失败均显示「无」，纯展示不可编辑。
  const [orgInfo, setOrgInfo] = useState<{ dept: string; groups: string }>({ dept: '无', groups: '无' });
  useEffect(() => {
    if (!me) return;
    let alive = true;
    void api<{
      departments: Array<{ id: string; name: string }>;
      groups: Array<{ id: string; name: string }>;
      memberships: Array<{ userId: string; departmentId: string | null; groupIds: string[] }>;
    }>('/org/directory')
      .then((dir) => {
        if (!alive) return;
        const m = dir.memberships.find((x) => x.userId === me.id);
        const dept = dir.departments.find((d) => d.id === m?.departmentId)?.name ?? '无';
        const groups = (m?.groupIds ?? [])
          .map((gid) => dir.groups.find((g) => g.id === gid)?.name)
          .filter((n): n is string => typeof n === 'string')
          .join('、');
        setOrgInfo({ dept, groups: groups === '' ? '无' : groups });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [me]);

  /** 改密：预检 → 当前密码核身；成功后 hasPassword 即为真——本地同步。 */
  async function changePassword(): Promise<void> {
    if (!me) return;
    setPasswordError('');
    if (!currentPassword) return setPasswordError('请输入当前密码');
    if (newPassword.length < 6 || newPassword.length > 64) return setPasswordError(PASSWORD_LENGTH_MESSAGE);
    try {
      await apiPost('/users/me/password', { currentPassword, newPassword });
      setMe({ ...me, hasPassword: true });
      setCurrentPassword('');
      setNewPassword('');
      showToast('密码已修改，请牢记新密码');
    } catch (e) {
      setPasswordError(msgOf(e));
    }
  }

  /** 换绑邮箱：email_bind 验证码 + 当前密码核身 → POST /users/me/email；
   *  被占 409 服务端两段式文案原文透出（「该邮箱已绑定其他账号，请换用其他邮箱」）。 */
  async function rebindEmail(): Promise<void> {
    setEmailError('');
    const emailProblem = checkSchema(emailSchema.safeParse(newEmail));
    if (emailProblem) return setEmailError(emailProblem);
    const codeProblem = checkSchema(codeSchema.safeParse(emailCode));
    if (codeProblem) return setEmailError(codeProblem);
    if (!emailPassword) return setEmailError('请输入当前密码');
    try {
      await apiPost('/users/me/email', { email: newEmail, code: emailCode, currentPassword: emailPassword });
      setNewEmail('');
      setEmailCode('');
      setEmailPassword('');
      showToast('邮箱已换绑，请使用新邮箱登录');
      await reload();
    } catch (e) {
      setEmailError(msgOf(e));
    }
  }

  /** 换绑手机号：仅当前密码核身（无验证码，短信未就绪）→ POST /users/me/phone。 */
  async function rebindPhone(): Promise<void> {
    setPhoneError('');
    if (!PHONE_RE.test(newPhone)) return setPhoneError(PHONE_FORMAT_MESSAGE);
    if (!phonePassword) return setPhoneError('请输入当前密码');
    try {
      await apiPost('/users/me/phone', { phone: newPhone, currentPassword: phonePassword });
      setNewPhone('');
      setPhonePassword('');
      showToast('手机号已更新');
      await reload();
    } catch (e) {
      setPhoneError(msgOf(e));
    }
  }

  /** 换绑邮箱发码（scene=email_bind）：邮箱先过 shared emailSchema 归一+格式预检，
   *  成功才起 60s 倒计时（失败可直接重试）。 */
  async function sendRebindCode(): Promise<void> {
    setEmailError('');
    const parsed = emailSchema.safeParse(newEmail);
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message ?? '邮箱格式不正确，请检查后重新输入');
      return;
    }
    try {
      await apiPost('/auth/email-code', { scene: 'email_bind', email: parsed.data });
      emailCountdown.start();
    } catch (e) {
      setEmailError(msgOf(e));
    }
  }

  /** 昵称行内编辑保存：预检 → PATCH /users/me（返回设置后的账号视图，一次刷新）。 */
  async function saveNickname(): Promise<void> {
    setProfileError('');
    const nickname = nicknameValue.trim();
    if (nickname.length < 1 || nickname.length > 32) return setProfileError(NICKNAME_LENGTH_MESSAGE);
    try {
      const user = await apiPatch<MeIdentity>('/users/me', { nickname });
      setMe(user);
      setNicknameEditing(false);
      showToast('昵称已更新');
    } catch (e) {
      setProfileError(msgOf(e));
    }
  }

  /** 开关即 PATCH（全量替换）：乐观更新，失败回滚并透出服务端原因文案。
   *  全量替换语义——emailOptOut 与两总开关必须同包提交（2026-10-28 P1）。 */
  async function togglePref(key: EmailOptOutType, checked: boolean): Promise<void> {
    prefsVersionRef.current += 1;
    const prev = optOut;
    const next = new Set(prev);
    if (checked) next.add(key);
    else next.delete(key);
    setOptOut(next);
    setPrefError('');
    try {
      await apiPatch<NotifyPrefs>('/users/me/notify-prefs', {
        emailOptOut: [...next],
        notifyEnabled,
        digestEnabled,
      });
      showToast('已完成'); // 成功提示不属失败文案，不强制两段式（NFR-USE-005 规范核对）
    } catch (e) {
      setOptOut(prev);
      setPrefError(msgOf(e));
    }
  }

  /** 总开关切换（2026-10-28 P1）：notifyEnabled=站内通知；digestEnabled=邮件摘要。 */
  async function toggleMaster(key: 'notifyEnabled' | 'digestEnabled', checked: boolean): Promise<void> {
    prefsVersionRef.current += 1;
    const prevN = notifyEnabled;
    const prevD = digestEnabled;
    if (key === 'notifyEnabled') setNotifyEnabled(checked);
    else setDigestEnabled(checked);
    setPrefError('');
    try {
      await apiPatch<NotifyPrefs>('/users/me/notify-prefs', {
        emailOptOut: [...optOut],
        notifyEnabled: key === 'notifyEnabled' ? checked : prevN,
        digestEnabled: key === 'digestEnabled' ? checked : prevD,
      });
      showToast('已完成');
    } catch (e) {
      setNotifyEnabled(prevN);
      setDigestEnabled(prevD);
      setPrefError(msgOf(e));
    }
  }

  // hasPassword 仅在 me 装载完成后放行表单（防装载竞态下误渲染/误提交）
  const passwordReady = me !== null && me.hasPassword;

  return (
    <WorkspaceShell activeNav={null}>
      <main className="ws-content settings-page" data-testid="settings-page">
        <div className="ws-section-head">
          <h2>设置</h2>
        </div>
        {error && <p className="error">{error}</p>}

      {/* 头像（2026-10-11 需求方裁定）：当前头像展示 + 5 预置 SVG 选择 + 本地上传。
          未自定义（avatarUrl null）时 Avatar 组件按 userId 稳定分配预置。 */}
      <section className="settings-card" data-testid="avatar-section">
        <h3>头像</h3>
        <div className="avatar-section-row">
          {me && (
            <span className="avatar-current" data-testid="avatar-current">
              <Avatar userId={me.id} nickname={me.nickname} avatar={me.avatarUrl} size={60} />
            </span>
          )}
          <div className="avatar-presets">
            {Array.from({ length: PRESET_AVATAR_COUNT }, (_, i) => `/avatars/preset-${i + 1}.svg`).map((url) => {
              const selected = me?.avatarUrl === url;
              return (
                <button
                  key={url}
                  type="button"
                  className={'avatar-preset-btn' + (selected ? ' active' : '')}
                  data-testid={`avatar-preset-${url.match(/preset-(\d)/)?.[1]}`}
                  aria-label={`选择预置头像 ${url}`}
                  aria-pressed={selected}
                  onClick={() => {
                    void (async () => {
                      try {
                        await apiPatch('/users/me/avatar', { avatarUrl: url });
                        clearMeCache();
                        await reload();
                        window.dispatchEvent(new Event('gmind:avatar-updated'));
                        showToast('头像已更新');
                      } catch (e) {
                        showToast(msgOf(e));
                      }
                    })();
                  }}
                >
                  <img src={url} alt="" width={40} height={40} />
                  {selected && (
                    <i className="avatar-preset-check" aria-hidden>
                      <Lucide name="Check" size={10} strokeWidth={3} />
                    </i>
                  )}
                </button>
              );
            })}
            <label className="avatar-upload-btn">
              <Lucide name="Upload" size={14} />
              上传头像
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                data-testid="avatar-upload-input"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void (async () => {
                    try {
                      await uploadAvatar(file);
                      clearMeCache();
                      await reload();
                      window.dispatchEvent(new Event('gmind:avatar-updated'));
                      showToast('头像已更新');
                    } catch (err) {
                      showToast(msgOf(err));
                    }
                  })();
                }}
              />
            </label>
          </div>
        </div>
        <p className="settings-hint">支持 JPG、PNG，2MB 以内；协作成员、评论与任务负责人处都会显示该头像</p>
      </section>

      {/* 账号资料（2026-11-12 新增）：昵称行内编辑 → PATCH /users/me */}
      <section className="settings-card" data-testid="profile-section">
        <h3>账号资料</h3>
        <div className="profile-row">
          <span className="settings-hint">昵称</span>
          {nicknameEditing ? (
            <>
              <input
                data-testid="profile-nickname-input"
                maxLength={32}
                value={nicknameValue}
                autoFocus
                onChange={(e) => setNicknameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveNickname();
                  if (e.key === 'Escape') setNicknameEditing(false);
                }}
              />
              <button data-testid="profile-nickname-save" onClick={() => void saveNickname()}>
                保存
              </button>
              <button data-testid="profile-nickname-cancel" onClick={() => setNicknameEditing(false)}>
                取消
              </button>
            </>
          ) : (
            <>
              <span className="profile-value" data-testid="profile-nickname">
                {me?.nickname ?? '加载中…'}
              </span>
              <button
                data-testid="profile-nickname-edit"
                onClick={() => {
                  setNicknameValue(me?.nickname ?? '');
                  setNicknameEditing(true);
                }}
              >
                修改
              </button>
            </>
          )}
        </div>
        {profileError && <p className="error">{profileError}</p>}
        {/* 部门/分组只读行（2026-11-18 原型对齐）：组织目录接口取本人归属，不可编辑 */}
        <div className="profile-org">
          <span className="profile-org-row" data-testid="profile-dept">
            <span className="profile-org-label">部门</span>
            <span className="profile-org-value">{orgInfo.dept}</span>
          </span>
          <span className="profile-org-row" data-testid="profile-groups">
            <span className="profile-org-label">分组</span>
            <span className="profile-org-value">{orgInfo.groups}</span>
          </span>
        </div>
        <p className="settings-hint">部门与分组由管理员在"组织管理"中调整</p>
      </section>

      {/* 登录密码（2026-11-12 重做）：恒密码核身；无密码账号引导走登录页「忘记密码」 */}
      <section className="settings-card" data-testid="password-section">
        <h3>登录密码</h3>
        {me !== null && !me.hasPassword && (
          <p className="settings-hint" data-testid="password-guide">
            尚未设置密码，请通过登录页"忘记密码"用邮箱验证码设置
          </p>
        )}
        {me?.hasPassword && <p className="settings-hint">修改密码需先验证当前密码</p>}
        <input
          type="password"
          data-testid="password-current"
          placeholder="当前密码"
          value={currentPassword}
          disabled={!passwordReady}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <input
          type="password"
          data-testid="password-new"
          placeholder="新密码（6~64 位）"
          value={newPassword}
          disabled={!passwordReady}
          onChange={(e) => setNewPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && passwordReady) void changePassword();
          }}
        />
        {passwordError && <p className="error">{passwordError}</p>}
        <button className="primary" data-testid="settings-save" disabled={!passwordReady} onClick={() => void changePassword()}>
          修改密码
        </button>
      </section>

      {/* 换绑账号（2026-11-12 重做）：邮箱区=验证码+密码核身；手机号区=仅密码核身 */}
      <section className="settings-card" data-testid="rebind-section">
        <h3>换绑账号</h3>
        <div className="rebind-block" data-testid="rebind-email-block">
          <h4 className="settings-subhead">
            <Lucide name="Mail" size={15} className="settings-subhead-icon" />
            邮箱（登录身份）
          </h4>
          <p className="settings-hint">当前绑定：{me?.email ?? '未绑定'}</p>
          <input
            data-testid="rebind-email"
            placeholder="新邮箱"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <div className="code-row">
            <input
              data-testid="rebind-email-code"
              placeholder="邮箱验证码"
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
            />
            <button
              data-testid="rebind-email-code-send"
              disabled={emailCountdown.left > 0}
              onClick={() => void sendRebindCode()}
            >
              {emailCountdown.left > 0 ? `${emailCountdown.left}s 后重发` : '获取验证码'}
            </button>
          </div>
          <input
            type="password"
            data-testid="rebind-email-password"
            placeholder="当前密码"
            value={emailPassword}
            onChange={(e) => setEmailPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rebindEmail();
            }}
          />
          {emailError && <p className="error">{emailError}</p>}
          <button className="primary" data-testid="rebind-email-save" onClick={() => void rebindEmail()}>
            提交换绑
          </button>
        </div>
        <div className="rebind-block" data-testid="rebind-phone-block">
          <h4 className="settings-subhead">
            <Lucide name="Smartphone" size={15} className="settings-subhead-icon" />
            手机号<span className="settings-subhead-note">（协作标识，暂不可用于登录）</span>
          </h4>
          <p className="settings-hint">
            当前绑定：{maskPhone(me?.phone)}
            {me?.phone && (
              <span className="badge-unverified" data-testid="phone-unverified-badge">
                未验证
              </span>
            )}
          </p>
          <input
            data-testid="rebind-phone"
            placeholder="新手机号"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
          />
          <input
            type="password"
            data-testid="rebind-phone-password"
            placeholder="当前密码"
            value={phonePassword}
            onChange={(e) => setPhonePassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rebindPhone();
            }}
          />
          {phoneError && <p className="error">{phoneError}</p>}
          <button className="primary" data-testid="rebind-phone-save" onClick={() => void rebindPhone()}>
            提交
          </button>
        </div>
      </section>

      {/* 绑定微信（2026-11-12 占位）：登录通道已随重做移除，绑定能力待开通 */}
      <section className="settings-card" data-testid="wechat-section">
        <h3>绑定微信</h3>
        <p className="settings-hint">绑定后可使用微信扫码登录（暂未开通）</p>
        <button className="primary settings-btn-icon" data-testid="wechat-bind-btn" onClick={() => showToast('微信绑定暂未开通，敬请期待')}>
          <Lucide name="MessageCircle" size={15} />
          绑定微信
        </button>
      </section>

      <section className="settings-card" data-testid="notify-section">
        <h3>通知偏好</h3>
        {/* 总开关（2026-10-28 P1）：站内通知与邮件摘要各自独立 */}
        <label className="pref-row">
          <span className="pref-text">
            <span className="pref-label">站内通知</span>
            <span className="pref-desc">关闭后不再生成新的站内通知（历史通知保留）</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={notifyEnabled}
            aria-label="站内通知"
            className="pref-switch"
            data-testid="notify-master-enabled"
            onClick={() => void toggleMaster('notifyEnabled', !notifyEnabled)}
          >
            <i aria-hidden />
          </button>
        </label>
        <label className="pref-row">
          <span className="pref-text">
            <span className="pref-label">邮件摘要</span>
            <span className="pref-desc">每日未读通知汇总邮件；关闭后不再发送</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={digestEnabled}
            aria-label="邮件摘要"
            className="pref-switch"
            data-testid="notify-master-digest"
            onClick={() => void toggleMaster('digestEnabled', !digestEnabled)}
          >
            <i aria-hidden />
          </button>
        </label>
        {/* 按事件类型区（2026-11-18 原型对齐）：灰底圆角容器 + 图标行；
            邮件摘要总开关关闭后说明文案切换为「暂不生效」口径，细项禁用 */}
        <div className={'pref-subgroup' + (digestEnabled ? '' : ' pref-subgroup-disabled')} data-testid="notify-pref-group">
          <h4 className="settings-subhead">按事件类型关闭邮件摘要</h4>
          <p className="settings-hint">
            {digestEnabled
              ? '关闭后对应事件不再发送邮件摘要；回收站清理提醒恒发，不在本设置范围。'
              : '邮件摘要已整体关闭，以下选项暂不生效。'}
          </p>
          {PREF_ITEMS.map((item) => (
            <label className="pref-row" key={item.key}>
              <span className="pref-icon" aria-hidden>
                <Lucide name={item.icon} size={16} />
              </span>
              <span className="pref-text">
                <span className="pref-label">{item.label}</span>
                <span className="pref-desc">{item.desc}</span>
              </span>
              <button
                type="button"
                role="switch"
                // 2026-11-18 需求方拍板跟原型反转：蓝=接收该类型邮件提醒（默认全蓝），
                // 点灭=关闭提醒。optOut 语义不变（存服务端 emailOptOut），仅显示反转。
                aria-checked={!optOut.has(item.key)}
                aria-label={item.label}
                className="pref-switch"
                data-testid={`notify-pref-${item.key}`}
                disabled={!digestEnabled}
                onClick={() => void togglePref(item.key, !optOut.has(item.key))}
              >
                <i aria-hidden />
              </button>
            </label>
          ))}
        </div>
        {prefError && <p className="error">{prefError}</p>}
      </section>

      {toast && (
        <div className="workspace-toast" data-testid="toast" role="alert">
          {toast}
        </div>
      )}
      </main>
    </WorkspaceShell>
  );
}
