import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import {
  childrenIds,
  docFromState,
  getMeta,
  getNode,
  ROOT_NODE_ID,
  subtreeIds,
} from '@gmind/core';
import {
  createScene,
  type DocReader,
  layout,
  type NodeVisual,
  renderScene,
  resolveNodeStyle,
  resolveThemeId,
  THEMES,
  type TextStyle,
  Viewport,
} from '@gmind/engine';
import { api, apiPost } from '../api/client';
import './version-panel.css';

/**
 * 版本历史面板 — M4 Task 8（FR-VER-004 UI：时间轴/只读预览/一键恢复）。
 *
 * 装配模式同 MemberPanel（EditorPage 持 open/onClose，关闭即整树卸载，下次打开
 * 重拉列表——恢复后的列表刷新同样由重新 GET 完成）。
 *
 * - 时间轴：GET /files/:id/versions → {items}（服务端 createdAt DESC，新→旧直渲染）。
 *   条目 = 时间（当天 HH:mm，跨日 MM-DD HH:mm）+ 类型徽标（auto='自动' /
 *   manual='手动' / pre_restore='恢复前存档'；restoredFrom 非空时徽标 title
 *   「恢复自某版本」）+ 触发人名（null 兜底 '—'）+ 节点数。
 * - 只读预览：点条目 → GET state(base64) → docFromState → 独立 Y.Doc 上按快照
 *   meta 的 theme/structure 走引擎 layout + renderScene 静态渲染（EditorPage 同款
 *   装配参数的极小复刻）；不装配手势/编辑器/任何监听——Viewport 只构造不 attach
 *   （构造不绑事件，见 engine viewport.ts），fit-to-view 一次成型。
 * - 一键恢复：confirm 绑定文案「当前内容将自动存档为「恢复前版本」，确定恢复到
 *   {时间} 的快照吗？」（{时间} 与条目展示同格式）→ POST restore → toast「已恢复」
 *   → 刷新列表（新 pre_restore 条目出现在顶部）；画布由服务端恢复事务经 y-sync
 *   广播自动更新（不 reload）。权限不前端判角色（一期 owner/editor 全员可恢复），
 *   服务端 404/401 由错误 message 透出 toast 兜底。
 *
 * 预览 Y.Doc 生命周期：openPreview 换预览/关预览/面板卸载三条路径都 destroy
 * （ref 收口 + unmount 兜底 effect，StrictMode 双调用安全——销毁走显式动作而非
 * effect cleanup）。
 */

interface VersionItem {
  id: string;
  nodeCount: number;
  type: 'auto' | 'manual' | 'pre_restore';
  createdAt: string;
  createdByName: string | null;
  restoredFrom: string | null;
}

/** 版本取态条目：state 为 base64（服务端唯一内容出口）。 */
interface VersionStateView extends VersionItem {
  state: string;
}

const TYPE_BADGE: Record<VersionItem['type'], string> = {
  auto: '自动',
  manual: '手动',
  pre_restore: '恢复前存档',
};

export interface VersionPanelProps {
  fileId: string;
  open: boolean;
  onClose(): void;
  /** toast 通道：复用 EditorPage 既有 toast（testid toast，role alert）。 */
  showToast(message: string): void;
}

