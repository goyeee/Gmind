/**
 * 底部画布页签条（多画布计划三 Task 2，企微形态：底栏左侧画布页签）——
 * 多画布的**用户可见入口**。数据源 = Task 1 useActiveCanvas 的 canvases
 * （远端增/删/改名/排序经观察器即时反映）；本组件只做画布管理写的 UI 编排：
 *
 * - 页签：canvas-tab-<id>，当前项加 canvas-tab-active 类；单击 = 切换编排
 *   （onSwitch → controller.switchCanvas，含在途行内编辑提交/视口存档/场景重建）；
 * - ➕ 新建（canvas-add）：弹出 canvas-rename-input 行内输入（Enter/失焦提交、
 *   Esc 取消；空名走 core 默认命名「画布 N」）——core addCanvas 只置
 *   meta.activeCanvasId（LWW），本地视图态**不**被远端/meta 改写强拽（Task 1
 *   裁定），故新建后显式 onSwitch 走切换编排；
 * - 双击重命名：同一 canvas-rename-input；提交 renameCanvas（空名/超长由 core
 *   校验先于事务拦截，两段式 toast）；
 * - 右键菜单（样式令牌对齐 .context-menu：圆角 10px、阴影 0 8px 24px）：
 *   canvas-menu-rename / canvas-menu-delete；删除确认 window.confirm 先例
 *   （TaskPanel/VersionPanel）——画布删的是 doc 级根类型（canvases/canvasOrder），
 *   不进任何画布撤销栈（canvas-ops 头注），确认文案**不承诺**可撤销；
 *   最后一张删除被 core 拦（CANVAS_LAST_FORBIDDEN）→ 两段式 toast
 *   「这是最后一张画布。画布不可全部删除」（NFR-USE-005）；
 * - HTML5 拖拽排序：drop 落在目标页签 → reorderCanvases(doc, dragged, 目标 index)。
 *
 * 校验先于事务由 core 保证（canvas-ops）；本层 catch GmindCoreError 按错误码
 * 映射两段式文案。编辑态用 ref 镜像（editingRef）防 Enter 提交后 blur 二次提交
 * （行内输入卸载前 blur 必达，闭包 editing 已 stale）。
 *
 * 装配口径：仅桌面（EditorPage !readOnly 闸）——移动端页签形态属后续任务。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type * as Y from 'yjs';
import {
  MAX_CANVAS_NAME_LENGTH,
  addCanvas,
  deleteCanvas,
  GmindCoreError,
  renameCanvas,
  reorderCanvases,
  type CanvasInfo,
} from '@gmind/core';
import './CanvasTabBar.css';

export interface CanvasTabBarProps {
  doc: Y.Doc;
  /** 存活画布列表（useActiveCanvas 观察器数据源，canvasOrder 序）。 */
  canvases: CanvasInfo[];
  /** 当前活动画布（本地视图态 React 镜像）。 */
  activeCanvasId: string;
  showToast(message: string): void;
  /** 切换编排（= controller.switchCanvas：临时态清理/视口存档/场景重建）。 */
  onSwitch(canvasId: string): void;
  /** 画布管理写后的显式刷新（观察器已自动覆盖，本入口为写路径显式兜底）。 */
  onChanged?(): void;
}

/** core 画布错误码 → 两段式文案（原因+下一步，NFR-USE-005）。 */
function canvasErrorMessage(e: unknown): string {
  if (e instanceof GmindCoreError) {
    // CANVAS_LAST_FORBIDDEN：core message 为「至少保留一张画布，无法删除」，UI 侧
    // 按 brief 裁定呈现两段式完整版。
    if (e.code === 'CANVAS_LAST_FORBIDDEN') return '这是最后一张画布。画布不可全部删除';
    if (e.code === 'CANVAS_NAME_TOO_LONG') {
      return `画布名称长度已达上限（最多 ${MAX_CANVAS_NAME_LENGTH} 字），请精简后再保存`;
    }
    return e.message; // CANVAS_NAME_EMPTY 等 core 文案本身即两段式
  }
  return e instanceof Error ? e.message : '操作失败';
}

interface EditingState {
  /** null = 新建画布；否则 = 被重命名的画布 id。 */
  canvasId: string | null;
  initial: string;
}

interface MenuState {
  x: number;
  y: number;
  canvasId: string;
}

