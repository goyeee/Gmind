import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { api, apiPost } from '../api/client';
import { InviteSection } from './MemberPanel';
import { exportCsv, exportMarkdown } from './docExport';
import './share-dialog.css';

/**
 * 分享弹窗（2026-10-25 原型 ShareModal 三页签：邀请协作/链接分享/导出）。
 * 协作成员/邀请的常驻入口仍是成员面板（members-btn）；本弹窗 share-btn 打开，
 * 邀请页签复用 MemberPanel.InviteSection 同一交互面。
 *
 * - 邀请协作（owner 专属）：搜索候选→待邀请→确定（与成员面板同款）；
 * - 链接分享（owner 可管理）：GET 状态 → 开=POST /share（复用既有 token）/
 *   关=DELETE /share；开态显示链接+复制（1.5s「已复制」）。有效期/访问密码为
 *   原型 mock（share_links 预留列，FR-SHR-003 二期）——不设，如实登记；
 *   非 owner 只读提示（服务端 owner-only 404 不泄露）；
 * - 导出：XMind/PNG×3/JPG×3 转发既有导出通道（EditorPage 闭包）+ Markdown
 *   大纲/CSV 任务表真实下载（docExport，全部画布）。
 */

export interface ShareDialogProps {
  open: boolean;
  onClose(): void;
  fileId: string;
  title: string;
  /** 文件创建者视角（owner 可管理链接与邀请）。 */
  canManage: boolean;
  /** MD/CSV 导出的文档与负责人昵称映射（EditorPage 传入 memberIndex 闭包）。 */
  doc: Y.Doc | null;
  nameOf(userId: string): string;
  showToast(message: string): void;
  /** 既有导出通道转发：kind 与倍率（image-export/exportXmind 落在 EditorPage 闭包）。 */
  onExport(kind: 'xmind' | 'png' | 'jpg', scale?: 1 | 2 | 3): void;
}

