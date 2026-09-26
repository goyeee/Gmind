import { useEffect, useState } from 'react';
import { SHORTCUT_LIST, type ShortcutGroup } from './keyboardMap';
import './help-panel.css';

/**
 * 快捷键帮助面板 — M5 Task 2（NFR-USE-002 / FR-EDT-007）。
 *
 * 数据面单一来源：SHORTCUT_LIST（keyboardMap.ts 同文件提取，与实际绑定同源——
 * 守卫单测钉住集合一致，见 keyboardMap.test.ts）。面板是「完整列出」镜像，不
 * 自行新增键位/条目。
 *
 * - 抽屉模式沿用 MemberPanel（fixed 右上浮层 + 头部标题/× 关闭）；
 * - 搜索：label+win+mac 大小写不敏感包含匹配，按分组标题分段渲染命中项；
 * - 平台键位：isMacPlatform()（navigator.platform 优先，UA 兜底）二选一展示；
 * - Escape 关闭（document 冒泡监听；TextEditorOverlay 的 Esc 已 stopPropagation，
 *   覆盖层编辑不受影响）。
 */

/** 面板分组渲染顺序（SHORTCUT_LIST 分组枚举的稳定展示序）。 */
const GROUP_ORDER: readonly ShortcutGroup[] = ['节点编辑', '视图', '文件'];

/**
 * macOS 平台检测（M5 Task 2）：navigator.platform 优先（'MacIntel'/'iPhone'/
 * 'iPad' 等），空值兜底 userAgent 含 'Mac'。e2e 两侧平台均以 addInitScript
 * 重写 navigator.platform 钉死，避免断言随宿主漂移。
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  if (platform !== '') return /mac|iphone|ipad|ipod/i.test(platform);
  return /Mac/.test(navigator.userAgent);
}

export interface HelpPanelProps {
  open: boolean;
  onClose(): void;
}

export function HelpPanel({ open, onClose }: HelpPanelProps) {
  const [query, setQuery] = useState('');

  // Escape 关闭（仅面板打开期间挂监听；冒泡阶段，覆盖层 Esc 已被吞不会误关）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown, false);
    return () => document.removeEventListener('keydown', onKeyDown, false);
  }, [open, onClose]);

  // 关闭即清空搜索（下次打开回到全清单）
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!open) return null;

  const mac = isMacPlatform();
  const q = query.trim().toLowerCase();
  const matched =
    q === ''
      ? SHORTCUT_LIST
      : SHORTCUT_LIST.filter(
          (s) =>
            s.label.toLowerCase().includes(q) ||
            s.win.toLowerCase().includes(q) ||
            s.mac.toLowerCase().includes(q),
        );

  return (
    <aside className="help-panel" data-testid="help-panel" aria-label="快捷键帮助">
      <header className="help-panel-header">
        <span className="help-panel-title">快捷键</span>
        <button
          type="button"
          className="help-panel-close"
          data-testid="help-panel-close"
          aria-label="关闭快捷键面板"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <input
        type="text"
        className="help-search"
        data-testid="help-search"
        value={query}
        placeholder="搜索快捷键（名称或键位）"
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      {matched.length === 0 ? (
        <p className="help-empty">无匹配快捷键</p>
      ) : (
        GROUP_ORDER.map((group) => {
          const rows = matched.filter((s) => s.group === group);
          if (rows.length === 0) return null;
          return (
            <section key={group} className="help-group" data-testid={`help-group-${group}`}>
              <h3 className="help-group-title">{group}</h3>
              <ul className="help-rows">
                {rows.map((item) => (
                  <li key={item.id} className="help-item" data-testid="help-item">
                    <span className="help-item-label">{item.label}</span>
                    <kbd className="help-keys" data-testid="help-keys">
                      {mac ? item.mac : item.win}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </aside>
  );
}
