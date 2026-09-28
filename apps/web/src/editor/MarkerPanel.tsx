import type { ReactElement } from 'react';
import type { IconGroup, NodeSnapshot } from '@gmind/core';
import './marker-panel.css';

/**
 * 节点标记面板（M7a-T1 内容切换，2026-09-28 需求方裁定「功能冲突以 mindgrid 为准」）。
 *
 * 形态维持 2483652 版：**右侧固定抽屉**（对齐 ThemePanel/格式面板形态），顶部
 * 「图标 / 表情」页签——插入下拉的两并列项分别以对应页签打开；容器 testid
 * （marker-panel-close/marker-tab-icon/marker-tab-emoji/marker-icon-page/
 * marker-emoji-page）全部保留。
 *
 * 内容切 mindgrid 三组制：图标页 = 优先级（1-7 彩色数字方块）+ 图标（10 个符号）；
 * 表情页 = 10 个 emoji。旧五组（进度/旗帜/星标）内容移除——status/progress 迁入
 * 节点任务字段（M7a 后续任务交付编辑 UI）。
 *
 * 语义沿用冻结口径：组内单选（同值再点=取消 null）、组间并存、aria-pressed
 * 按选中节点回显、无选中禁用+提示。写入经 onSetIcon 上抛（origin 纪律不变），
 * 值域与 core 常量一致（setIcon 目录校验的后端）。
 */

/** 优先级 1-7 方块配色（mindgrid --c-priority-1..7 原值，与 engine 渲染层同源取值）。
 *  导出供 TaskTable 标题列标记展示复用（M7a-T4，单一来源防漂移）。 */
export const PRIORITY_COLORS = ['#d9534f', '#d98841', '#d9a441', '#4d9960', '#7aa2f7', '#bb9af7', '#8a8a8a'];

/** 优先级 1-7（值 = core PRIORITY_VALUES；slug 即数字本身）。 */
const PRIORITY_MARKERS = PRIORITY_COLORS.map((color, i) => ({
  value: String(i + 1),
  slug: String(i + 1),
  label: `优先级 ${i + 1}`,
  color,
}));

/** 图标组 10 个（值 = core ICON_VALUES；字形与 engine ICON_GLYPHS 一致）。
 *  导出供 TaskTable 标题列标记展示复用（M7a-T4）。 */
export const ICON_MARKERS = [
  { value: 'done', glyph: '✓', label: '完成' },
  { value: 'cancel', glyph: '✗', label: '取消' },
  { value: 'important', glyph: '★', label: '重要' },
  { value: 'flag', glyph: '⚑', label: '旗帜' },
  { value: 'question', glyph: '?', label: '疑问' },
  { value: 'alert', glyph: '!', label: '注意' },
  { value: 'idea', glyph: '💡', label: '想法' },
  { value: 'like', glyph: '♥', label: '喜欢' },
  { value: 'link', glyph: '🔗', label: '关联' },
  { value: 'clock', glyph: '⏰', label: '提醒' },
];

/** 表情组 10 个（值 = core EMOJI_VALUES，与 mindgrid MARKER_GROUPS.emoji 完全一致）。 */
const EMOJI_MARKERS = ['😄', '🙂', '😐', '😟', '😢', '😠', '😴', '🤔', '👍', '👎'];

export type MarkerTab = 'icon' | 'emoji';

export interface MarkerPanelProps {
  /** 当前选中节点快照（回显数据源）；无选中为 null → 禁用态。 */
  selected: NodeSnapshot | null;
  /** 写入回调：value=新值；null=取消（同值再点）。 */
  onSetIcon: (group: IconGroup, value: string | null) => void;
  /** 当前页签（受控：由插入下拉「图标/表情」项决定初始页）。 */
  tab: MarkerTab;
  onTabChange: (tab: MarkerTab) => void;
  onClose: () => void;
}

export function MarkerPanel(props: MarkerPanelProps): ReactElement {
  const { selected, onSetIcon, tab, onTabChange, onClose } = props;
  const disabled = !selected || selected.deleted;
  const icons = selected?.icons ?? {};

  const markerButton = (
    group: IconGroup,
    value: string,
    slug: string,
    label: string,
    children: ReactElement,
  ): ReactElement => {
    const active = icons[group] === value;
    return (
      <button
        key={slug}
        type="button"
        data-testid={`marker-${group}-${slug}`}
        title={label}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        className={active ? 'marker-btn active' : 'marker-btn'}
        onClick={() => onSetIcon(group, active ? null : value)}
      >
        {children}
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
          <div className="marker-group" data-testid="marker-group-priority">
            <em className="marker-group-label">优先级</em>
            <div className="marker-grid">
              {PRIORITY_MARKERS.map((m) =>
                markerButton(
                  'priority', m.value, m.slug, m.label,
                  <span className="marker-priority-badge" style={{ background: m.color }}>
                    {m.value}
                  </span>,
                ),
              )}
            </div>
          </div>
          <div className="marker-group" data-testid="marker-group-icon">
            <em className="marker-group-label">图标</em>
            <div className="marker-grid">
              {ICON_MARKERS.map((m) =>
                markerButton('icon', m.value, m.value, `图标-${m.label}`, <span>{m.glyph}</span>),
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="marker-panel-body" data-testid="marker-emoji-page">
          <div className="marker-emoji-body" data-testid="emoji-picker" role="group" aria-label="表情选择">
            <div className="emoji-grid">
              {EMOJI_MARKERS.map((ch) => {
                const active = icons.emoji === ch;
                return (
                  <button
                    key={ch}
                    type="button"
                    data-testid={`marker-emoji-${ch}`}
                    title={`表情 ${ch}`}
                    aria-label={`表情 ${ch}`}
                    aria-pressed={active}
                    disabled={disabled}
                    className={active ? 'emoji-cell active' : 'emoji-cell'}
                    onClick={() => onSetIcon('emoji', active ? null : ch)}
                  >
                    {ch}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
