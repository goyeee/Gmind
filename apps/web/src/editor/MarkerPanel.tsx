import { useState, type ReactElement } from 'react';
import type { IconGroup, NodeSnapshot } from '@gmind/core';
import './marker-panel.css';

/**
 * 节点标记面板（2026-09-28，企微标记面板对标）：插入菜单「标记」项从菜单**右侧
 * 展开的一层宽面板**——四组标记竖排（优先级圆徽 / 进度圆环 / 彩旗 / 彩星，每行
 * 组名左列窄栏 + 图标横排网格），下方表情区带分类 tab + 网格。
 *
 * 纯 UI 迁移（数据模型零改动）：RichPanel 图标区整体搬入，语义沿用 M6 T5 冻结
 * 口径——组内单选（同值再点 = setIcon null 取消）、组间并存（priority/progress/
 * flag/star/emoji 五组互不影响）；回显按当前选中节点 icons 设 aria-pressed；
 * 无选中节点 → 面板禁用 + 提示「选中节点后添加标记」（与 T2 样式区联动同口径）。
 *
 * 写入不经本组件：onSetIcon 回调上抛 EditorPage 统一走 setIcon + afterUserWrite
 * （origin / capUndoStack 既有纪律）。表情区数据与 testid（emoji-picker /
 * emoji-tab-{name} / emoji-item-{char}）自 EmojiPicker.tsx 原样迁移（M6 T5 契约
 * 不变；原锚点弹层组件随 RichPanel 图标区删除而退役）。
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

/**
 * 标记按钮 testid 后缀（slug）：`marker-{group}-{slug}`。优先级/进度沿用既有
 * ASCII 值（p1…p9 / 去百分号数字）；旗帜/星标按「组名-颜色」slug（旗帜红 =
 * marker-flag-flag-red），与 setIcon 存储值（红/蓝/…）的映射见表列 value。
 */
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

/** 优先级圆徽配色：1-3 蓝 / 4-6 橙 / 7-9 红（低中高三档，企微范式）。 */
const PRIORITY_BADGE_COLORS = ['#3370ff', '#ff8800', '#f53f3f'];

export interface MarkerPanelProps {
  /** 当前选中节点快照（回显数据源）；无选中（空选区/多选/已删）为 null → 禁用态。 */
  selected: NodeSnapshot | null;
  /** 写入回调：value=新值；null=取消（同值再点）。写入纪律由调用方承担。 */
  onSetIcon: (group: IconGroup, value: string | null) => void;
}

/** 进度圆环图标（18×18 SVG：灰底环 + 蓝弧按百分比扫过，0% 只余底环）。 */
function ProgressRing({ pct }: { pct: number }): ReactElement {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="#e5e6eb" strokeWidth="2.6" />
      {pct > 0 && (
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="#3370ff"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform="rotate(-90 9 9)"
        />
      )}
    </svg>
  );
}

export function MarkerPanel(props: MarkerPanelProps): ReactElement {
  const { selected, onSetIcon } = props;
  const [emojiTab, setEmojiTab] = useState(EMOJI_CATEGORIES[0]!.name);
  // 无选中（空选区/多选/已删）：面板禁用 + 提示（T2 样式区联动同口径）
  const disabled = !selected || selected.deleted;
  const icons = selected?.icons ?? {};

  /** 标记按钮：aria-pressed 回显当前组值；点击=设值，同值再点=取消（null）。 */
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
      {disabled && (
        <p className="marker-hint" data-testid="marker-hint">
          选中节点后添加标记
        </p>
      )}
      <div className="marker-group" data-testid="marker-group-priority">
        <em className="marker-group-label">优先级</em>
        <div className="marker-grid">
          {PRIORITY_MARKERS.map((m, i) =>
            markerButton(
              'priority',
              m.value,
              m.slug,
              m.label,
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
      <div className="marker-group marker-emoji-group" data-testid="marker-group-emoji">
        <em className="marker-group-label">表情</em>
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
    </div>
  );
}
