import type { TemplateSpec } from '@gmind/core';

/**
 * 模板真实缩略图（2026-10-27 模板中心完善，原型 Thumb.tsx 同款）：
 * 由模板 spec（rootText → 分支 → 叶子）确定性绘制迷你脑图/表格——不是装饰色块，
 * 每个模板的内容结构直接可见。脑图：中心主题色块 + 左右分支曲线 + 浅色节点卡；
 * 表格：迷你表头 + 行状态点 + 进度条（进度按分支叶子数确定性派生，不引入业务数据）。
 */

interface Branch {
  text: string;
  children: Array<{ text: string }>;
}

function MiniMap({ spec, accent }: { spec: TemplateSpec; accent: string }): React.ReactElement {
  const rootText = spec.rootText ?? spec.title;
  const branches = (spec.children ?? []) as Branch[];
  // 节点位置：root 居中；分支左右交替（原型 both 布局观感），叶子再外推一列
  const W = 380;
  const H = 190;
  const cx = W / 2;
  const cy = H / 2;
  const left = branches.filter((_, i) => i % 2 === 1);
  const right = branches.filter((_, i) => i % 2 === 0);
  const sideRows = (side: Branch[], dir: 1 | -1) => {
    const n = side.length;
    return side.map((b, i) => {
      const y = cy + (i - (n - 1) / 2) * 42;
      const bx = cx + dir * 74;
      const branch = { x: bx - 34, y: y - 11, w: 68, h: 22, text: b.text };
      const leaves = (b.children ?? []).map((leaf, j) => {
        const ly = y + (j - ((b.children?.length ?? 1) - 1) / 2) * 26;
        const lx = cx + dir * 158;
        return { x: lx - 40, y: ly - 9, w: 80, h: 18, text: leaf.text };
      });
      return { branch, leaves, y };
    });
  };
  const sides = [...sideRows(right, 1), ...sideRows(left, -1)];
  const curve = (x1: number, y1: number, x2: number, y2: number): string => {
    const m = (x1 + x2) / 2;
    return `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}`;
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="tpl-thumb-svg" aria-hidden>
      {sides.map(({ branch, leaves }, i) => {
        const dir = branch.x + 34 < cx ? -1 : 1;
        const x1 = dir === 1 ? cx + 34 : cx - 34;
        return (
          <g key={i}>
            <path d={curve(x1, cy, branch.x + (dir === 1 ? 0 : 68), branch.y + 11)} fill="none" stroke="#b4c8fb" strokeWidth={1.6} />
            {leaves.map((leaf, j) => (
              <path key={j} d={curve(branch.x + (dir === 1 ? 68 : 0), branch.y + 11, leaf.x + (dir === 1 ? 0 : 80), leaf.y + 9)} fill="none" stroke="#b4c8fb" strokeWidth={1.4} />
            ))}
          </g>
        );
      })}
      {sides.map(({ branch, leaves }, i) => (
        <g key={i}>
          <rect x={branch.x} y={branch.y} width={branch.w} height={branch.h} rx={7} fill="#eef3ff" stroke="#b4c8fb" strokeWidth={1.2} />
          <text x={branch.x + branch.w / 2} y={branch.y + 14} fontSize={10} fontWeight={500} fill="#3c4969" textAnchor="middle">
            {branch.text.slice(0, 7)}
          </text>
          {leaves.map((leaf, j) => (
            <g key={j}>
              <rect x={leaf.x} y={leaf.y} width={leaf.w} height={leaf.h} rx={6} fill="#fff" stroke="#d5dcf0" strokeWidth={1} />
              <text x={leaf.x + leaf.w / 2} y={leaf.y + 12} fontSize={9} fill="#5b5f77" textAnchor="middle">
                {leaf.text.slice(0, 9)}
              </text>
            </g>
          ))}
        </g>
      ))}
      <rect x={cx - 36} y={cy - 14} width={72} height={28} rx={9} fill={accent} />
      <text x={cx} y={cy + 5} fontSize={12} fontWeight={600} fill="#fff" textAnchor="middle">
        {rootText.slice(0, 6)}
      </text>
    </svg>
  );
}

function TableThumb({ accent }: { accent: string }): React.ReactElement {
  const rows = [
    { label: '整理需求', pct: 100, status: '已完成' },
    { label: '评审会议', pct: 60, status: '进行中' },
    { label: '接口开发', pct: 35, status: '进行中' },
    { label: '回归测试', pct: 0, status: '待开始' },
    { label: '灰度发布', pct: 0, status: '待开始' },
  ];
  return (
    <svg viewBox="0 0 380 190" className="tpl-thumb-svg" aria-hidden>
      <rect x={26} y={16} width={328} height={158} rx={10} fill="#fff" />
      <rect x={26} y={16} width={328} height={26} rx={10} fill="#f4f5fa" />
      {['序号', '主题', '进度', '状态'].map((h, i) => (
        <text key={h} x={[40, 76, 200, 296][i]} y={33} fontSize={9} fill="#9a9db4">
          {h}
        </text>
      ))}
      {rows.map((r, i) => {
        const y = 62 + i * 24;
        const c = r.pct >= 100 ? '#10b981' : r.pct < 25 ? '#f59e0b' : accent;
        return (
          <g key={i}>
            <text x={40} y={y + 3} fontSize={9} fill="#9a9db4">
              {i + 1}
            </text>
            <circle cx={80} cy={y} r={2.6} fill={c} />
            <text x={90} y={y + 3.5} fontSize={9.5} fill="#33364d">
              {r.label}
            </text>
            <rect x={200} y={y - 2} width={62} height={4} rx={2} fill="#ebecf5" />
            <rect x={200} y={y - 2} width={Math.max(1, r.pct * 0.62)} height={4} rx={2} fill={c} />
            <rect x={292} y={y - 8} width={44} height={15} rx={7.5} fill="#f4f5fa" />
            <text x={314} y={y + 3} fontSize={8} textAnchor="middle" fill={c}>
              {r.status}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function TemplateThumb({ spec, kind, accent }: { spec: TemplateSpec; kind?: 'map' | 'table'; accent: string }): React.ReactElement {
  return kind === 'table' ? <TableThumb accent={accent} /> : <MiniMap spec={spec} accent={accent} />;
}

/** 模板节点数（hero/预览副标口径：根 + 分支 + 叶子）。 */
export function specNodeCount(spec: TemplateSpec): number {
  const branches = (spec.children ?? []) as Branch[];
  return 1 + branches.length + branches.reduce((n, b) => n + (b.children?.length ?? 0), 0);
}
