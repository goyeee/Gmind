import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, setToken } from '../api/client';
import {
  emailSchema,
  loginSchema,
  passwordResetSchema,
  registerSchema,
  type LoginResponse,
} from '@gmind/shared';
import { useCodeCountdown } from './useCodeCountdown';
import { InfiniteMap } from './InfiniteMap';

/**
 * 登录页三视图（2026-11-12 账号体系重做，spec §4.4）：`login|register|forgot` 状态机，
 * 旧「手机号/邮箱/微信」三 tab 已随三 Provider 删除。
 * - login：邮箱+密码+记住我（rememberMe=true 服务端签发 30 天会话，否则 7 天）；
 *   失败文案=服务端两段式 message 原文透出（NFR-USE-005）。
 * - register：邮箱验证码注册（注册即登录，赠 3 个示例文件）——发码 scene=register，
 *   60s 倒计时禁用（服务端重发冷却同源）；提交前 shared schema parse（归一+文案单点）。
 * - forgot：邮箱验证码重置密码（scene=password_reset）→ 204 后回 login 视图并提示
 *   「密码已重置，请使用新密码登录」。
 * 所有交互元素带语义 testid（login-* / reg-* / forgot-* / link-*）。
 */

type View = 'login' | 'register' | 'forgot';

type LoginIconName = 'share' | 'infinity' | 'users' | 'maximize' | 'network';

