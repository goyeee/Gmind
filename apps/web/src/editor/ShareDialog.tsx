import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { api, apiPost } from '../api/client';
import { InviteSection } from './MemberPanel';
import { exportCsv, exportMarkdown, exportXlsx } from './docExport';
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
 * - 导出（2026-11-15 改版五项列表）：XMind/JPG（2× 白底）转发既有导出通道
 *   （EditorPage 闭包）+ Markdown/CSV/XLSX 真实下载（docExport，全部画布）；
 *   PNG 2026-11-15 退役。单项点击即导出，1800ms「已导出 ✓」回落。
 */

export interface ShareDialogProps {
  open: boolean;
  onClose(): void;
  fileId: string;
  title: string;
  /** 文件创建者视角（owner 可管理链接与邀请）。 */
  canManage: boolean;
  /** MD/CSV/XLSX 导出的文档与负责人昵称映射（EditorPage 传入 memberIndex 闭包）。 */
  doc: Y.Doc | null;
  nameOf(userId: string): string;
  showToast(message: string): void;
  /** 既有导出通道转发（2026-11-15 图片统一 JPG 白底，PNG 退役）。 */
  onExport(kind: 'xmind' | 'jpg', scale?: 1 | 2 | 3): void;
}

export function ShareDialog(p: ShareDialogProps) {
  const [tab, setTab] = useState<'invite' | 'link' | 'export'>(p.canManage ? 'invite' : 'export');
  const [linkState, setLinkState] = useState<'loading' | 'active' | 'closed'>('loading');
  const [token, setToken] = useState('');
  // 权限档位（2026-10-28 P0）：editor=可编辑（存量默认）/ viewer=仅查看
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);
  // 导出反馈（2026-11-15 改版）：记录刚导出成功的项 id，1800ms 后回落为「导出」。
  const [exported, setExported] = useState('');

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

  const runTextExport = (kind: 'md' | 'csv' | 'xlsx'): void => {
    if (!p.doc) return;
    if (kind === 'md') exportMarkdown(p.doc, p.title || '未命名');
    else if (kind === 'csv') exportCsv(p.doc, p.title || '未命名', p.nameOf);
    else exportXlsx(p.doc, p.title || '未命名', p.nameOf);
  };

  interface ExportItem { id: string; testid: string; title: string; ext: string; desc: string; tint: string; bg: string; run: () => void }
  const EXPORTS: ExportItem[] = [
    { id: 'xmind', testid: 'share-export-xmind', title: 'XMind', ext: '.xmind', desc: '可在 XMind 中继续编辑，保留完整层级，含全部画布', tint: '#f43f5e', bg: '#fdeceb', run: () => p.onExport('xmind') },
    { id: 'jpg', testid: 'share-export-jpg', title: '图片', ext: '.jpg', desc: '白底高清整图（2×），适合插入文档与汇报', tint: '#0ea5e9', bg: '#eaf5ff', run: () => p.onExport('jpg', 2) },
    { id: 'md', testid: 'share-export-md', title: 'Markdown', ext: '.md', desc: '层级大纲文本，可粘贴到笔记与文档工具', tint: '#8b5cf6', bg: '#f1edff', run: () => runTextExport('md') },
    { id: 'csv', testid: 'share-export-csv', title: 'CSV 表格', ext: '.csv', desc: '任务表 7 列，可用 Excel 打开', tint: '#14b8a6', bg: '#e9f8f4', run: () => runTextExport('csv') },
    { id: 'xlsx', testid: 'share-export-xlsx', title: 'Excel 表格', ext: '.xlsx', desc: '任务表电子表格，可用 Excel/WPS 打开', tint: '#16a34a', bg: '#e9f9ef', run: () => runTextExport('xlsx') },
  ];

  const runExport = (e: ExportItem): void => {
    try {
      e.run();
      setExported(e.id);
      p.showToast(`已导出 ${e.title}`);
      setTimeout(() => setExported((x) => (x === e.id ? '' : x)), 1800);
    } catch (err) {
      p.showToast(err instanceof Error ? err.message : '导出失败');
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
            <p className="share-export-note">导出「{p.title}」：XMind 与表格类格式含已折叠的全部节点；图片按当前折叠状态导出</p>
            <ul className="share-export-list">
              {EXPORTS.map((e) => (
                <li key={e.id}>
                  <button type="button" className="share-export-row" data-testid={e.testid} onClick={() => runExport(e)}>
                    <span className="share-export-icon" style={{ background: e.bg, color: e.tint }} aria-hidden>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                    </span>
                    <span className="share-export-text">
                      <b>{e.title}<i className="share-export-ext">{e.ext}</i></b>
                      <span>{e.desc}</span>
                    </span>
                    <span className={'share-export-btn' + (exported === e.id ? ' done' : '')}>{exported === e.id ? '已导出 ✓' : '导出'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
