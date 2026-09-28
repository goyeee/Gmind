import { useEffect, useRef, useState, type ReactElement } from 'react';
import './rich-panel.css';

/**
 * emoji 表情面板（M6 Task 5 企微对标）：图标体系扩展 emoji 组的选择弹层。
 *
 * 语义（冻结）：emoji 为独立图标组——选中=setIcon(doc, id, 'emoji', char)（组内
 * 单选，再点同 emoji=取消 null），与 priority/flag 等并存互不影响。面板只负责
 * 展示与回调，写入统一走 RichPanel 的 write（origin/capUndoStack 既有纪律）。
 *
 * 定位：弹层挂在 body 流之外的 fixed 层（rich-panel 是 overflow-y:auto 滚动容器，
 * absolute 弹层会被裁剪）——按锚点 rect 计算落于锚点下方，视口不足翻到上方；
 * 滚动/缩放时随锚点重算。Esc / 弹层与锚点之外任一点 = 关闭。
 */

/** 静态表情表：三类（表情/手势/符号），每类 24 个。 */
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

export interface EmojiPickerProps {
  /** 锚点元素（「表情」触发钮）：弹层定位于其下方。 */
  anchor: HTMLElement;
  /** 当前节点 emoji 组的值（无则 undefined）——回显选中态。 */
  selected: string | undefined;
  /** 选中/取消回调：char=新 emoji；null=取消（再点同 emoji）。 */
  onPick: (char: string | null) => void;
  onClose: () => void;
}

export function EmojiPicker(props: EmojiPickerProps): ReactElement {
  const { anchor, selected, onPick, onClose } = props;
  const [tab, setTab] = useState(EMOJI_CATEGORIES[0]!.name);
  const popRef = useRef<HTMLDivElement>(null);

  // 定位：锚点下方，视口放不下翻上方；滚动/缩放时随锚点重算。
  useEffect(() => {
    const place = (): void => {
      const pop = popRef.current;
      if (!pop) return;
      const r = anchor.getBoundingClientRect();
      const h = pop.offsetHeight || 176;
      const top = r.bottom + 6 + h <= window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8));
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    };
    place();
    window.addEventListener('resize', place);
    // capture：面板容器滚动也重算（fixed 层不随滚动容器走）。
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [anchor, tab]);

  // Esc 关闭 + 外点关闭（弹层与锚点之外；锚点自身走触发钮 toggle）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [anchor, onClose]);

  const current = EMOJI_CATEGORIES.find((c) => c.name === tab) ?? EMOJI_CATEGORIES[0]!;

  return (
    <div className="emoji-picker-pop" data-testid="emoji-picker" role="dialog" aria-label="表情选择" ref={popRef}>
      <div className="emoji-tabs" role="tablist" aria-label="表情分类">
        {EMOJI_CATEGORIES.map((c) => (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={c.name === tab}
            data-testid={`emoji-tab-${c.name}`}
            className={c.name === tab ? 'emoji-tab active' : 'emoji-tab'}
            onClick={() => setTab(c.name)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="emoji-grid">
        {current.emojis.map((ch) => {
          const active = selected === ch;
          return (
            <button
              key={ch}
              type="button"
              data-testid={`emoji-item-${ch}`}
              title={`表情 ${ch}`}
              aria-label={`表情 ${ch}`}
              aria-pressed={active}
              className={active ? 'emoji-cell active' : 'emoji-cell'}
              onClick={() => onPick(active ? null : ch)}
            >
              {ch}
            </button>
          );
        })}
      </div>
    </div>
  );
}
