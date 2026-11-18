import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, getToken } from '../api/client';

type ShareInfo =
  | { fileId: string; title: string; ownerName: string; status: 'active'; requiresPassword: boolean }
  | { status: 'closed' }
  | { status: 'expired' };

/** 登录回跳后按链接状态进入：active → 密码（如启用）→ join；过期与关闭分别提示。 */
export function ShareLandingPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'joining' | 'password' | 'invalid' | 'expired'>('loading');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api<ShareInfo>(`/share/${token}`);
        if (cancelled) return;
        if (info.status === 'expired') return setState('expired');
        if (info.status !== 'active') return setState('invalid');
        if (!getToken()) {
          navigate(`/login?redirect=/s/${token}`, { replace: true });
          return;
        }
        if (info.requiresPassword) {
          setState('password');
          return;
        }
        setState('joining');
        try {
          const joined = await api<{ fileId: string }>(`/share/${token}/join`, { method: 'POST' });
          if (!cancelled) navigate(`/edit/${joined.fileId}`, { replace: true });
        } catch {
          if (!cancelled) setState('invalid');
        }
      } catch {
        if (!cancelled) setState('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  async function joinWithPassword(): Promise<void> {
    setError('');
    setState('joining');
    try {
      const joined = await api<{ fileId: string }>(`/share/${token}/join`, { method: 'POST', body: { password } });
      navigate(`/edit/${joined.fileId}`, { replace: true });
    } catch (e) {
      setState('password');
      setError(e instanceof Error ? e.message : '验证失败，请稍后重试');
    }
  }

  if (state === 'invalid' || state === 'expired') {
    return (
      <div className="share-landing" data-testid="share-invalid">
        <h1>{state === 'expired' ? '链接已过期' : '链接已失效'}</h1>
        <p>{state === 'expired' ? '链接已过期，请联系文件创建者重新分享' : '该分享链接不存在，或已被文件所有者关闭。如需继续访问，请联系分享者重新获取。'}</p>
        <button onClick={() => navigate('/workspace')}>返回工作台</button>
      </div>
    );
  }

  if (state === 'password' || (state === 'joining' && error)) {
    const submitting = state === 'joining';
    return (
      <form
        className="share-landing share-password"
        data-testid="share-password"
        onSubmit={(e) => {
          e.preventDefault();
          if (!submitting) void joinWithPassword();
        }}
      >
        <h1>需要访问密码</h1>
        <p>请输入创建者提供的 4 位数字密码，验证后进入文件</p>
        <input
          data-testid="share-password-input"
          aria-label="4 位访问密码"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={password}
          disabled={submitting}
          onChange={(e) => setPassword(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        {error && <p className="error" data-testid="share-password-error" role="alert">{error}</p>}
        <button data-testid="share-password-submit" disabled={submitting || password.length !== 4}>
          {submitting ? '验证中…' : '进入文件'}
        </button>
      </form>
    );
  }

  return (
    <div className="share-landing">
      <p>{state === 'joining' ? '正在加入协作…' : '分享链接校验中…'}</p>
    </div>
  );
}
