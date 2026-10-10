import type { ReactElement } from 'react';
import type { IconGroup } from '@gmind/core';
import { MARKER_CATALOG, MARKER_GROUP_LABELS, drawMarkerBadge, type MarkerGlyphDef } from '@gmind/engine';
import './marker-panel.css';

/**
 * 节点标记面板（M7b-W3 企微式竖层重做，需求方原话「竖着的贴近右侧的层、内部分组、
 * 顶部按钮点开、不要固定在右侧」）。
 *
 * 形态：**锚定弹出层**——2026-10-10 插入菜单删除后改 position:fixed 视口定位
 * （left/top=调用方锚点，页面侧右缘越界钳制；锚点=TaskPanel「在标记面板中编辑」
 * 按钮下沿），向下展开；宽 340px、max-height 70vh 内部滚动。
 * 顶部「图标」/「表情」标题 + 分段页签（图标|表情）+ 右上角 ×（企微截图同构）。
 *
 * 内容（M7b-W1 目录单源，不手抄）：图标页 = 心情/优先级/数字/箭头/旗帜/进度/其他
 * 七组竖排（组名左上小字 + 图标行，MARKER_CATALOG 逐值渲染彩色 chip）；表情页 =
 * 28 枚 emoji 平铺网格。容器 testid（marker-panel-close/marker-tab-icon/
 * marker-tab-emoji/marker-icon-page/marker-emoji-page/marker-group-*）与逐值
 * testid `marker-{group}-{slug}` 全部保留。
 *
 * 语义（M7b-W1 组语义常量 + W3 批量）：single 组（心情/优先级/数字/箭头/旗帜/进度）
 * 组内单选替换；multi 组（其他/表情）组内多选叠加。回显 = 选中集**交集口径**
 * （全含才亮，页面侧算好传入）；无选中禁用 + 提示；有选中（单选/多选）即可点，
 * 点标记 = 批量应用（「全含则移除否则设置」在页面侧 applyMarker 展开，一次性事务）。
 * aria-pressed 按交集回显。写入经 onSetIcon 上抛（origin 纪律不变）。
 */

/**
 * chip 几何（M7b-R1 重做）：直接复用 engine drawMarkerBadge 的 SVG 徽章——
 * 面板与画布字形**单一来源**（此前手写 CSS chip 缺 mood/star/bulb 等自定义
 * kind 的分支，回落显示英文 slug；且 flex 压缩把圆徽压瘪）。SVG 按 size 缩放。
 * 2026-10-01 需求方反馈任务 1 起表格标题格（TaskTable NodeMarkers）同用本组件
 * （size=14），三处字形单一来源；可选 title/data-marker-* 仅表格侧传。
 */
/** 可选定位属性（2026-10-01 需求方反馈任务 1：表格标题格标记单源化复用本组件）：
 *  title=HTML 悬停提示（徽章 SVG <title> 已原生同文案，此处在 DOM 侧补锚点）；
 *  markerGroup/markerValue → data-marker-group/value（与画布 g.gm-marker-badge
 *  同名属性，表格/画布/e2e 同口径定位）。面板自身不传——零行为变化。 */
export function MarkerChip({
  def,
  size = 18,
  title,
  markerGroup,
  markerValue,
}: {
  def: MarkerGlyphDef;
  size?: number;
  title?: string;
  markerGroup?: string;
  markerValue?: string;
}): ReactElement {
  return (
    <span
      className="marker-chip-svg"
      style={{ width: size, height: size, display: 'inline-block', flex: 'none' }}
      aria-hidden
      title={title}
      data-marker-group={markerGroup}
      data-marker-value={markerValue}
      ref={(el) => {
        if (!el || el.firstElementChild) return;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 14 14');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        const badge = drawMarkerBadge(def);
        if (badge) {
          badge.removeAttribute('class');
          svg.appendChild(badge);
        }
        el.appendChild(svg);
      }}
    />
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
  /**
   * 面板 fixed 定位（2026-10-10 插入菜单删除后改视口锚定）：最终屏幕坐标
   * （left 已经页面侧右缘钳制）。锚点=调用方按钮下沿/点击点。
   */
  position: { left: number; top: number };
}

/** 图标页组序（表情组独占第二页）。 */
const ICON_PAGE_GROUPS = ['mood', 'priority', 'number', 'arrow', 'flag', 'progress', 'other'] as const;

export function MarkerPanel(props: MarkerPanelProps): ReactElement {
  const { icons, selectedCount, onSetIcon, tab, onTabChange, onClose, position } = props;
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
      style={{
        left: position.left,
        top: position.top,
        // 下缘视口钳制（2026-10-10 fixed 锚定配套）：锚点在右列中部时 70vh 会探出
        // 视口底缘（内部滚动也难到达末组），按锚点收敛可用高。
        maxHeight: `calc(100vh - ${Math.max(0, position.top) + 8}px)`,
      }}
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
