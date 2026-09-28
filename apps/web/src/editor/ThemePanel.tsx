import { THEMES, type ThemeId, type ThemeTokens } from '@gmind/engine';
import './theme-panel.css';

/**
 * 主题选择面板 — M6 Task 4（企微对标）：缩略图网格抽屉。
 *
 * - 抽屉样式复用 MemberPanel 模式（右上角工具栏下方浮层，open=false 整棵不渲染）；
 * - 缩略图 = 3 节点迷你 SVG 内联渲染（root/level1/level2 三级 fill + 画布底色 +
 *   edge 连线色全部取自 THEMES 真值，所见即所得）；
 * - 点击即套用：EditorPage 侧 setDocMeta themeId（既有链路，可撤销）并关闭抽屉；
 * - 既有工具栏 theme-select <select> 保留（零回归裁决，见任务报告），本面板是
 *   增量的第二入口；
 * - 当前主题 aria-pressed=true 高亮；testid theme-panel / theme-item-{id} /
 *   theme-panel-close。
 */

/** 十二套主题的展示名与渲染序（M1b 三套在前，M6 扩容九套在后）。 */
export const THEME_LABELS: Record<ThemeId, string> = {
  'gmind-blue': '经典蓝',
  'gmind-warm': '暖橙',
  'gmind-accessible': '无障碍',
  'deep-blue': '深蓝商务',
  forest: '森绿',
  sakura: '樱粉',
  graphite: '石墨',
  violet: '紫罗兰',
  amber: '琥珀',
  celadon: '青瓷',
  'ink-wash': '水墨',
  peach: '蜜桃',
};

export const THEME_ORDER: ThemeId[] = Object.keys(THEME_LABELS) as ThemeId[];

/** 3 节点迷你缩略图：root → level1/level2 各一，连线取 edgeColor，底取画布色。 */
function ThemeThumb({ theme }: { theme: ThemeTokens }) {
  return (
    <svg
      className="theme-thumb"
      viewBox="0 0 96 56"
      role="img"
      aria-hidden
      focusable="false"
    >
      <rect x="0" y="0" width="96" height="56" fill={theme.canvasBackground} rx="4" />
      <path
        d="M 26 28 C 34 28 34 14 42 14 M 26 28 C 34 28 34 42 42 42"
        fill="none"
        stroke={theme.edgeColor}
        strokeWidth="1.5"
      />
      <rect x="5" y="21" width="21" height="14" rx="3" fill={theme.rootFill} stroke={theme.rootBorderColor} strokeWidth="1" />
      <rect x="42" y="9" width="24" height="10" rx="2.5" fill={theme.level1Fill} stroke={theme.level1BorderColor} strokeWidth="1" />
      <rect x="42" y="37" width="24" height="10" rx="2.5" fill={theme.level2Fill} stroke={theme.level2BorderColor} strokeWidth="1" />
    </svg>
  );
}

export interface ThemePanelProps {
  open: boolean;
  /** 当前生效主题（resolveThemeId 解析后的合法 id）：对应缩略图高亮。 */
  currentId: ThemeId;
  onClose(): void;
  /** 套用主题：EditorPage 侧走 setDocMeta themeId（可撤销）+ afterUserWrite。 */
  onApply(id: ThemeId): void;
}

export function ThemePanel({ open, currentId, onClose, onApply }: ThemePanelProps) {
  if (!open) return null;
  return (
    <aside className="theme-panel" data-testid="theme-panel" aria-label="主题选择">
      <header className="theme-panel-header">
        <span className="theme-panel-title">主题</span>
        <button
          type="button"
          className="theme-panel-close"
          data-testid="theme-panel-close"
          aria-label="关闭主题面板"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="theme-grid">
        {THEME_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            className={'theme-item' + (id === currentId ? ' current' : '')}
            data-testid={`theme-item-${id}`}
            aria-pressed={id === currentId}
            title={THEME_LABELS[id]}
            onClick={() => onApply(id)}
          >
            <ThemeThumb theme={THEMES[id]} />
            <span className="theme-item-label">{THEME_LABELS[id]}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