export function CanvasTabBar({
  doc,
  canvases,
  activeCanvasId,
  showToast,
  onSwitch,
  onChanged,
}: CanvasTabBarProps) {
  // 编辑态 ref 镜像：Enter 提交置 null 后，行内输入卸载前触发的 blur 仍持有
  // stale 闭包 editing——经 editingRef 查当前值，二次提交天然 no-op。
  const editingRef = useRef<EditingState | null>(null);
  const [editing, setEditingState] = useState<EditingState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const dragIdRef = useRef<string | null>(null);

  const setEditing = (next: EditingState | null): void => {
    editingRef.current = next;
    setEditingState(next);
  };

  // 右键菜单 Esc/外点关闭（marker-picker 同款机制；菜单项 click 在菜单内，
  // pointerdown 命中 .canvas-tab-menu 不关闭，紧随的 click 正常执行）。
  useEffect(() => {
    if (!menu) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (!(e.target as Element | null)?.closest?.('.canvas-tab-menu')) setMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  const commitEditing = (value: string): void => {
    const current = editingRef.current;
    setEditing(null);
    if (!current) return; // Enter 已提交过的 blur 二次触发
    const name = value.trim();
    try {
      if (current.canvasId === null) {
        // 新建：空名走 core 默认命名（画布 N）；非空显式命名（校验先于事务在 core）
        const newId = addCanvas(doc, name === '' ? {} : { name });
        onSwitch(newId); // meta.activeCanvasId（LWW）不强拽本地视图 → 显式切换编排
      } else {
        renameCanvas(doc, current.canvasId, name); // 空名/超长 core 拦截 → 两段式 toast
      }
      onChanged?.();
    } catch (e) {
      showToast(canvasErrorMessage(e));
    }
  };

  const requestDelete = (canvas: CanvasInfo): void => {
    setMenu(null);
    // window.confirm 先例（TaskPanel/VersionPanel）；画布删除不可经 Ctrl+Z 撤销
    // （doc 级根类型不进画布撤销栈，canvas-ops 头注），文案如实不承诺撤销。
    if (!window.confirm(`确定删除画布「${canvas.name}」？画布内节点将一并删除（不可撤销）`)) return;
    try {
      deleteCanvas(doc, canvas.id);
      // 活动画布被删的本地回退由 useActiveCanvas 观察器 reconcileActive 同步完成；
      // onChanged 为写路径显式刷新兜底。
      onChanged?.();
    } catch (e) {
      showToast(canvasErrorMessage(e)); // 最后一张：CANVAS_LAST_FORBIDDEN 两段式拦截
    }
  };

  const dropOn = (targetId: string): void => {
    const dragged = dragIdRef.current;
    dragIdRef.current = null;
    if (!dragged || dragged === targetId) return;
    const toIndex = canvases.findIndex((c) => c.id === targetId);
    if (toIndex === -1) return;
    try {
      reorderCanvases(doc, dragged, toIndex);
      onChanged?.();
    } catch (e) {
      showToast(canvasErrorMessage(e));
    }
  };

  const renameInput = (key: string, initial: string, labelledBy: string): ReactElement => (
    <input
      key={key}
      data-testid="canvas-rename-input"
      className="canvas-rename-input"
      defaultValue={initial}
      placeholder="画布名称"
      aria-label={labelledBy}
      autoFocus
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitEditing((e.target as HTMLInputElement).value);
        else if (e.key === 'Escape') setEditing(null);
      }}
      onBlur={(e) => commitEditing(e.target.value)}
    />
  );

  return (
    <div className="canvas-tabbar" data-testid="canvas-tabbar" role="tablist" aria-label="画布页签">
      {canvases.map((canvas) =>
        editing?.canvasId === canvas.id ? (
          renameInput(canvas.id, editing.initial, '重命名画布')
        ) : (
          <button
            key={canvas.id}
            type="button"
            role="tab"
            aria-selected={canvas.id === activeCanvasId}
            data-testid={`canvas-tab-${canvas.id}`}
            className={canvas.id === activeCanvasId ? 'canvas-tab canvas-tab-active' : 'canvas-tab'}
            title={canvas.name}
            onClick={() => onSwitch(canvas.id)}
            onDoubleClick={() => setEditing({ canvasId: canvas.id, initial: canvas.name })}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, canvasId: canvas.id });
            }}
            onDragStart={(e) => {
              dragIdRef.current = canvas.id;
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropOn(canvas.id);
            }}
          >
            {canvas.name}
          </button>
        ),
      )}
      {editing?.canvasId === null && renameInput('__add__', '', '新建画布')}
      <button
        type="button"
        data-testid="canvas-add"
        className="canvas-add"
        title="新建画布"
        aria-label="新建画布"
        onClick={() => setEditing({ canvasId: null, initial: '' })}
      >
        ＋
      </button>
      {menu && (
        <div
          className="canvas-tab-menu"
          data-testid="canvas-tab-menu"
          // 视口钳制（assignee-picker 先例）：底栏贴底弹出，不钳会整体弹出视口外
          style={{
            left: Math.min(menu.x, window.innerWidth - 140),
            top: Math.min(menu.y, window.innerHeight - 90),
          }}
          role="menu"
        >
          <button
            type="button"
            data-testid="canvas-menu-rename"
            onClick={() => {
              const target = canvases.find((c) => c.id === menu.canvasId);
              setMenu(null);
              if (target) setEditing({ canvasId: target.id, initial: target.name });
            }}
          >
            重命名
          </button>
          <button
            type="button"
            data-testid="canvas-menu-delete"
            onClick={() => {
              const target = canvases.find((c) => c.id === menu.canvasId);
              if (target) requestDelete(target);
            }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}
