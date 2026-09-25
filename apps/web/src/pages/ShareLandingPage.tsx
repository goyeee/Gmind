import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, getToken } from '../api/client';

/** GET /api/share/:token 的响应（closed/missing 统一 {status:'closed'}，服务端口径）。 */
type ShareInfo = { fileId: string; title: string; ownerName: string; status: 'active' } | { status: 'closed' };

/**
 * 分享落地页（M3b Task 4，FR-SHR-001）：/s/:token 公开可达。
 *
 * 流程：GET /api/share/:token 探测（登录前）→
 * - closed/missing → 失效页（「链接已失效」+ 返回工作台）——服务端统一 closed 响应，
 *   不泄露 token 存在性差异，前端不区分渲染；
 * - active + 未登录 → 跳 /login?redirect=/s/:token，登录成功后经 LoginPage 的
 *   redirect 参数跳回本页；
 * - active + 已登录 → 自动 POST join（幂等）→ 跳 /edit/:fileId；join 失败
 *   （404「链接已失效」，active→closed 竞态窗口）→ 失效页。
 */
export function ShareLandingPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'joining' | 'invalid'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api<ShareInfo>(`/share/${token}`);
        if (cancelled) return;
        if (info.status !== 'active') return setState('invalid');
        if (!getToken()) {
          navigate(`/login?redirect=/s/${token}`, { replace: true });
          return;
        }
        setState('joining');
        try {
          const joined = await api<{ fileId: string }>(`/share/${token}/join`, { method: 'POST' });
          if (!cancelled) navigate(`/edit/${joined.fileId}`, { replace: true });
        } catch {
          if (!cancelled) setState('invalid'); // join 失败（链接已失效等）→ 失效页
        }
      } catch {
        if (!cancelled) setState('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  if (state === 'invalid') {
    return (
      <div className="share-landing" data-testid="share-invalid">
        <h1>链接已失效</h1>
        <p>该分享链接不存在，或已被文件所有者关闭。</p>
        <button onClick={() => navigate('/workspace')}>返回工作台</button>
      </div>
    );
  }

  return (
    <div className="share-landing">
      <p>{state === 'joining' ? '正在加入协作…' : '分享链接校验中…'}</p>
    </div>
  );
}
