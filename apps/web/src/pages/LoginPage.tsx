import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, setToken } from '../api/client';
import type { LoginResponse } from '@gmind/shared';

type Tab = 'phone' | 'email' | 'wechat';

/** 登录成功后的落点（M3b Task 4，FR-SHR-001）：缺省 /workspace；分享落地页经
 *  /login?redirect=/s/:token 回跳。仅接受站内路径（以单个 / 开头，拒绝 // 与
 *  外部 URL），防开放重定向。 */
function safeRedirect(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/workspace';
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = safeRedirect(searchParams.get('redirect'));
  const [tab, setTab] = useState<Tab>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [emailMode, setEmailMode] = useState<'code' | 'password'>('code');
  const [emailSecret, setEmailSecret] = useState('');
  const [error, setError] = useState('');

  async function doLogin(body: Record<string, unknown>) {
    setError('');
    try {
      const res = await api<LoginResponse>('/auth/login', { method: 'POST', body });
      setToken(res.token);
      navigate(redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    }
  }

  return (
    <div className="login-split">
      {/* 左侧 hero（品牌宣传层，≤900px 隐藏）：装饰节点/连线为纯 CSS/SVG，无业务语义 */}
      <div className="login-hero" aria-hidden={false}>
        <div className="login-hero-logo">
          <span className="login-logo-mark">G</span> Gmind
        </div>
        <div className="login-hero-art" aria-hidden>
          <svg className="hero-lines" viewBox="0 0 960 1200" preserveAspectRatio="xMidYMid slice">
            <path d="M480 470 C 420 380, 340 330, 250 300" />
            <path d="M480 470 C 560 360, 660 320, 740 300" />
            <path d="M480 470 C 430 560, 360 620, 300 660" />
            <path d="M480 470 C 540 580, 620 640, 690 680" />
          </svg>
          <span className="hero-node" style={{ left: '12%', top: '22%' }}>头脑风暴</span>
          <span className="hero-node" style={{ right: '14%', top: '22%' }}>灵感捕捉</span>
          <span className="hero-node" style={{ right: '32%', top: '54%' }}>实时协作</span>
          <span className="hero-node" style={{ right: '20%', bottom: '36%' }}>结构整理</span>
          <span className="hero-node hero-root">中心主题</span>
        </div>
        <h1 className="login-hero-title">
          让想法自由生长，
          <br />
          <em>连接成图</em>
        </h1>
        <p className="login-hero-desc">
          Gmind 是在线思维导图与协作画布，把会议纪要、灵感与计划，整理成清晰的结构。
        </p>
        <div className="login-hero-feats">
          <span>实时协作</span>
          <span>无限画布</span>
          <span>多结构切换</span>
        </div>
        <p className="login-hero-copy">© 2026 Gmind Team</p>
      </div>

      {/* 右侧表单：真实登录能力与文案全保留 */}
      <div className="login-panel">
        <div className="login-page">
          <h1>Gmind</h1>
          <p className="subtitle">登录 Gmind，继续你的思维之旅</p>
          <div className="tabs">
            {(['phone', 'email', 'wechat'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {{ phone: '手机号', email: '邮箱', wechat: '微信扫码' }[t]}
              </button>
            ))}
          </div>

      {tab === 'phone' && (
        <div className="form">
          <input placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <input placeholder="验证码（开发环境固定 123456）" value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={() => void doLogin({ method: 'phone', phone, code })}>登录</button>
        </div>
      )}

      {tab === 'email' && (
        <div className="form">
          <input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="mode-switch">
            <button className={emailMode === 'code' ? 'active' : ''} onClick={() => setEmailMode('code')}>验证码登录</button>
            <button className={emailMode === 'password' ? 'active' : ''} onClick={() => setEmailMode('password')}>密码登录</button>
          </div>
          <input
            placeholder={emailMode === 'code' ? '验证码（开发环境固定 123456）' : '密码（未设置则先用验证码登录）'}
            value={emailSecret}
            onChange={(e) => setEmailSecret(e.target.value)}
          />
          <button
            onClick={() =>
              void doLogin({
                method: 'email',
                email,
                mode: emailMode,
                code: emailMode === 'code' ? emailSecret : undefined,
                password: emailMode === 'password' ? emailSecret : undefined,
              })
            }
          >
            登录
          </button>
        </div>
      )}

      {tab === 'wechat' && (
        <div className="form">
          <button onClick={() => void doLogin({ method: 'wechat' })}>模拟微信扫码登录</button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
