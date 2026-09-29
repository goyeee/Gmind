import type { ReactElement } from 'react';
import type { IconGroup } from '@gmind/core';
import { MARKER_CATALOG, MARKER_GROUP_LABELS, type MarkerGlyphDef } from '@gmind/engine';
import './marker-panel.css';

/**
 * 节点标记面板（M7b-W3 企微式竖层重做，需求方原话「竖着的贴近右侧的层、内部分组、
 * 顶部按钮点开、不要固定在右侧」）。
 *
 * 形态：**锚定弹出层**——挂在工具栏 .insert-wrap 下（position:absolute），顶部贴
 * 「插入」按钮下沿、左缘与按钮对齐（右缘越界时按 anchor 左移钳制），向下展开；
 * 宽 340px、max-height 70vh 内部滚动。替换 M7a 版 position:fixed 视口抽屉。
 * 顶部「图标」/「表情」标题 + 分段页签（图标|表情）+ 右上角 ×（企微截图同构）。
 *
 * 内容（M7b-W1 目录单源，不手抄）：图标页 = 心情/优先级/数字/箭头/旗帜/进程/其他
 * 七组竖排（组名左上小字 + 图标行，MARKER_CATALOG 逐值渲染彩色 chip）；表情页 =
 * 28 枚 emoji 平铺网格。容器 testid（marker-panel-close/marker-tab-icon/
 * marker-tab-emoji/marker-icon-page/marker-emoji-page/marker-group-*）与逐值
 * testid `marker-{group}-{slug}` 全部保留。
 *
 * 语义（M7b-W1 组语义常量 + W3 批量）：single 组（心情/优先级/数字/箭头/旗帜/进程）
 * 组内单选替换；multi 组（其他/表情）组内多选叠加。回显 = 选中集**交集口径**
 * （全含才亮，页面侧算好传入）；无选中禁用 + 提示；有选中（单选/多选）即可点，
 * 点标记 = 批量应用（「全含则移除否则设置」在页面侧 applyMarker 展开，一次性事务）。
 * aria-pressed 按交集回显。写入经 onSetIcon 上抛（origin 纪律不变）。
 */

/** chip 几何（与 engine 徽标同 14px 视觉族；彩色圆徽/方块/三角 + 文字或字符）。 */
export function MarkerChip({ def, size = 18 }: { def: MarkerGlyphDef; size?: number }): ReactElement {
  const fontSize = (def.text?.length ?? 1) > 1 ? Math.round(size * 0.38) : Math.round(size * 0.52);
  if (def.kind === 'pie' && (def.fraction ?? 1) < 1) {
    const deg = Math.round((def.fraction ?? 0) * 360);
    return (
      <span
        className="marker-chip-round"
        style={{
          width: size,
          height: size,
          background: `conic-gradient(${def.color} 0deg ${deg}deg, #ffffff ${deg}deg 360deg)`,
          boxShadow: `inset 0 0 0 1.5px ${def.color}`,
        }}
        aria-hidden
      />
    );
  }
  if (def.kind === 'circleText' || def.kind === 'squareText' || def.kind === 'triangle') {
    return (
      <span
        className="marker-chip-badge"
        style={{
          width: size,
          height: size,
          background: def.color,
          borderRadius: def.kind === 'squareText' ? 4 : def.kind === 'triangle' ? 2 : '50%',
          fontSize,
          color: '#fff',
          lineHeight: `${size}px`,
        }}
        aria-hidden
      >
        {def.text}
      </span>
    );
  }
  if (def.kind === 'mood') {
    // 心情 chip（M7b-K2 补）：橙圆 + 白色眼/嘴，与 engine drawMarkerBadge mood 同族简化。
    const v = def.variant ?? 0;
    return (
      <span
        className="marker-chip-badge"
        style={{ width: size, height: size, background: def.color, borderRadius: '50%', position: 'relative', overflow: 'hidden' }}
        aria-hidden
      >
        <svg width={size} height={size} viewBox="0 0 14 14">
          {v === 0 || v === 3 ? (
            <>
              {v === 0 ? (
                <>
                  <circle cx="4.7" cy="5.4" r="0.95" fill="#fff" />
                  <circle cx="9.3" cy="5.4" r="0.95" fill="#fff" />
                </>
              ) : (
                <>
                  <path d="M 3.9 5.1 C 3.9 4.3 4.9 4.2 5.1 4.9 C 5.3 4.2 6.3 4.3 6.3 5.1 C 6.3 5.8 5.1 6.6 5.1 6.6 C 5.1 6.6 3.9 5.8 3.9 5.1 Z" fill="#fff" />
                  <path d="M 7.9 5.1 C 7.9 4.3 8.9 4.2 9.1 4.9 C 9.3 4.2 10.3 4.3 10.3 5.1 C 10.3 5.8 9.1 6.6 9.1 6.6 C 9.1 6.6 7.9 5.8 7.9 5.1 Z" fill="#fff" />
                </>
              )}
              <path d="M 4.4 8.4 Q 7 10.9 9.6 8.4" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" fill="none" />
            </>
          ) : v === 1 ? (
            <>
              <circle cx="4.7" cy="5.6" r="0.95" fill="#fff" />
              <circle cx="9.3" cy="5.6" r="0.95" fill="#fff" />
              <path d="M 4.6 10.4 Q 7 8.2 9.4 10.4" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" fill="none" />
            </>
          ) : v === 2 ? (
            <>
              <path d="M 4.5 3.9 L 4.5 6.1" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
              <path d="M 9.5 3.9 L 9.5 6.1" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
              <path d="M 5.8 10.2 L 8.2 10.2" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
            </>
          ) : (
            <>
              <circle cx="4.7" cy="5.6" r="0.95" fill="#fff" />
              <circle cx="9.3" cy="5.6" r="0.95" fill="#fff" />
              <path d="M 4.6 5.2 Q 5.1 5.9 5.6 5.2" stroke="#fff" strokeWidth="0.9" strokeLinecap="round" fill="none" />
              <path d="M 8.4 5.2 Q 8.9 5.9 9.4 5.2" stroke="#fff" strokeWidth="0.9" strokeLinecap="round" fill="none" />
              <circle cx="7" cy="9.2" r="1.6" fill="#fff" />
            </>
          )}
        </svg>
      </span>
    );
  }
  if (def.kind === 'pie') {
    return (
      <span
        className="marker-chip-badge"
        style={{ width: size, height: size, background: def.color, borderRadius: '50%', fontSize, color: '#fff', lineHeight: `${size}px` }}
        aria-hidden
      >
        ✓
      </span>
    );
  }
  // text/star/heart/flag/arrow/emoji 等：字符本色渲染（emoji 字形自带彩色）。
  const fg = def.chipFg === 'color' ? def.color : def.color === '#ffffff' ? undefined : def.color;
  return (
    <span className="marker-chip-glyph" style={{ fontSize: Math.round(size * 0.86), color: fg }} aria-hidden>
      {def.text ?? def.value}
    </span>
  );
}

