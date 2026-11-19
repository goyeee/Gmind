import { useEffect, useId, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { api, apiPatch, apiPost } from '../api/client';
import { InviteSection, MembersSection, useCollaborators } from './MemberPanel';
import type { MemberOption } from './TaskFields';
import type { PresenceMember } from './collab';
import { exportCsv, exportMarkdown, exportXlsx } from './docExport';
import './share-dialog.css';

type Tab = 'pending' | 'members' | 'invite' | 'link' | 'export';
type ShareRole = 'editor' | 'commenter' | 'viewer';
type ExpiresIn = 'forever' | '7' | '30';
type LinkState = 'loading' | 'active' | 'closed' | 'expired' | 'error';
interface LinkView { status: 'active' | 'closed' | 'expired'; shareToken?: string; role: ShareRole; password: string | null; expiresIn: ExpiresIn; expiresAt: string | null }

export interface ShareDialogProps {
  open: boolean;
  onClose(): void;
  fileId: string;
  title: string;
  canManage: boolean;
  identityReady: boolean;
  initialTab?: 'auto' | 'members' | 'export';
  members: PresenceMember[];
  memberIndex?: Map<string, MemberOption>;
  focusUserId?: string | null;
  doc: Y.Doc | null;
  nameOf(userId: string): string;
  showToast(message: string): void;
  onMembershipChanged(): void;
  onExport(kind: 'xmind' | 'jpg', scale?: 1 | 2 | 3): void;
}

export function ShareDialog(p: ShareDialogProps) {
  const [tab, setTab] = useState<Tab>('pending');
  const [linkState, setLinkState] = useState<LinkState>('loading');
  const [token, setToken] = useState('');
  const [role, setRole] = useState<ShareRole>('viewer');
  const [password, setPassword] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<ExpiresIn>('forever');
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [linkTick, setLinkTick] = useState(0);
  const [exported, setExported] = useState('');
  const [jpgScale, setJpgScale] = useState<1 | 2 | 3>(2);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(false);
  const userChosenRef = useRef(false);
  const titleId = useId();
  const collaborators = useCollaborators(p.open, p.fileId, p.showToast, p.onMembershipChanged);

  useEffect(() => {
    if (!p.open) {
      openedRef.current = false;
      userChosenRef.current = false;
      return;
    }
    if (!openedRef.current) {
      openedRef.current = true;
      userChosenRef.current = false;
      if (p.initialTab === 'members' || p.initialTab === 'export') setTab(p.initialTab);
      else if (p.identityReady) setTab(p.canManage ? 'invite' : 'export');
      return;
    }
    // 只有分享入口的自动默认页可等待身份；用户已手动切页后绝不覆盖。
    if ((p.initialTab ?? 'auto') === 'auto' && p.identityReady && !userChosenRef.current) setTab(p.canManage ? 'invite' : 'export');
  }, [p.open, p.initialTab, p.identityReady, p.canManage]);

  useEffect(() => {
    if (!p.open || !p.canManage) return;
    let alive = true;
    setLinkState('loading');
    api<LinkView>(`/files/${p.fileId}/share`)
      .then((res) => {
        if (!alive) return;
        setRole(res.role);
        setPassword(res.password);
        setExpiresIn(res.expiresIn);
        if (res.status === 'active') setToken(res.shareToken ?? '');
        else setToken('');
        setLinkState(res.status);
      })
      .catch(() => { if (alive) setLinkState('error'); });
    return () => { alive = false; };
  }, [p.open, p.fileId, p.canManage, linkTick]);

  useEffect(() => {
    if (!p.open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = boxRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? boxRef.current;
    target?.focus();
    return () => { previous?.focus(); };
  }, [p.open, tab]);

  useEffect(() => {
    if (!p.open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        p.onClose();
        return;
      }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const controls = [...boxRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((el) => el.offsetParent !== null);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === boxRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [p.open, p.onClose]);

  if (!p.open) return null;

  const selectTab = (next: Tab): void => {
    userChosenRef.current = true;
    setTab(next);
  };
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
        const res = await apiPost<{ shareToken: string }>(`/files/${p.fileId}/share`, { role, passwordEnabled: password !== null, expiresIn });
        setToken(res.shareToken);
        setLinkTick((v) => v + 1);
        p.showToast(linkState === 'expired' ? '已生成新链接' : '链接分享已开启');
      } else {
        await api(`/files/${p.fileId}/share`, { method: 'DELETE' });
        setLinkState('closed');
        setToken('');
        p.showToast('链接分享已关闭');
      }
    } catch (e) {
      p.showToast(e instanceof Error ? e.message : '操作失败，请稍后重试');
    } finally { setToggling(false); }
  };
  const configureLink = async (next: { role?: ShareRole; passwordEnabled?: boolean; expiresIn?: ExpiresIn }): Promise<void> => {
    if (toggling) return;
    setToggling(true);
    try {
      await apiPatch(`/files/${p.fileId}/share`, next);
      if (next.role) setRole(next.role);
      if (next.expiresIn) setExpiresIn(next.expiresIn);
      if (next.passwordEnabled === false) setPassword(null);
      if (next.passwordEnabled !== undefined) setLinkTick((v) => v + 1);
      if (next.role) p.showToast(next.role === 'viewer' ? '新加入的成员将仅查看' : next.role === 'commenter' ? '新加入的成员可评论' : '新加入的成员可编辑');
    } catch (e) {
      p.showToast(e instanceof Error ? e.message : '修改失败，请稍后重试');
      setLinkTick((v) => v + 1);
    } finally { setToggling(false); }
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
    { id: 'jpg', testid: 'share-export-jpg', title: '图片', ext: '.jpg', desc: `白底高清整图（${jpgScale}×），适合插入文档与汇报`, tint: '#0ea5e9', bg: '#eaf5ff', run: () => p.onExport('jpg', jpgScale) },
    { id: 'md', testid: 'share-export-md', title: 'Markdown', ext: '.md', desc: '层级大纲文本，可粘贴到笔记与文档工具', tint: '#8b5cf6', bg: '#f1edff', run: () => runTextExport('md') },
    { id: 'xlsx', testid: 'share-export-xlsx', title: 'Excel 表格', ext: '.xlsx', desc: '任务表电子表格，可用 Excel/WPS 打开', tint: '#16a34a', bg: '#e9f9ef', run: () => runTextExport('xlsx') },
    { id: 'csv', testid: 'share-export-csv', title: 'CSV 表格', ext: '.csv', desc: '任务表 7 列，可用 Excel 打开', tint: '#14b8a6', bg: '#e9f8f4', run: () => runTextExport('csv') },
  ];
  const runExport = (e: ExportItem): void => {
    try {
      e.run();
      setExported(e.id);
      p.showToast(`已导出 ${e.title}`);
      setTimeout(() => setExported((x) => x === e.id ? '' : x), 1800);
    } catch (err) {
      p.showToast(err instanceof Error ? err.message : '导出失败');
    }
  };
  const active = linkState === 'active';

  return (
    <div className="share-dialog-mask" data-testid="share-dialog" onClick={p.onClose}>
      <div ref={boxRef} className="share-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="share-dialog-head">
          <span className="share-dialog-title" id={titleId}>分享「{p.title}」</span>
          <button type="button" className="share-dialog-close" data-testid="share-dialog-close" aria-label="关闭" onClick={p.onClose}>×</button>
        </header>
        <div className="share-dialog-tabs" role="tablist" aria-label="分享页签">
          <button role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} data-testid="share-tab-members" onClick={() => selectTab('members')}>协作成员 {collaborators.collabs?.length ?? ''}</button>
          {p.canManage && <button role="tab" aria-selected={tab === 'invite'} className={tab === 'invite' ? 'active' : ''} data-testid="share-tab-invite" onClick={() => selectTab('invite')}>邀请协作</button>}
          <button role="tab" aria-selected={tab === 'link'} className={tab === 'link' ? 'active' : ''} data-testid="share-tab-link" onClick={() => selectTab('link')}>链接分享</button>
          <button role="tab" aria-selected={tab === 'export'} className={tab === 'export' ? 'active' : ''} data-testid="share-tab-export" onClick={() => selectTab('export')}>导出</button>
        </div>

        {tab === 'pending' && <div className="share-dialog-body"><p className="share-dialog-hint">正在确认协作权限…</p></div>}
        {tab === 'members' && (
          <MembersSection open rows={collaborators.collabs} members={p.members} memberIndex={p.memberIndex} canManage={p.canManage} busy={collaborators.busy} focusUserId={p.focusUserId} error={collaborators.error} onRetry={collaborators.reload} onInvite={() => selectTab('invite')} onRemove={(row) => void collaborators.remove(row)} onRole={(row, next) => void collaborators.changeRole(row, next)} />
        )}
        {tab === 'invite' && p.canManage && (
          <div className="share-dialog-body share-dialog-invite">
            <InviteSection fileId={p.fileId} showToast={p.showToast} onInvited={() => { collaborators.reload(); p.onMembershipChanged(); selectTab('members'); }} />
          </div>
        )}
        {tab === 'link' && (
          <>
            <div className="share-dialog-body share-dialog-link">
              {!p.canManage ? <p className="share-dialog-hint">链接分享由文件创建者管理，如需开放请联系创建者。</p> : linkState === 'loading' ? <p className="share-dialog-hint">链接状态加载中…</p> : linkState === 'error' ? (
                <p className="share-dialog-hint">链接状态加载失败，请重试 <button type="button" onClick={() => setLinkTick((v) => v + 1)}>重试</button></p>
              ) : (
                <>
                  <div className="share-link-status">
                    <button type="button" className={'share-link-toggle' + (active ? ' on' : '')} role="switch" aria-checked={active} data-testid="share-link-toggle" disabled={toggling} onClick={() => void toggleLink(!active)}><span className="share-link-knob" aria-hidden /></button>
                    <div className="share-link-desc">
                      <b>{active ? '获得链接的人登录后可访问' : linkState === 'expired' ? '链接已过期' : '仅受邀成员可访问'}</b>
                      <span>{active ? '加入后按链接权限成为协作者' : linkState === 'expired' ? '重新开启将生成新链接，旧地址永久失效' : '开启后生成专属链接，登录后即可访问'}</span>
                    </div>
                  </div>
                  {!active && (
                    <ul className="share-link-benefits">
                      <li>登录后即可访问，可设置可编辑、可评论或仅查看</li>
                      <li>可设置 4 位访问密码与 7 天/30 天有效期</li>
                      <li>随时可以关闭，关闭后已发出的链接立即失效</li>
                    </ul>
                  )}
                  {active && (
                    <div className="share-link-settings">
                      <div className="share-link-row"><code className="share-link-url" data-testid="share-link-url">{location.origin}/s/{token}</code><button type="button" className="share-link-copy" data-testid="share-link-copy" onClick={() => void copyLink()}>{copied ? '已复制 ✓' : '复制链接'}</button></div>
                      <label className="share-link-role">链接权限<select value={role} data-testid="share-link-role" disabled={toggling} onChange={(e) => void configureLink({ role: e.target.value as ShareRole })}><option value="editor">可编辑</option><option value="commenter">可评论</option><option value="viewer">仅查看</option></select></label>
                      <label className="share-link-role">有效期<select value={expiresIn} data-testid="share-link-expiry" disabled={toggling} onChange={(e) => void configureLink({ expiresIn: e.target.value as ExpiresIn })}><option value="forever">永久有效</option><option value="7">7 天</option><option value="30">30 天</option></select></label>
                      <div className="share-link-password-row">
                        <span>访问密码</span>
                        <button type="button" className={'share-link-toggle' + (password !== null ? ' on' : '')} role="switch" aria-checked={password !== null} data-testid="share-link-password-toggle" disabled={toggling} onClick={() => void configureLink({ passwordEnabled: password === null })}><span className="share-link-knob" aria-hidden /></button>
                        <span>{password === null ? '无需密码' : '访客需输入 4 位密码 · '}<code data-testid="share-link-password">{password}</code></span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <footer className="share-dialog-footer">关闭链接分享后，已发出的链接将立即失效</footer>
          </>
        )}
        {tab === 'export' && (
          <>
            <div className="share-dialog-body share-dialog-export">
              <p className="share-export-note">导出「{p.title}」：XMind 与表格类格式含已折叠的全部节点；图片按当前折叠状态导出</p>
              <ul className="share-export-list">
                {EXPORTS.map((e) => {
                  const content = <><span className="share-export-icon" style={{ background: e.bg, color: e.tint }} aria-hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg></span><span className="share-export-text"><b>{e.title}<i className="share-export-ext">{e.ext}</i></b><span>{e.desc}</span></span></>;
                  return <li key={e.id}>{e.id === 'jpg' ? (
                    <div className="share-export-row share-export-row-config">
                      {content}
                      <select aria-label="图片导出清晰度" data-testid="share-export-jpg-scale" value={jpgScale} onChange={(event) => setJpgScale(Number(event.target.value) as 1 | 2 | 3)}><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option></select>
                      <button type="button" className={'share-export-btn' + (exported === e.id ? ' done' : '')} data-testid={e.testid} onClick={() => runExport(e)}>{exported === e.id ? '已导出 ✓' : '导出'}</button>
                    </div>
                  ) : (
                    <button type="button" className="share-export-row" data-testid={e.testid} onClick={() => runExport(e)}>{content}<span className={'share-export-btn' + (exported === e.id ? ' done' : '')}>{exported === e.id ? '已导出 ✓' : '导出'}</span></button>
                  )}</li>;
                })}
              </ul>
            </div>
            <footer className="share-dialog-footer">导出的文件会保存到浏览器的默认下载位置</footer>
          </>
        )}
      </div>
    </div>
  );
}