/** 条目时间展示（confirm 文案同用此格式）：当天 HH:mm，跨日 MM-DD HH:mm。 */
function formatVersionTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const mo = String(at.getMonth() + 1).padStart(2, '0');
  const dd = String(at.getDate()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

// 单例测量适配器（EditorPage 同款：Canvas measureText）。
const measureCtx = document.createElement('canvas').getContext('2d');
const measure = {
  measureTextLine(text: string, style: TextStyle): number {
    if (!measureCtx) return text.length * style.fontSize;
    measureCtx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
    return measureCtx.measureText(text).width;
  },
};

/** 快照 doc → 只读 SVG 静态渲染（EditorPage 引擎装配的极小复刻，零交互）。
 *  createScene 自清空 svg 旧内容，可安全对同一 svg 重复调用。 */
function renderPreview(svg: SVGSVGElement, doc: Y.Doc): void {
  const scene = createScene(svg);
  // 视口包装层（EditorPage 同款）：边/节点两层须同包进单个 g 供 transform
  const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  wrapper.setAttribute('class', 'gm-viewport');
  wrapper.appendChild(scene.edgesLayer);
  wrapper.appendChild(scene.nodesLayer);
  svg.appendChild(wrapper);

  const reader: DocReader = {
    getMeta: () => getMeta(doc),
    getNode: (id) => getNode(doc, id),
    childrenIds: (id) => childrenIds(doc, id),
  };
  const m = getMeta(doc);
  const theme = THEMES[resolveThemeId(m.themeId)];
  svg.style.background = theme.canvasBackground;

  const result = layout(reader, {
    structure: m.structureType,
    theme,
    measure,
    styleOf: (id, depth) =>
      resolveNodeStyle(theme, depth, getNode(doc, id)?.style ?? {}).textStyle,
  });
  const depthById = new Map<string, number>();
  for (const b of result.nodes) depthById.set(b.id, b.depth);

  const nodeData = new Map<string, NodeVisual>();
  for (const id of subtreeIds(doc, ROOT_NODE_ID)) {
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) continue;
    nodeData.set(id, {
      text: snap.text,
      icons: snap.icons,
      note: snap.note,
      href: snap.href,
      image: snap.image,
    });
  }
  renderScene(scene, {
    layout: result,
    theme,
    styleOf: (id) =>
      resolveNodeStyle(theme, depthById.get(id) ?? 0, getNode(doc, id)?.style ?? {}),
    nodeData,
  });

  // fit-to-view：Viewport 构造只写 transform、不绑事件（attach 才绑），只读预览
  // 不 attach 即无滚轮/拖拽监听，无泄漏。
  const vp = new Viewport(svg, wrapper);
  vp.fit(result, { w: svg.clientWidth, h: svg.clientHeight });
}