export type MarkerTab = 'icon' | 'emoji';

export interface MarkerPanelProps {
  /** 选中集标记回显（交集口径：组→全部选中节点共有的值数组），页面侧算好。 */
  icons: Partial<Record<IconGroup, string[]>>;
  /** 选中节点数（0 = 无选中禁用态 + 提示；≥1 单选/多选皆可批量应用）。 */
  selectedCount: number;
  /** 写入回调：点标记上抛（批量方向「全含则移除否则设置」由页面侧展开）。 */
  onSetIcon: (group: IconGroup, value: string) => void;
  /** 当前页签（受控：由插入下拉「图标/表情」项决定初始页）。 */
  tab: MarkerTab;
  onTabChange: (tab: MarkerTab) => void;
  onClose: () => void;
  /** 相对 .insert-wrap 左缘的水平偏移（px）：右缘越界钳制时为负，把面板收回视口。 */
  offsetLeft?: number;
}

/** 图标页组序（表情组独占第二页）。 */
const ICON_PAGE_GROUPS = ['mood', 'priority', 'number', 'arrow', 'flag', 'progress', 'other'] as const;

export function MarkerPanel(props: MarkerPanelProps): ReactElement {
  const { icons, selectedCount, onSetIcon, tab, onTabChange, onClose, offsetLeft = 0 } = props;
  const disabled = selectedCount === 0;

  const markerButton = (group: IconGroup, def: MarkerGlyphDef): ReactElement => {
    const active = icons[group]?.includes(def.value) ?? false;
    return (
      <button
        key={def.value}
        type="button"
        data-testid={`marker-${group}-${def.value}`}
        title={def.label}
        aria-label={def.label}
        aria-pressed={active}
        disabled={disabled}
        className={active ? 'marker-btn active' : 'marker-btn'}
        onClick={() => onSetIcon(group, def.value)}
      >
        <MarkerChip def={def} />
      </button>
    );
  };

  return (
    <div
      className="marker-panel"
      data-testid="marker-panel"
      role="dialog"
      aria-label="节点标记"
      style={offsetLeft !== 0 ? { left: offsetLeft } : undefined}
    >
      <div className="marker-panel-head">
        <h3 className="marker-panel-title">{tab === 'icon' ? '图标' : '表情'}</h3>
        <button
          type="button"
          className="marker-panel-close"
          data-testid="marker-panel-close"
          aria-label="关闭标记面板"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="marker-tabs" role="tablist" aria-label="标记类型">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'icon'}
          data-testid="marker-tab-icon"
          className={tab === 'icon' ? 'marker-tab active' : 'marker-tab'}
          onClick={() => onTabChange('icon')}
        >
          图标
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'emoji'}
          data-testid="marker-tab-emoji"
          className={tab === 'emoji' ? 'marker-tab active' : 'marker-tab'}
          onClick={() => onTabChange('emoji')}
        >
          表情
        </button>
      </div>
      {disabled && (
        <p className="marker-hint" data-testid="marker-hint">
          选中节点后添加标记
        </p>
      )}
      {tab === 'icon' ? (
        <div className="marker-panel-body" data-testid="marker-icon-page">
          {ICON_PAGE_GROUPS.map((group) => (
            <section className="marker-group" key={group} data-testid={`marker-group-${group}`}>
              <em className="marker-group-label">{MARKER_GROUP_LABELS[group]}</em>
              <div className="marker-grid">
                {(MARKER_CATALOG[group] as readonly MarkerGlyphDef[]).map((def) =>
                  markerButton(group as IconGroup, def),
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="marker-panel-body" data-testid="marker-emoji-page">
          <section className="marker-group" data-testid="emoji-picker" role="group" aria-label="表情选择">
            <div className="marker-grid">
              {(MARKER_CATALOG.emoji as readonly MarkerGlyphDef[]).map((def) =>
                markerButton('emoji', def),
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
