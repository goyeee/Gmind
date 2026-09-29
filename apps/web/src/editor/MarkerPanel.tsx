import type { ReactElement } from 'react';
import { MARKER_GROUP_MODE, type IconGroup, type NodeSnapshot } from '@gmind/core';
import { MARKER_CATALOG, MARKER_GROUP_LABELS, type MarkerGlyphDef } from '@gmind/engine';
import './marker-panel.css';

/**
 * 节点标记面板（M7b-W1 目录扩容：企微全量八组制 + 多值激活态）。
 *
 * 形态维持 M7a 版右侧固定抽屉（W3 才做企微式竖层重做，本任务只换内容与激活态）：
 * 顶部「图标 / 表情」页签——图标页 = 心情/优先级/数字/箭头/旗帜/进程/其他 七组
 * （MARKER_CATALOG 逐值渲染彩色 chip）；表情页 = 28 枚 emoji。容器 testid
 * （marker-panel-close/marker-tab-icon/marker-tab-emoji/marker-icon-page/
 * marker-emoji-page）与逐值 testid `marker-{group}-{slug}` 全部保留。
 *
 * 语义（M7b-W1 组语义常量）：single 组（心情/优先级/数字/箭头/旗帜/进程）组内
 * 单选替换——同值再点发 null 移除该组；multi 组（其他/表情）toggle——同值再点发
 * 同值，core setIcon 按「已存在则移除该枚」处理。aria-pressed 按选中节点组值数组
 * includes 回显；无选中禁用+提示。写入经 onSetIcon 上抛（origin 纪律不变），值域
 * 与 core 常量一致（setIcon 目录校验的后端）。
 */

/** chip 几何（与 engine 徽标同 14px 视觉族；彩色圆徽/方块/三角 + 文字或字符）。 */
function MarkerChip({ def, size = 18 }: { def: MarkerGlyphDef; size?: number }): ReactElement {
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
  /** 当前选中节点快照（回显数据源）；无选中为 null → 禁用态。 */
  selected: NodeSnapshot | null;
  /** 写入回调：value=新值（multi 组 toggle，single 组替换）；null=移除该组。 */
  onSetIcon: (group: IconGroup, value: string | null) => void;
  /** 当前页签（受控：由插入下拉「图标/表情」项决定初始页）。 */
  tab: MarkerTab;
  onTabChange: (tab: MarkerTab) => void;
  onClose: () => void;
}

/** 图标页组序（表情组独占第二页）。 */
const ICON_PAGE_GROUPS = ['mood', 'priority', 'number', 'arrow', 'flag', 'progress', 'other'] as const;

export function MarkerPanel(props: MarkerPanelProps): ReactElement {
  const { selected, onSetIcon, tab, onTabChange, onClose } = props;
  const disabled = !selected || selected.deleted;
  const icons = selected?.icons ?? {};

  const markerButton = (group: IconGroup, def: MarkerGlyphDef): ReactElement => {
    const active = icons[group]?.includes(def.value) ?? false;
    const single = MARKER_GROUP_MODE[group] === 'single';
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
        onClick={() => onSetIcon(group, single && active ? null : def.value)}
      >
        <MarkerChip def={def} />
      </button>
    );
  };

  return (
    <div className="marker-panel" data-testid="marker-panel" role="dialog" aria-label="节点标记">
      <div className="marker-panel-header">
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
      </div>
      {disabled && (
        <p className="marker-hint" data-testid="marker-hint">
          选中节点后添加标记
        </p>
      )}
      {tab === 'icon' ? (
        <div className="marker-panel-body" data-testid="marker-icon-page">
          {ICON_PAGE_GROUPS.map((group) => (
            <div className="marker-group" key={group} data-testid={`marker-group-${group}`}>
              <em className="marker-group-label">{MARKER_GROUP_LABELS[group]}</em>
              <div className="marker-grid">
                {(MARKER_CATALOG[group] as readonly MarkerGlyphDef[]).map((def) => markerButton(group as IconGroup, def))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="marker-panel-body" data-testid="marker-emoji-page">
          <div className="marker-emoji-body" data-testid="emoji-picker" role="group" aria-label="表情选择">
            <div className="emoji-grid">
              {(MARKER_CATALOG.emoji as readonly MarkerGlyphDef[]).map((def) => markerButton('emoji', def))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
