import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiPatch, apiPost, ApiError } from '../api/client';
import { Avatar, PRESET_AVATAR_COUNT } from '../editor/TaskFields';

/**
 * 账号设置页（M5 Task 1，FR-ACC-002 收口 + FR-CMT-006 通知偏好收口）：三区卡片。
 *
 * - 登录密码：按身份形态渲染（FR-ACC-002）——有密码（邮箱注册设置过）= 旧密码验证；
 *   无密码（手机号注册）= 验证码核身（开发环境固定 123456，与登录通道同语义）；
 *   强度 = 8~64 位（PRD 未定义强度规则，登记）。
 * - 换绑账号：channel + 新身份 + 验证码 → POST /api/users/me/rebind；被占 409 文案
 *   服务端透出（「该手机号/邮箱已绑定其他账号」）。
 * - 邮件通知偏好：开关即 PATCH（全量替换 emailOptOut）；FR-CMT-006「用户可在设置中
 *   按事件类型关闭邮件通知，站内通知不可关闭」；FR-FIL-010 回收站邮件提醒恒发
 *   不受开关控制（system 类型不在可关闭之列）。
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
}

const PREF_ITEMS: Array<{ key: EmailOptOutType; label: string; desc: string }> = [
  { key: 'mention', label: '提及', desc: '有人 @ 我时发邮件提醒' },
  { key: 'reply', label: '回复', desc: '有人回复我的评论时发邮件提醒' },
  { key: 'permission', label: '权限', desc: '文件协作权限变动时发邮件提醒' },
];

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

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const [channel, setChannel] = useState<'phone' | 'email'>('phone');
  const [newIdentity, setNewIdentity] = useState('');
  const [rebindCode, setRebindCode] = useState('');
  const [rebindError, setRebindError] = useState('');

  const [prefError, setPrefError] = useState('');
  const [error, setError] = useState('');

  // 成功动作轻提示（形态同 WorkspacePage/EditorPage toast）
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(message: string): void {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
    setToast(message);
  }

  const reload = useCallback(async () => {
    const [meData, prefs] = await Promise.all([api<MeIdentity>('/users/me'), api<NotifyPrefs>('/users/me/notify-prefs')]);
    setMe(meData);
    setOptOut(new Set(prefs.emailOptOut));
    // 换绑渠道缺省：空着的那一侧（手机号用户缺省换邮箱；都空（微信）缺省手机号）
    setChannel(meData.phone === null ? 'phone' : 'email');
  }, []);

  useEffect(() => {
    void reload().catch((e) => setError(msgOf(e)));
  }, [reload]);

  /** 改密：成功后 hasPassword 即为真——本地同步，密码区切到旧密码形态。 */
  async function changePassword(): Promise<void> {
    if (!me) return;
    setPasswordError('');
    try {
      if (me.hasPassword) {
        await apiPost('/users/me/password', { newPassword, currentPassword });
      } else {
        await apiPost('/users/me/password', { newPassword, code });
      }
      setMe({ ...me, hasPassword: true });
      setCurrentPassword('');
      setNewPassword('');
      setCode('');
      showToast('密码已修改，请牢记新密码');
    } catch (e) {
      setPasswordError(msgOf(e));
    }
  }

  /** 换绑：成功后回载身份（当前绑定展示随列更新）。 */
  async function rebind(): Promise<void> {
    setRebindError('');
    try {
      await apiPost('/users/me/rebind', { channel, newIdentity, code: rebindCode });
      setNewIdentity('');
      setRebindCode('');
      showToast(channel === 'phone' ? '换绑已完成，下次可使用新手机号登录' : '换绑已完成，下次可使用新邮箱登录');
      await reload();
    } catch (e) {
      // NFR-USE-005：被占 409（服务端「该手机号/邮箱已绑定其他账号」只给原因）补
      // 「换用其他手机号/邮箱」动作半；其余失败维持服务端 message 原样
      setRebindError(
        e instanceof ApiError && e.status === 409
          ? `${msgOf(e)}，请换用其他${channel === 'phone' ? '手机号' : '邮箱'}`
          : msgOf(e),
      );
    }
  }

  /** 开关即 PATCH（全量替换）：乐观更新，失败回滚并透出服务端原因文案。 */
  async function togglePref(key: EmailOptOutType, checked: boolean): Promise<void> {
    const prev = optOut;
    const next = new Set(prev);
    if (checked) next.add(key);
    else next.delete(key);
    setOptOut(next);
    setPrefError('');
    try {
      await apiPatch<NotifyPrefs>('/users/me/notify-prefs', { emailOptOut: [...next] });
      showToast('已完成'); // 成功提示不属失败文案，不强制两段式（NFR-USE-005 规范核对）
    } catch (e) {
      setOptOut(prev);
      setPrefError(msgOf(e));
    }
  }

  const currentBinding = me
    ? [me.phone ? `手机号 ${me.phone}` : null, me.email ? `邮箱 ${me.email}` : null].filter(Boolean).join('、') ||
      '微信账号'
    : '加载中…';

  return (
    <div className="settings-page" data-testid="settings-page">
      <header className="workspace-header">
        <h2>账号设置</h2>
        <div className="header-actions">
          <Link to="/workspace">返回工作台</Link>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      {/* 头像（2026-10-11 需求方裁定）：当前头像展示 + 5 预置 SVG 选择 + 本地上传。
          未自定义（avatarUrl null）时 Avatar 组件按 userId 稳定分配预置。 */}
      <section className="settings-card" data-testid="avatar-section">
        <h3>头像</h3>
        <div className="avatar-section-row">
          {me && (
            <span className="avatar-current" data-testid="avatar-current">
              <Avatar userId={me.id} nickname={me.nickname} avatar={me.avatarUrl} size={56} />
            </span>
          )}
          <div className="avatar-presets">
            {Array.from({ length: PRESET_AVATAR_COUNT }, (_, i) => `/avatars/preset-${i + 1}.svg`).map((url) => (
              <button
                key={url}
                type="button"
                className="avatar-preset-btn"
                data-testid={`avatar-preset-${url.match(/preset-(\d)/)?.[1]}`}
                aria-label={`选择预置头像 ${url}`}
                onClick={() => {
                  void (async () => {
                    try {
                      await apiPatch('/users/me/avatar', { avatarUrl: url });
                      await reload();
                      showToast('头像已更新');
                    } catch (e) {
                      showToast(msgOf(e));
                    }
                  })();
                }}
              >
                <img src={url} alt="" width={36} height={36} />
              </button>
            ))}
            <label className="avatar-upload-btn">
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
                      await reload();
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
      </section>

      <section className="settings-card" data-testid="password-section">
        <h3>登录密码</h3>
        <p className="settings-hint">
          {me?.hasPassword ? '修改密码需先验证当前密码' : '当前账号未设置密码，凭验证码即可设置（开发环境固定 123456）'}
        </p>
        {me?.hasPassword ? (
          <input
            type="password"
            data-testid="password-current"
            placeholder="当前密码"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        ) : (
          <input
            data-testid="password-code"
            placeholder="验证码（开发环境固定 123456）"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
        <input
          type="password"
          data-testid="password-new"
          placeholder="新密码（8~64 位）"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void changePassword();
          }}
        />
        {passwordError && <p className="error">{passwordError}</p>}
        <button className="primary" data-testid="settings-save" onClick={() => void changePassword()}>
          {me?.hasPassword ? '修改密码' : '设置密码'}
        </button>
      </section>

      <section className="settings-card" data-testid="rebind-section">
        <h3>换绑账号</h3>
        <p className="settings-hint">当前绑定：{currentBinding}</p>
        <select data-testid="rebind-channel" value={channel} onChange={(e) => setChannel(e.target.value as 'phone' | 'email')}>
          <option value="phone">手机号</option>
          <option value="email">邮箱</option>
        </select>
        <input
          data-testid="rebind-identity"
          placeholder={channel === 'phone' ? '新手机号' : '新邮箱'}
          value={newIdentity}
          onChange={(e) => setNewIdentity(e.target.value)}
        />
        <input
          data-testid="rebind-code"
          placeholder="验证码（开发环境固定 123456）"
          value={rebindCode}
          onChange={(e) => setRebindCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void rebind();
          }}
        />
        {rebindError && <p className="error">{rebindError}</p>}
        <button className="primary" data-testid="rebind-save" onClick={() => void rebind()}>
          提交换绑
        </button>
      </section>

      <section className="settings-card" data-testid="notify-section">
        <h3>邮件通知偏好</h3>
        <p className="settings-hint">
          关闭后对应事件不再发送邮件摘要（站内通知不受影响，不可关闭）；回收站清理提醒恒发，不在本设置范围。
        </p>
        {PREF_ITEMS.map((item) => (
          <label className="pref-row" key={item.key}>
            <span className="pref-text">
              <span className="pref-label">{item.label}</span>
              <span className="pref-desc">{item.desc}</span>
            </span>
            <input
              type="checkbox"
              data-testid={`notify-pref-${item.key}`}
              checked={optOut.has(item.key)}
              onChange={(e) => void togglePref(item.key, e.target.checked)}
            />
          </label>
        ))}
        {prefError && <p className="error">{prefError}</p>}
      </section>

      {toast && (
        <div className="workspace-toast" data-testid="toast" role="alert">
          {toast}
        </div>
      )}
    </div>
  );
}