export function VersionPanel({ fileId, open, onClose, showToast }: VersionPanelProps) {
  // null = 加载中；[] = 无版本。面板关闭即卸载，重开自然重拉（含恢复后的刷新）。
  const [items, setItems] = useState<VersionItem[] | null>(null);
  const [preview, setPreview] = useState<{ item: VersionItem; doc: Y.Doc } | null>(null);
  const previewSvgRef = useRef<SVGSVGElement | null>(null);
  // 预览 Y.Doc 收口：显式销毁走这三条路径（换预览/关预览/卸载兜底）
  const previewDocRef = useRef<Y.Doc | null>(null);
  // 预览请求序号：并发点击两条目时丢弃过期响应，关预览后同样使在途请求失效
  const previewSeqRef = useRef(0);
  // 回调 ref：toast 身份随父渲染变化，避免列表拉取 effect 依赖它而反复重发
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api<{ items: VersionItem[] }>(`/files/${fileId}/versions`)
      .then((r) => {
        if (alive) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (alive) {
          setItems([]);
          showToastRef.current(e instanceof Error ? e.message : '版本列表加载失败');
        }
      });
    return () => {
      alive = false;
    };
  }, [open, fileId]);

  // 卸载兜底：面板关闭/整树卸载时若预览仍开着，销毁其 Y.Doc（StrictMode 双调用安全）
  useEffect(() => {
    return () => {
      previewDocRef.current?.destroy();
      previewDocRef.current = null;
    };
  }, []);

  // 预览渲染 effect：preview 就绪后静态渲染一次（无监听，无需清理）
  useEffect(() => {
    if (!preview) return;
    const svg = previewSvgRef.current;
    if (!svg) return;
    renderPreview(svg, preview.doc);
  }, [preview]);

  const closePreview = (): void => {
    previewSeqRef.current += 1; // 使在途 openPreview 响应失效
    previewDocRef.current?.destroy();
    previewDocRef.current = null;
    setPreview(null);
  };

  const openPreview = async (item: VersionItem): Promise<void> => {
    const seq = ++previewSeqRef.current;
    try {
      const v = await api<VersionStateView>(`/files/${fileId}/versions/${item.id}`);
      if (seq !== previewSeqRef.current) return; // 过期响应：已被更新的预览/关闭取代
      // base64 → bytes → 独立 Y.Doc（docFromState 入口全量 normalize；只读不写）
      const bytes = Uint8Array.from(atob(v.state), (c) => c.charCodeAt(0));
      const doc = docFromState(bytes);
      previewDocRef.current?.destroy();
      previewDocRef.current = doc;
      setPreview({ item, doc });
    } catch (e) {
      if (seq === previewSeqRef.current) {
        showToastRef.current(e instanceof Error ? e.message : '版本读取失败');
      }
    }
  };

  const restore = async (item: VersionItem): Promise<void> => {
    // 绑定文案（brief）：{时间} 与条目展示同格式
    if (
      !window.confirm(
        `当前内容将自动存档为「恢复前版本」，确定恢复到 ${formatVersionTime(item.createdAt)} 的快照吗？`,
      )
    ) {
      return;
    }
    try {
      await apiPost(`/files/${fileId}/versions/${item.id}/restore`);
      showToastRef.current('已恢复');
      // 刷新列表：新 pre_restore 条目出现在顶部；画布由恢复广播自动更新（不 reload）
      const r = await api<{ items: VersionItem[] }>(`/files/${fileId}/versions`);
      setItems(r.items);
    } catch (e) {
      showToastRef.current(e instanceof Error ? e.message : '恢复失败');
    }
  };

  if (!open) return null;
  return (
    <aside className="version-panel" data-testid="version-panel">
      <header className="version-panel-header">
        <span className="version-panel-title">版本历史</span>
        <button
          type="button"
          className="version-panel-close"
          data-testid="version-panel-close"
          aria-label="关闭版本面板"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {items === null ? (
        <p className="version-panel-empty">加载中…</p>
      ) : items.length === 0 ? (
        <p className="version-panel-empty">暂无版本</p>
      ) : (
        <ul className="version-items">
          {items.map((item) => (
            <li key={item.id} className="version-item" data-testid={`version-item-${item.id}`}>
              <div className="version-item-main" onClick={() => void openPreview(item)}>
                <span className="version-item-time">{formatVersionTime(item.createdAt)}</span>
                <span
                  className={`version-item-badge version-item-badge-${item.type}`}
                  title={item.restoredFrom !== null ? '恢复自某版本' : undefined}
                >
                  {TYPE_BADGE[item.type]}
                </span>
                <span className="version-item-name">{item.createdByName ?? '—'}</span>
                <span className="version-item-count">{item.nodeCount} 节点</span>
              </div>
              <button
                type="button"
                className="version-item-restore"
                data-testid={`version-restore-${item.id}`}
                title="恢复到此版本"
                onClick={(e) => {
                  e.stopPropagation();
                  void restore(item);
                }}
              >
                恢复
              </button>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <div className="version-preview-mask" onClick={closePreview}>
          {/* 卡片拦截点击冒泡：点卡片空白不关遮罩，点遮罩才关 */}
          <div
            className="version-preview-dialog"
            data-testid="version-preview"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="version-preview-head">
              <span className="version-preview-title">
                快照预览 · {formatVersionTime(preview.item.createdAt)}
              </span>
              <button
                type="button"
                className="version-preview-close"
                data-testid="version-preview-close"
                aria-label="关闭预览"
                onClick={closePreview}
              >
                ×
              </button>
            </header>
            <div className="version-preview-canvas">
              <svg ref={previewSvgRef} role="img" aria-label="版本快照预览" />
            </div>
            <footer className="version-preview-foot">
              <span>{preview.item.createdByName ?? '—'}</span>
              <span>{preview.item.nodeCount} 节点</span>
            </footer>
          </div>
        </div>
      )}
    </aside>
  );
}
