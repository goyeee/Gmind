// 登录页插画：向两侧无限延伸、边缘渐隐的脑图（原型 InfiniteMap 移植，2026-11-16 轮 4）。
type N = { label?: string; kids?: N[] };

const dots = (n: number): N[] => Array.from({ length: n }, () => ({}));
// 第 3、4 层为无标签的占位节点，表示「还能继续长下去」
const deep = (): N[] => [{ kids: dots(1) }, { kids: dots(1) }];

const LEFT: N[] = [
  { label: '头脑风暴', kids: [{ label: '灵感收集', kids: deep() }, { label: '用户访谈', kids: deep() }] },
  { label: '项目计划', kids: [{ label: '里程碑', kids: deep() }, { label: '任务拆解', kids: deep() }] },
  { label: '会议纪要', kids: [{ label: '待办事项', kids: deep() }, { label: '结论', kids: deep() }] },
];
const RIGHT: N[] = [
  { label: '负责人', kids: [{ label: '产品组', kids: deep() }, { label: '研发组', kids: deep() }] },
  { label: '进度跟踪', kids: [{ label: '本周', kids: deep() }, { label: '本月', kids: deep() }] },
  { label: '结构整理', kids: [{ label: '分类归档', kids: deep() }, { label: '知识沉淀', kids: deep() }] },
];

const W = 760;
const H = 440;
const CX = W / 2;
const CY = H / 2;
const X_AT = [0, 122, 238, 316, 372]; // 每层距中心的水平距离，最后一层已接近画布边缘
const OPACITY = [1, 1, 0.95, 0.65, 0.35];

interface P {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  label?: string;
  parent?: P;
  dir?: 1 | -1;
}

function layout(roots: N[], dir: 1 | -1): P[] {
  const out: P[] = [];
  const leaves = (n: N): number => (n.kids?.length ? n.kids.reduce((s, k) => s + leaves(k), 0) : 1);
  const total = roots.reduce((s, r) => s + leaves(r), 0);
  const step = (H - 56) / total;
  let cursor = 28 + step / 2;
  const size = (d: number, label?: string) =>
    d <= 2 ? { w: (label?.length ?? 2) * 13 + 26, h: 26 } : { w: d === 3 ? 34 : 26, h: 11 };

  const walk = (n: N, d: number, parent?: P): number => {
    let y: number;
    const kidsY: number[] = [];
    const me: P = { x: CX + dir * X_AT[d], y: 0, ...size(d, n.label), depth: d, label: n.label, dir };
    me.parent = parent;
    const idx = out.push(me) - 1;
    if (n.kids?.length) {
      n.kids.forEach((k) => kidsY.push(walk(k, d + 1, me)));
      y = (Math.min(...kidsY) + Math.max(...kidsY)) / 2;
    } else {
      y = cursor;
      cursor += step;
    }
    out[idx].y = y;
    return y;
  };
  const rootP = { x: CX, y: CY, w: 112, h: 38, depth: 0 } as P;
  roots.forEach((r) => walk(r, 1, rootP));
  return out;
}

export function InfiniteMap() {
  const nodes = [...layout(LEFT, -1), ...layout(RIGHT, 1)];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="向四周无限延伸的脑图示意">
      <defs>
        <linearGradient id="edge-fade" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.1" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.9" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="edge-mask">
          <rect width={W} height={H} fill="url(#edge-fade)" />
        </mask>
      </defs>

      <g mask="url(#edge-mask)">
        {/* 连线 */}
        {nodes.map((n, i) => {
          const p = n.parent;
          if (!p || p.depth === 0) return null;
          const x1 = p.x + n.dir! * (p.w / 2);
          const x2 = n.x - n.dir! * (n.w / 2);
          const mx = (x1 + x2) / 2;
          return (
            <path
              key={`l${i}`}
              d={`M${x1} ${p.y} C${mx} ${p.y} ${mx} ${n.y} ${x2} ${n.y}`}
              fill="none"
              stroke="#b7c6f5"
              strokeWidth={n.depth <= 2 ? 1.6 : 1.2}
              opacity={OPACITY[n.depth]}
              className="login-map-enter"
              style={{ animationDelay: `${n.depth * 0.18}s` }}
            />
          );
        })}
        {/* 一级节点连中心 */}
        {nodes
          .filter((n) => n.depth === 1)
          .map((n, i) => {
            const x1 = CX + n.dir! * 56;
            const x2 = n.x - n.dir! * (n.w / 2);
            const mx = (x1 + x2) / 2;
            return <path key={`r${i}`} d={`M${x1} ${CY} C${mx} ${CY} ${mx} ${n.y} ${x2} ${n.y}`} fill="none" stroke="#9db6f7" strokeWidth="2" />;
          })}

        {/* 节点 */}
        {nodes.map((n, i) => (
          <g
            key={`n${i}`}
            opacity={OPACITY[n.depth]}
            className="login-map-enter"
            style={{ animationDelay: `${0.1 + n.depth * 0.18}s` }}
          >
            <rect
              x={n.x - n.w / 2}
              y={n.y - n.h / 2}
              width={n.w}
              height={n.h}
              rx={n.h / 2}
              fill={n.depth === 1 ? '#e8f0ff' : '#fff'}
              stroke={n.depth === 1 ? '#9db6f7' : '#d5def5'}
              strokeWidth="1"
            />
            {n.label && (
              <text
                x={n.x}
                y={n.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={n.depth === 1 ? 12.5 : 11.5}
                fontWeight={n.depth === 1 ? 600 : 400}
                fill={n.depth === 1 ? '#3370ff' : '#4e5969'}
              >
                {n.label}
              </text>
            )}
          </g>
        ))}

        {/* 末端省略点：继续生长 */}
        {[-1, 1].map((d) => (
          <g key={`e${d}`} fill="#9db6f7">
            {[0, 1, 2].map((k) => (
              <circle key={k} cx={CX + d * (X_AT[4] + 30 + k * 9)} cy={CY} r={2.2 - k * 0.4} opacity={0.6 - k * 0.15} />
            ))}
          </g>
        ))}

        {/* 中心节点 */}
        <g>
          <rect x={CX - 56} y={CY - 19} width={112} height={38} rx={19} fill="#3370ff" />
          <text x={CX} y={CY} textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="600" fill="#fff">
            中心主题
          </text>
        </g>
      </g>
    </svg>
  );
}