/** 登录页专用装饰图标，路径与原型使用的 Lucide 图标一致，无需引入新依赖。 */
function LoginIcon({ name, className }: { name: LoginIconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {name === 'share' && (
        <>
          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
          <path d="m8.59 13.51 6.83 3.98m-.01-10.98-6.82 3.98" />
        </>
      )}
      {name === 'infinity' && <path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z" />}
      {name === 'users' && (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      )}
      {name === 'maximize' && <path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3" />}
      {name === 'network' && (
        <>
          <rect x="16" y="16" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" />
          <rect x="9" y="2" width="6" height="6" rx="1" /><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" />
        </>
      )}
    </svg>
  );
}

/** 登录成功后的落点（M3b Task 4，FR-SHR-001）：缺省 /workspace；分享落地页经
 *  /login?redirect=/s/:token 回跳。仅接受站内路径（以单个 / 开头，拒绝 // 与
 *  外部 URL），防开放重定向。 */
function safeRedirect(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/workspace';
}

/** shared schema safeParse 的首个 issue message（文案在 shared 单点维护）。 */
function firstIssue(e: { issues: Array<{ message: string }> }): string {
  return e.issues[0]?.message ?? '输入有误，请检查后重试';
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = safeRedirect(searchParams.get('redirect'));
  const [view, setView] = useState<View>('login');
  const [error, setError] = useState('');
  // 重置成功提示（回 login 视图后展示，两段式口径：结果 + 下一步）
  const [notice, setNotice] = useState('');

  // login 视图
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  // register 视图
  const [regEmail, setRegEmail] = useState('');
  const [regCode, setRegCode] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regNickname, setRegNickname] = useState('');
  const regCountdown = useCodeCountdown();

  // forgot 视图
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotPassword, setForgotPassword] = useState('');
  const forgotCountdown = useCodeCountdown();

  function switchView(next: View): void {
    setView(next);
    setError('');
    setNotice('');
  }

  /** 发码（注册/忘记密码共用）：先经 shared emailSchema 归一+格式校验（文案单点），
   *  失败原因（已注册 409 / 未注册 404 / 过频 429）透出服务端原文。 */
  async function sendCode(
    scene: 'register' | 'password_reset',
    email: string,
    startCountdown: () => void,
  ): Promise<void> {
    setError('');
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    try {
      await api('/auth/email-code', { method: 'POST', body: { scene, email: parsed.data } });
      startCountdown(); // 成功才起倒计时（失败可直接重发）
    } catch (e) {
      setError(e instanceof Error ? e.message : '验证码发送失败，请稍后重试');
    }
  }

  /** 登录：parse 归一后 POST /auth/login；成功 setToken + navigate(safeRedirect)。 */
  async function doLogin(): Promise<void> {
    setError('');
    const parsed = loginSchema.safeParse({ account, password, rememberMe: remember || undefined });
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    try {
      const res = await api<LoginResponse>('/auth/login', { method: 'POST', body: parsed.data });
      setToken(res.token);
      navigate(redirect);
    } catch (e) {
      // 401（账号不存在/密码错误/停用）服务端两段式文案原文透出；此时无 token，
      // api() 的「登录过期」改写分支不会命中
      setError(e instanceof Error ? e.message : '登录失败，请稍后重试');
    }
  }

  /** 注册（注册即登录）：parse 归一后 POST /auth/register → setToken + navigate。 */
  async function doRegister(): Promise<void> {
    setError('');
    const parsed = registerSchema.safeParse({
      email: regEmail,
      code: regCode,
      password: regPassword,
      nickname: regNickname.trim(),
    });
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    try {
      const res = await api<LoginResponse>('/auth/register', { method: 'POST', body: parsed.data });
      setToken(res.token);
      navigate(redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : '注册失败，请稍后重试');
    }
  }

  /** 忘记密码重置：parse 归一后 POST /auth/password-reset → 204 回 login 视图，
   *  带结果提示；邮箱回填登录框省一次输入。 */
  async function doReset(): Promise<void> {
    setError('');
    const parsed = passwordResetSchema.safeParse({
      email: forgotEmail,
      code: forgotCode,
      newPassword: forgotPassword,
    });
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    try {
      await api('/auth/password-reset', { method: 'POST', body: parsed.data });
      setAccount(parsed.data.email);
      setPassword('');
      switchView('login');
      setNotice('密码已重置，请使用新密码登录');
    } catch (e) {
      setError(e instanceof Error ? e.message : '重置失败，请稍后重试');
    }
  }

  const codeButtonLabel = (left: number): string => (left > 0 ? `${left}s 后重发` : '获取验证码');

  return (
    <div className="login-split">
      {/* 左侧 hero（品牌宣传层，≤900px 隐藏）：装饰节点/连线为纯 CSS/SVG，无业务语义 */}
      <div className="login-hero" aria-hidden={false}>
        <div className="login-hero-logo">
          <span className="login-logo-mark"><LoginIcon name="share" /></span> Gmind
        </div>
        <div className="login-hero-art" aria-hidden>
          <InfiniteMap />
        </div>
        <h1 className="login-hero-title">
          让想法自由生长，<em>连接成图</em>
        </h1>
        <p className="login-hero-desc">
          节点无限延展，不设上限。Gmind 是在线思维导图与协作画布，把会议纪要、灵感与计划，整理成清晰的结构。
        </p>
        <div className="login-hero-feats">
          {([
            ['infinity', '无限节点'],
            ['users', '实时协作'],
            ['maximize', '无限画布'],
            ['network', '多结构切换'],
          ] as const).map(([icon, label]) => (
            <span key={label}><LoginIcon name={icon} className="login-feature-icon" />{label}</span>
          ))}
        </div>
        <p className="login-hero-copy">© 2025 Gmind Team</p>
      </div>

      {/* 右侧表单：三视图状态机（login/register/forgot） */}
      <div className="login-panel">
        <div className="login-page">
          <h1>Gmind</h1>
          {view === 'login' && (
            <div data-testid="login-view">
              <p className="subtitle">登录 Gmind，继续你的思维之旅</p>
              {notice && (
                <p className="login-notice" data-testid="login-notice" role="status">
                  {notice}
                </p>
              )}
              <div className="form">
                <input
                  data-testid="login-account"
                  placeholder="邮箱"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                />
                <input
                  data-testid="login-password"
                  type="password"
                  placeholder="密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doLogin();
                  }}
                />
                <label className="login-remember">
                  <input
                    type="checkbox"
                    data-testid="login-remember"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  记住我（30 天内免登录）
                </label>
                <button data-testid="login-submit" onClick={() => void doLogin()}>
                  登录
                </button>
                <div className="login-links">
                  <button data-testid="link-register" onClick={() => switchView('register')}>
                    注册新账号
                  </button>
                  <button data-testid="link-forgot" onClick={() => switchView('forgot')}>
                    忘记密码？
                  </button>
                </div>
              </div>
            </div>
          )}

          {view === 'register' && (
            <div data-testid="register-view">
              <p className="subtitle">注册 Gmind 账号，用邮箱验证码即可</p>
              <div className="form">
                <input
                  data-testid="reg-email"
                  placeholder="邮箱"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                />
                <div className="code-row">
                  <input
                    data-testid="reg-code"
                    placeholder="邮箱验证码"
                    value={regCode}
                    onChange={(e) => setRegCode(e.target.value)}
                  />
                  <button
                    data-testid="reg-code-send"
                    disabled={regCountdown.left > 0}
                    onClick={() => void sendCode('register', regEmail, () => regCountdown.start())}
                  >
                    {codeButtonLabel(regCountdown.left)}
                  </button>
                </div>
                <input
                  data-testid="reg-password"
                  type="password"
                  placeholder="设置密码（6~64 位）"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                />
                <input
                  data-testid="reg-nickname"
                  placeholder="昵称（1~32 个字符）"
                  maxLength={32}
                  value={regNickname}
                  onChange={(e) => setRegNickname(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doRegister();
                  }}
                />
                <button data-testid="reg-submit" onClick={() => void doRegister()}>
                  注册并登录
                </button>
                <div className="login-links">
                  <button data-testid="link-login" onClick={() => switchView('login')}>
                    已有账号？返回登录
                  </button>
                </div>
              </div>
            </div>
          )}

          {view === 'forgot' && (
            <div data-testid="forgot-view">
              <p className="subtitle">输入注册邮箱，用验证码重置密码</p>
              <div className="form">
                <input
                  data-testid="forgot-email"
                  placeholder="注册邮箱"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                />
                <div className="code-row">
                  <input
                    data-testid="forgot-code"
                    placeholder="邮箱验证码"
                    value={forgotCode}
                    onChange={(e) => setForgotCode(e.target.value)}
                  />
                  <button
                    data-testid="forgot-code-send"
                    disabled={forgotCountdown.left > 0}
                    onClick={() =>
                      void sendCode('password_reset', forgotEmail, () => forgotCountdown.start())
                    }
                  >
                    {codeButtonLabel(forgotCountdown.left)}
                  </button>
                </div>
                <input
                  data-testid="forgot-password"
                  type="password"
                  placeholder="新密码（6~64 位）"
                  value={forgotPassword}
                  onChange={(e) => setForgotPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doReset();
                  }}
                />
                <button data-testid="forgot-submit" onClick={() => void doReset()}>
                  重置密码
                </button>
                <div className="login-links">
                  <button data-testid="link-login" onClick={() => switchView('login')}>
                    返回登录
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && <p className="error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
