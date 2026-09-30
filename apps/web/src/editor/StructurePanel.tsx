import type { ReactElement } from 'react';
import './structure-panel.css';

/**
 * 结构切换图形化面板 — 2026-09-30 需求方四条 UI 反馈之任务 3（对齐企微/主题面板）：
 * 工具栏「结构」按钮（structure-toggle）点开的缩略图选择面板，替代原
 * structure-select 下拉（testid 契约同步适配 e2e）。
 *
 * - 面板骨架/定位复用 ThemePanel 模式（编辑器右上角工具栏下方 fixed 浮层，
 *   open=false 整棵不渲染；头部标题 + × 关闭，Esc/外点关闭由 EditorPage 侧装配）；
 * - 三张卡片各带纯 SVG 手绘迷你缩略图：思维导图=中心主题右侧两级曲线子主题；
 *   逻辑图（向右）=单侧纵向层级直角连线；组织架构图=自上而下树+横排兄弟；
 * - 当前结构卡片高亮描边（aria-pressed）；点击即应用（EditorPage 侧 setDocMeta
 *   structureType 既有写链路，可撤销）并收起面板；
 * - testid：structure-panel / structure-panel-close / structure-item-{value}。
 */

/** 结构类型（与 @gmind/core setDocMeta structureType 同一口径）。 */
export type StructureTypeValue = 'mindmap' | 'logic' | 'org';

const STRUCTURE_CARDS: { value: StructureTypeValue; label: string }[] = [
  { value: 'mindmap', label: '思维导图' },
  { value: 'logic', label: '逻辑图（向右）' },
  { value: 'org', label: '组织架构图' },
];

/** 手绘缩略图公共笔触：节点盒描边 #4e5969、填充浅灰，连线 #3370ff 主题蓝。 */
const BOX = { fill: '#f2f3f5', stroke: '#4e5969' } as const;
const LINE = { fill: 'none', stroke: '#3370ff', strokeWidth: 1.5 } as const;

/** 思维导图：中心主题 + 右侧两级曲线子主题。 */
function MindmapThumb() {
  return (
    <svg className="structure-thumb" viewBox="0 0 96 56" role="img" aria-hidden focusable="false">
      <path
        d="M 27 28 C 36 28 36 14 45 14 M 27 28 C 36 28 36 42 45 42 M 69 14 C 78 14 78 9 84 9"
        {...LINE}
      />
      <rect x="5" y="21" width="22" height="14" rx="3" {...BOX} strokeWidth="1.4" />
      <rect x="45" y="9" width="24" height="10" rx="2.5" {...BOX} />
      <rect x="45" y="37" width="24" height="10" rx="2.5" {...BOX} />
      <rect x="84" y="4.5" width="9" height="8" rx="2" {...BOX} />
    </svg>
  );
}

/** 逻辑图（向右）：单侧纵向层级 + 直角连线（根右侧一条竖干线分接三子，末子再挂孙）。 */
function LogicThumb() {
  return (
    <svg className="structure-thumb" viewBox="0 0 96 56" role="img" aria-hidden focusable="false">
      <path
        d="M 24 28 H 34 M 34 11 V 45 M 34 11 H 42 M 34 28 H 42 M 34 45 H 42 M 60 45 H 68 V 38 H 74"
        {...LINE}
      />
      <rect x="5" y="21" width="19" height="14" rx="3" {...BOX} strokeWidth="1.4" />
      <rect x="42" y="6" width="18" height="10" rx="2.5" {...BOX} />
      <rect x="42" y="23" width="18" height="10" rx="2.5" {...BOX} />
      <rect x="42" y="40" width="18" height="10" rx="2.5" {...BOX} />
      <rect x="74" y="33" width="16" height="9" rx="2.5" {...BOX} />
    </svg>
  );
}

/** 组织架构图：自上而下树 + 横排兄弟（根在下沿引一条总线，三兄弟横排挂线）。 */
function OrgThumb() {
  return (
    <svg className="structure-thumb" viewBox="0 0 96 56" role="img" aria-hidden focusable="false">
      <path d="M 48 18 V 26 M 20 26 H 76 M 20 26 V 34 M 48 26 V 34 M 76 26 V 34" {...LINE} />
      <rect x="38" y="5" width="20" height="13" rx="3" {...BOX} strokeWidth="1.4" />
      <rect x="11" y="34" width="18" height="11" rx="2.5" {...BOX} />
      <rect x="39" y="34" width="18" height="11" rx="2.5" {...BOX} />
      <rect x="67" y="34" width="18" height="11" rx="2.5" {...BOX} />
    </svg>
  );
}

const THUMBS: Record<StructureTypeValue, ReactElement> = {
  mindmap: <MindmapThumb />,
  logic: <LogicThumb />,
  org: <OrgThumb />,
};

export interface StructurePanelProps {
  open: boolean;
  /** 当前生效结构：对应卡片高亮描边（aria-pressed）。 */
  current: StructureTypeValue;
  onClose(): void;
  /** 应用结构：EditorPage 侧走 setDocMeta structureType（可撤销）并收起面板。 */
  onApply(value: StructureTypeValue): void;
}

export function StructurePanel({ open, current, onClose, onApply }: StructurePanelProps) {
  if (!open) return null;
  return (
    <aside className="structure-panel" data-testid="structure-panel" aria-label="结构选择">
      <header className="structure-panel-header">
        <span className="structure-panel-title">结构</span>
        <button
          type="button"
          className="structure-panel-close"
          data-testid="structure-panel-close"
          aria-label="关闭结构面板"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="structure-grid">
        {STRUCTURE_CARDS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={'structure-item' + (value === current ? ' current' : '')}
            data-testid={`structure-item-${value}`}
            aria-pressed={value === current}
            title={label}
            onClick={() => onApply(value)}
          >
            {THUMBS[value]}
            <span className="structure-item-label">{label}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
