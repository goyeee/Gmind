import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

/**
 * 节点图片大图预览（2026-10-15 需求方「双击支持预览大图」）。
 *
 * 形态照抄版本快照预览（VersionPanel 的 `version-preview-mask/dialog` 范式）：
 * 条件渲染 + fixed 遮罩，点图片外任意区域或 Esc 关闭。
 *
 * 读操作、不改数据：只读/移动端（移动端双击=双触）同样可用，故 EditorPage 的
 * 双击分支放在 readOnly 让路之前。图片走 `/api/images/{key}` 由服务端直出**原图**
 * （storage 不缩放，带 immutable 缓存头），这里只做视口内约束。
 *
 * 2026-10-20 需求方追加：
 * - 预览层内滚轮缩放（25%~800%），底部半透明灰底工具栏常显比例/下载；
 * - 关闭按钮固定在视口右上角；
 * - 点图片外任意区域关闭（图片/工具栏/右键菜单自身不触发）；
 * - 图片右键菜单「复制图片」，复用节点图片复制链路（系统剪贴板 PNG + 文档内
 *   payload，粘回画布仍沿用原 key）。
 */

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_WHEEL_RATE = 0.0015;
const ZOOM_BUTTON_FACTOR = 1.2;
const MENU_WIDTH = 136;
const MENU_HEIGHT = 42;
const MENU_MARGIN = 8;

const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** 下载名沿用存储键末段（键契约 `files/{id}/{ulid}.{ext}`，扩展名必在白名单内）。 */
function downloadNameOf(src: string): string {
  const base = src.split('?')[0].split('/').pop() || 'image';
  return /\.(png|jpe?g|gif|webp)$/i.test(base) ? base : `${base}.png`;
}

export function ImagePreview({
  src,
  onClose,
  onCopyImage,
}: {
  src: string;
  onClose: () => void;
  /** 复用节点图片复制链路：成功返回 true（系统剪贴板 PNG + 文档内 payload）。 */
  onCopyImage: () => Promise<boolean>;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'done' | 'failed'>('idle');

  useEffect(() => {
    setZoom(1); // 换图重开从 100% 开始
    setMenu(null);
    setCopyStatus('idle');
  }, [src]);

  useEffect(
    () => () => {
      if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    // React 的 wheel 监听在 root 上为 passive，preventDefault 不可靠；这里用原生
    // passive:false 监听，确保滚轮只缩放预览、不穿透滚动页面。
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      e.stopPropagation(); // 预览层独占滚轮，避免穿透到画布/页面
      setMenu(null);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const factor = Math.exp(-e.deltaY * unit * ZOOM_WHEEL_RATE);
      setZoom((z) => clampZoom(z * factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const zoomBy = (factor: number): void => {
    setMenu(null);
    setZoom((z) => clampZoom(z * factor));
  };

  const openContextMenu = (e: ReactMouseEvent<HTMLImageElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: Math.max(MENU_MARGIN, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - MENU_MARGIN)),
      y: Math.max(MENU_MARGIN, Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - MENU_MARGIN)),
    });
  };

  const copyImage = async (): Promise<void> => {
    setMenu(null);
    setCopyStatus('copying');
    let ok = false;
    try {
      ok = await onCopyImage();
    } catch {
      ok = false;
    }
    setCopyStatus(ok ? 'done' : 'failed');
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => {
      setCopyStatus('idle');
      statusTimerRef.current = null;
    }, 2000);
  };

  return (
    <div
      className="image-preview-overlay"
      data-testid="image-preview-overlay"
      ref={overlayRef}
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 只包住图片本身：点图片外任意区域（含原卡片留白）都冒泡到遮罩关闭。 */}
      <div className="image-preview-stage" data-testid="image-preview">
        <img
          className="image-preview-img"
          src={src}
          alt="节点图片预览"
          draggable={false}
          style={{ transform: `scale(${zoom})` }}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(null);
          }}
          onContextMenu={openContextMenu}
        />
      </div>

      {/* 底部半透明灰底工具栏：缩放控制 + 下载。 */}
      <div
        className="image-preview-toolbar"
        data-testid="image-preview-toolbar"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(null);
        }}
      >
        <button
          type="button"
          className="image-preview-tool"
          data-testid="image-preview-zoom-out"
          aria-label="缩小预览图"
          onClick={() => zoomBy(1 / ZOOM_BUTTON_FACTOR)}
        >
          −
        </button>
        <button
          type="button"
          className="image-preview-zoom"
          data-testid="image-preview-zoom"
          aria-label="重置缩放为 100%"
          title="重置为 100%"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="image-preview-tool"
          data-testid="image-preview-zoom-in"
          aria-label="放大预览图"
          onClick={() => zoomBy(ZOOM_BUTTON_FACTOR)}
        >
          +
        </button>
        <span className="image-preview-divider" aria-hidden="true" />
        <a
          className="image-preview-download"
          data-testid="image-preview-download"
          href={src}
          download={downloadNameOf(src)}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(null);
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          下载
        </a>
      </div>

      <button
        type="button"
        className="image-preview-close"
        data-testid="image-preview-close"
        aria-label="关闭预览"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>

      {copyStatus !== 'idle' && (
        <div
          className={`image-preview-status${copyStatus === 'failed' ? ' image-preview-status-failed' : ''}`}
          data-testid="image-preview-copy-status"
          role="status"
        >
          {copyStatus === 'copying'
            ? '正在复制…'
            : copyStatus === 'done'
              ? '已复制图片'
              : '复制失败 / 请检查浏览器剪贴板权限后重试'}
        </div>
      )}

      {menu && (
        <div
          className="image-preview-menu"
          data-testid="image-preview-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <button
            type="button"
            data-testid="image-preview-copy"
            role="menuitem"
            onClick={() => void copyImage()}
          >
            复制图片
          </button>
        </div>
      )}
    </div>
  );
}
