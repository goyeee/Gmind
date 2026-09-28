import { useState, type ReactElement } from 'react';
import type { IconGroup, NodeSnapshot } from '@gmind/core';
import './marker-panel.css';

/**
 * 节点标记面板（2026-09-28 二次改版，需求方裁定）：**右侧固定抽屉**（对齐
 * ThemePanel/格式面板形态），顶部「图标 / 表情」页签切换——插入下拉的两个并列
 * 项「图标」「表情」分别以对应页签打开。图标页四组竖排（优先级/进度/旗帜/
 * 星标，组名左列+网格自动换行，无横向滚动）；表情页三分类 tab + 网格。
 *
 * 语义沿用冻结口径：组内单选（同值再点=取消 null）、组间并存、aria-pressed
 * 按选中节点回显、无选中禁用+提示。写入经 onSetIcon 上抛（origin 纪律不变）。
 */

/** 静态表情表：三类（表情/手势/符号），每类 24 个（M6 T5 原表迁移）。 */
const EMOJI_CATEGORIES: ReadonlyArray<{ name: string; emojis: readonly string[] }> = [
  {
    name: '表情',
    emojis: [
      '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😜',
      '🤔', '😏', '😢', '😭', '😡', '🤯', '🥳', '😴',
      '🤒', '🥺', '😎', '🤩', '😔', '😅', '😬', '🤗',
    ],
  },
  {
    name: '手势',
    emojis: [
      '👍', '👎', '👌', '✌️', '🤞', '👏', '🙌', '🤝',
      '🙏', '💪', '👋', '🤙', '✋', '🖖', '👇', '👆',
      '👉', '👈', '☝️', '🤟', '👊', '🤛', '🖐️', '🙋',
    ],
  },
  {
    name: '符号',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
      '💯', '✅', '❌', '⭐', '🌟', '⚡', '🔥', '💧',
      '🎉', '🎊', '🚀', '🏁', '⏰', '📌', '🔔', '❗',
    ],
  },
];

/** 标记按钮 testid：`marker-{group}-{slug}`（值域/映射与 6bc0d4b 一致，未动）。 */
const PRIORITY_MARKERS = Array.from({ length: 9 }, (_, i) => ({
  value: `p${i + 1}`,
  slug: `p${i + 1}`,
  label: `优先级 ${i + 1}`,
}));

const PROGRESS_MARKERS = ['0%', '10%', '25%', '40%', '50%', '60%', '75%', '100%'].map((s) => ({
  value: s,
  slug: s.replace('%', ''),
  label: `进度 ${s}`,
}));

const FLAG_MARKERS = [
  { value: '红', slug: 'flag-red', color: '#f53f3f' },
  { value: '蓝', slug: 'flag-blue', color: '#3370ff' },
  { value: '绿', slug: 'flag-green', color: '#00b42a' },
  { value: '黄', slug: 'flag-yellow', color: '#f7ba1e' },
  { value: '紫', slug: 'flag-purple', color: '#722ed1' },
  { value: '橙', slug: 'flag-orange', color: '#ff8800' },
];

const STAR_MARKERS = [
  { value: '红', slug: 'star-red', color: '#f53f3f' },
  { value: '蓝', slug: 'star-blue', color: '#3370ff' },
  { value: '绿', slug: 'star-green', color: '#00b42a' },
  { value: '黄', slug: 'star-yellow', color: '#f7ba1e' },
  { value: '紫', slug: 'star-purple', color: '#722ed1' },
];

/** 优先级圆徽配色：1-3 蓝 / 4-6 橙 / 7-9 红（企微范式）。 */
const PRIORITY_BADGE_COLORS = ['#3370ff', '#ff8800', '#f53f3f'];

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

/** 进度圆环图标（18×18 SVG：灰底环 + 蓝弧按百分比扫过）。 */
function ProgressRing({ pct }: { pct: number }): ReactElement {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="#e5e6eb" strokeWidth="2.6" />
      {pct > 0 && (
        <circle
          cx="9" cy="9" r={r} fill="none" stroke="#3370ff" strokeWidth="2.6"
          strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 9 9)"
        />
      )}
    </svg>
  );
}

export function MarkerPanel(props: MarkerPanelProps): ReactElement {
  const { selected, onSetIcon, tab, onTabChange, onClose } = props;
  const [emojiTab, setEmojiTab] = useState(EMOJI_CATEGORIES[0]!.name);
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

  const currentEmoji = EMOJI_CATEGORIES.find((c) => c.name === emojiTab) ?? EMOJI_CATEGORIES[0]!;

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
              {PRIORITY_MARKERS.map((m, i) =>
                markerButton(
                  'priority', m.value, m.slug, m.label,
                  <span
                    className="marker-priority-badge"
                    style={{ background: PRIORITY_BADGE_COLORS[Math.min(Math.floor(i / 3), 2)] }}
                  >
                    {i + 1}
                  </span>,
                ),
              )}
            </div>
          </div>
          <div className="marker-group" data-testid="marker-group-progress">
            <em className="marker-group-label">进度</em>
            <div className="marker-grid">
              {PROGRESS_MARKERS.map((m) =>
                markerButton('progress', m.value, m.slug, m.label, <ProgressRing pct={Number(m.value.slice(0, -1))} />),
              )}
            </div>
          </div>
          <div className="marker-group" data-testid="marker-group-flag">
            <em className="marker-group-label">旗帜</em>
            <div className="marker-grid">
              {FLAG_MARKERS.map((m) =>
                markerButton('flag', m.value, m.slug, `旗帜-${m.value}`, <span style={{ color: m.color }}>⚑</span>),
              )}
            </div>
          </div>
          <div className="marker-group" data-testid="marker-group-star">
            <em className="marker-group-label">星标</em>
            <div className="marker-grid">
              {STAR_MARKERS.map((m) =>
                markerButton('star', m.value, m.slug, `星标-${m.value}`, <span style={{ color: m.color }}>★</span>),
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="marker-panel-body" data-testid="marker-emoji-page">
          <div className="marker-emoji-body" data-testid="emoji-picker" role="group" aria-label="表情选择">
            <div className="emoji-tabs" role="tablist" aria-label="表情分类">
              {EMOJI_CATEGORIES.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  role="tab"
                  aria-selected={c.name === emojiTab}
                  data-testid={`emoji-tab-${c.name}`}
                  className={c.name === emojiTab ? 'emoji-tab active' : 'emoji-tab'}
                  onClick={() => setEmojiTab(c.name)}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <div className="emoji-grid">
              {currentEmoji.emojis.map((ch) => {
                const active = icons.emoji === ch;
                return (
                  <button
                    key={ch}
                    type="button"
                    data-testid={`emoji-item-${ch}`}
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