export function ShareDialog(p: ShareDialogProps) {
  const [tab, setTab] = useState<'invite' | 'link' | 'export'>(p.canManage ? 'invite' : 'export');
  const [linkState, setLinkState] = useState<'loading' | 'active' | 'closed'>('loading');
  const [token, setToken] = useState('');
  // 权限档位（2026-10-28 P0）：editor=可编辑（存量默认）/ viewer=仅查看
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (!p.open || !p.canManage) return;
    let alive = true;
    setLinkState('loading');
    void api<{ status: 'active'; shareToken: string; role: 'editor' | 'viewer' } | { status: 'closed' }>(`/files/${p.fileId}/share`)
      .then((res) => {
        if (!alive) return;
        if (res.status === 'active') {
          setToken(res.shareToken);
          setRole(res.role);
          setLinkState('active');
        } else {
          setLinkState('closed');
        }
      })
      .catch(() => {
        if (alive) setLinkState('closed');
      });
    return () => {
      alive = false;
    };
  }, [p.open, p.fileId, p.canManage]);

  if (!p.open) return null;

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/s/${token}`);
      setCopied(true);
      p.showToast('链接已复制');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      p.showToast('复制失败，请检查浏览器剪贴板权限');
    }
  };

  const toggleLink = async (on: boolean): Promise<void> => {
    if (toggling) return;
    setToggling(true);
    try {
      if (on) {
        const res = await apiPost<{ shareToken: string }>(`/files/${p.fileId}/share`, { role });
        setToken(res.shareToken);
        setLinkState('active');
        p.showToast('链接分享已开启');
      } else {
        await api(`/files/${p.fileId}/share`, { method: 'DELETE' });
        setLinkState('closed');
        setToken('');
        p.showToast('链接分享已关闭');
      }
    } catch (e) {
      p.showToast(e instanceof Error ? e.message : '操作失败，请稍后重试');
    } finally {
      setToggling(false);
    }
  };

  /** 改档（2026-10-28 P0）：token 不变即改即生效——已发出的链接立即按新档位生效。 */
  const changeRole = async (next: 'editor' | 'viewer'): Promise<void> => {
    setRole(next);
    try {
      await api(`/files/${p.fileId}/share`, { method: 'PATCH', body: { role: next } });
      p.showToast(next === 'viewer' ? '已改为仅查看，新加入的成员将只读' : '已改为可编辑');
    } catch (e) {
      p.showToast(e instanceof Error ? e.message : '修改失败，请稍后重试');
    }
  };

  const runTextExport = (kind: 'md' | 'csv'): void => {
    if (!p.doc) return;
    try {
      if (kind === 'md') exportMarkdown(p.doc, p.title || '未命名');
      else exportCsv(p.doc, p.title || '未命名', p.nameOf);
    } catch (e) {
      p.showToast(e instanceof Error ? e.message : '导出失败');
    }
  };

  return (
    <div className="share-dialog-mask" data-testid="share-dialog" onClick={p.onClose}>
      <div
        className="share-dialog"
        role="dialog"
        aria-label={`分享「${p.title}」`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="share-dialog-head">
          <span className="share-dialog-title">分享「{p.title}」</span>
          <button type="button" className="share-dialog-close" data-testid="share-dialog-close" aria-label="关闭" onClick={p.onClose}>
            ×
          </button>
        </header>
        <div className="share-dialog-tabs" role="tablist" aria-label="分享页签">
          {p.canManage && (
            <button role="tab" aria-selected={tab === 'invite'} className={tab === 'invite' ? 'active' : ''} data-testid="share-tab-invite" onClick={() => setTab('invite')}>
              邀请协作
            </button>
          )}
          <button role="tab" aria-selected={tab === 'link'} className={tab === 'link' ? 'active' : ''} data-testid="share-tab-link" onClick={() => setTab('link')}>
            链接分享
          </button>
          <button role="tab" aria-selected={tab === 'export'} className={tab === 'export' ? 'active' : ''} data-testid="share-tab-export" onClick={() => setTab('export')}>
            导出
          </button>
        </div>

        {tab === 'invite' && p.canManage && (
          <div className="share-dialog-body share-dialog-invite">
            <InviteSection fileId={p.fileId} showToast={p.showToast} onInvited={() => setTab('link')} />
          </div>
        )}

        {tab === 'link' && (
          <div className="share-dialog-body share-dialog-link">
            {p.canManage ? (
              <>
                <button
                  type="button"
                  className={'share-link-toggle' + (linkState === 'active' ? ' on' : '')}
                  role="switch"
                  aria-checked={linkState === 'active'}
                  data-testid="share-link-toggle"
                  disabled={toggling || linkState === 'loading'}
                  onClick={() => void toggleLink(linkState !== 'active')}
                >
                  <span className="share-link-knob" aria-hidden />
                </button>
                <div className="share-link-desc">
                  <b>{linkState === 'active' ? '任何拥有链接的人可访问' : '仅受邀成员可访问'}</b>
                  <span>{linkState === 'active' ? '开启后可通过链接分享给任何人，加入即成为协作者' : '开启后可通过链接分享给任何人'}</span>
                </div>
                {linkState === 'active' && (
                  <>
                    <label className="share-link-role">
                      链接权限
                      <select
                        value={role}
                        data-testid="share-link-role"
                        onChange={(e) => void changeRole(e.target.value as 'editor' | 'viewer')}
                      >
                        <option value="editor">可编辑</option>
                        <option value="viewer">仅查看</option>
                      </select>
                    </label>
                    <div className="share-link-row">
                      <code className="share-link-url" data-testid="share-link-url">
                        {location.origin}/s/{token}
                      </code>
                      <button type="button" className="share-link-copy" data-testid="share-link-copy" onClick={() => void copyLink()}>
                        {copied ? '已复制 ✓' : '复制链接'}
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="share-dialog-hint">链接分享由文件创建者管理，如需开放请联系创建者。</p>
            )}
          </div>
        )}

        {tab === 'export' && (
          <div className="share-dialog-body share-dialog-export">
            <button type="button" onClick={() => p.onExport('xmind')} data-testid="share-export-xmind">
              <b>XMind</b>
              <span>.xmind 格式，全部画布</span>
            </button>
            <button type="button" onClick={() => runTextExport('md')} data-testid="share-export-md">
              <b>Markdown</b>
              <span>大纲文本 .md，全部画布</span>
            </button>
            <button type="button" onClick={() => runTextExport('csv')} data-testid="share-export-csv">
              <b>CSV 表格</b>
              <span>任务表，可用 Excel 打开</span>
            </button>
            {[1, 2, 3].map((n) => (
              <button key={`png${n}`} type="button" onClick={() => p.onExport('png', n as 1 | 2 | 3)} data-testid={`share-export-png-${n}x`}>
                <b>PNG {n}x</b>
                <span>{n === 1 ? '标准分辨率' : `${n} 倍分辨率`}</span>
              </button>
            ))}
            {[1, 2, 3].map((n) => (
              <button key={`jpg${n}`} type="button" onClick={() => p.onExport('jpg', n as 1 | 2 | 3)} data-testid={`share-export-jpg-${n}x`}>
                <b>JPG {n}x</b>
                <span>{n === 1 ? '标准分辨率（白底）' : `${n} 倍分辨率（白底）`}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
