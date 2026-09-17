import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api/client';
import type { LoginResponse } from '@gmind/shared';

type Tab = 'phone' | 'email' | 'wechat';

export function LoginPage() {
  const navigate = useNavigate();
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
      navigate('/workspace');
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    }
  }

  return (
    <div className="login-page">
      <h1>Gmind</h1>
      <p className="subtitle">在线协作脑图 · 开发环境</p>
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
  );
}
