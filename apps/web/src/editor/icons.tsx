/**
 * 工具栏内联 SVG 图标集 — M6 Task 1（企微对标）。
 *
 * 约定：16×16 视窗、stroke=currentColor、fill=none、strokeWidth=1.6、
 * 极简线条字形，无外部依赖；颜色随按钮文字色（含禁用态降透明度）走。
 * 组件不接收内容 props（只作纯字形）；如需尺寸微调用 CSS 控制 svg 大小。
 */

type IconProps = {
  /** 可选的 className（如 a11y 隐藏辅助），默认无 */
  className?: string;
};

function svgProps(className?: string) {
  return {
    className,
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

/** 返回（左箭头 + 左侧竖线锚点）：返回工作台 */
export function BackIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M6.5 3.5 3 7l3.5 3.5" />
      <path d="M3 7h10" />
    </svg>
  );
}

/** 撤销（回退弧形箭头） */
export function UndoIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M3.5 6h6a3.5 3.5 0 1 1 0 7H6" />
      <path d="M6 3.5 3.5 6 6 8.5" />
    </svg>
  );
}

/** 重做（前进弧形箭头，撤销的镜像） */
export function RedoIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M12.5 6h-6a3.5 3.5 0 1 0 0 7H10" />
      <path d="M10 3.5 12.5 6 10 8.5" />
    </svg>
  );
}

/** 结构（节点树：根 + 两层分支） */
export function StructureIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <rect x="6" y="1.5" width="4" height="3" rx="0.8" />
      <rect x="1.5" y="11.5" width="4" height="3" rx="0.8" />
      <rect x="10.5" y="11.5" width="4" height="3" rx="0.8" />
      <path d="M8 4.5v2.5M3.5 11.5v-2a1.5 1.5 0 0 1 1.5-1.5h6a1.5 1.5 0 0 1 1.5 1.5v2M8 7v2" />
    </svg>
  );
}

/** 主题（调色板：盘面 + 两色点） */
export function ThemeIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M8 1.8a6.2 6.2 0 0 0 0 12.4c1 0 1.6-.7 1.6-1.6 0-.9-.6-1.5-.6-2.2 0-.7.6-1.3 1.5-1.3h1.4A2.3 2.3 0 0 0 14.2 7 5.6 5.6 0 0 0 8 1.8Z" />
      <circle cx="5.2" cy="5.6" r="0.2" fill="currentColor" />
      <circle cx="8" cy="4.2" r="0.2" fill="currentColor" />
      <circle cx="10.6" cy="5.8" r="0.2" fill="currentColor" />
    </svg>
  );
}

/** 格式（字母 A + 底部色彩条）：样式面板锚点占位（T1 不入栏，供后续任务） */
export function FormatIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M4 12 7.2 4h1.6L12 12M5.4 9.4h5.2" />
      <path d="M2.5 14.2h11" />
    </svg>
  );
}

/** 导出（托盘向上箭头） */
export function ExportIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M8 10V2.5" />
      <path d="M5 5l3-2.8L11 5" />
      <path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

/** 成员（双人侧影） */
export function MembersIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="6" cy="5" r="2.4" />
      <path d="M1.8 13.2a4.4 4.4 0 0 1 8.4 0" />
      <path d="M10.4 3a2.4 2.4 0 0 1 0 4.6M11.4 9.4a4.4 4.4 0 0 1 2.8 3.8" />
    </svg>
  );
}

/** 版本历史（时钟倒转） */
export function HistoryIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M8 4v4l2.6 1.6" />
      <path d="M1.8 8a6.2 6.2 0 1 0 1.9-4.5M1.8 1.8v2.4h2.4" />
    </svg>
  );
}

/** 快捷键（键盘：底板 + 三键位） */
export function KeyboardIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <rect x="1.5" y="4" width="13" height="8" rx="1.2" />
      <path d="M4 6.5v3M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M6.5 9.5h.01M9 9.5h.01M11.5 9.5h.01" />
    </svg>
  );
}

/** 查找（放大镜） */
export function SearchIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4 14 14" />
    </svg>
  );
}

/** 全屏（四角外扩） */
export function FullscreenIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M9.5 2H14v4.5M6.5 14H2V9.5" />
      <path d="M14 2 9.7 6.3M2 14l4.3-4.3" />
    </svg>
  );
}

/** 星标（五角轮廓）：T1 星标按钮保留既有字形（★/☆ 文案断言依赖），供后续任务换装 */
export function StarIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="m8 2 1.9 3.9 4.1.6-3 2.9.7 4.1L8 11.6l-3.7 1.9.7-4.1-3-2.9 4.1-.6L8 2Z" />
    </svg>
  );
}
