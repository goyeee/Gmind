// build.ts：XmindNode → 2020+ 格式 zip（[content.json, metadata.json]）。
// 备注写为 notes.plain.content；标记（2026-11-14 导入保真 v2）各数组逐枚出有 XMind
// 原生 marker-id 对应的值（iconsToMarkerIds：priority-N / flag-red / star-red / task-*
// / smiley-laugh / symbol 族 / c_symbol_like / people-orange / arrow-*；emoji/number
// 组与其余 other slug 无原生对应，不导出——映射口径见 markers.ts 头注）。
// 描述（M7c-C1）：description 非空出自定义键 `description`（2020+ JSON 宽容未知键；
// XML 侧无对应标签，登记不映射——见 types.ts XmindNode 头注）。
// 导出写回 v2（spec §六）：topic 非空 `href` 产键；非空 `style` 四键产
// `style:{properties:{…}}`（applyStyleKeyMap 的逆映射，fontSize 产 "<n>px"，表外键
// 不产——不造 XMind 不存在的属性名）；`buildXmind(sheets, extra?)` 第二参键原样合入
// zip（仅 e2e 夹具开口：导出自身调用不传，不产 resources/）。图片/概要/folded 不写回。
import { strToU8, zipSync } from 'fflate';
import { iconsToMarkerIds } from './markers';
import type { JsonTopic, XmindNode, XmindSheet } from './types';

/** XmindNode.style 键 → 2020+ 属性名（parse-json applyStyleKeyMap/STYLE_KEY_MAP 的逆）；
 *  fontSize 特殊处理（值已去 px 取整，产出补 "<n>px" 形状），故不入本表。 */
const STYLE_EXPORT_MAP: Record<string, string> = {
  color: 'fo:color',
  fill: 'svg:fill',
  border: 'svg:stroke-color',
};

/** style 四键过滤非空 → properties 表（解析侧 applyStyleKeyMap 的逆；非法/表外键不产）。
 *  fontSize 正则与解析侧同口径（数字 + 可选 px/pt），取整产 "<n>px"；非法/≤0 不产键。 */
function stylePropertiesOf(style: Record<string, string>): Record<string, string> {
  const props: Record<string, string> = {};
  for (const [key, value] of Object.entries(style)) {
    if (value === '') continue; // 非空才产（spec §六）
    if (key === 'fontSize') {
      if (typeof value !== 'string') continue; // 守卫（评审 Minor#1）：类型违规输入不产键，防 trim TypeError
      const m = /^(\d+(?:\.\d+)?)(px|pt)?$/.exec(value.trim());
      const n = m ? Math.round(Number(m[1])) : 0;
      if (n > 0) props['fo:font-size'] = `${n}px`; // 非法/≤0 不产键（与解析侧 ≤0 计降级对称）
    } else {
      const name = STYLE_EXPORT_MAP[key];
      if (name) props[name] = value; // 表外键不产键
    }
  }
  return props;
}

/** 生成 2020+ 格式 zip：[content.json, metadata.json]。多画布（计划四，裁定 8）：
 *  全部画布逐个出 sheet（title=画布名）；单画布调用方传单元素数组（兼容形态不变）。
 *  extra：键原样合入的 zip 条目（如 `resources/pic.png`）——仅 e2e 夹具开口，导出自身
 *  调用不传（不产 resources/）；缺省/空对象时载荷与 v2 前逐字节一致（build.test 金样钉）。 */
export function buildXmind(sheets: XmindSheet[], extra?: Record<string, Uint8Array>): Uint8Array {
  const topic = (n: XmindNode): JsonTopic => {
    const markerIds = iconsToMarkerIds(n.icons);
    const styleProps = n.style ? stylePropertiesOf(n.style) : {};
    return {
      class: 'topic',
      title: n.title,
      ...(markerIds.length > 0 ? { markers: markerIds.map((markerId) => ({ markerId })) } : {}),
      ...(n.note ? { notes: { plain: { content: n.note } } } : {}),
      ...(n.description ? { description: n.description } : {}),
      ...(n.href ? { href: n.href } : {}), // 有值才产键（调用方只透传 http/https，与解析侧对称）
      ...(Object.keys(styleProps).length > 0 ? { style: { properties: styleProps } } : {}),
      ...(n.children.length ? { children: { attached: n.children.map(topic) } } : {}),
    };
  };
  const content = JSON.stringify(
    sheets.map((s, i) => ({
      class: 'sheet',
      title: s.title || `Sheet ${i + 1}`,
      rootTopic: topic(s.root),
    })),
  );
  return zipSync({
    ...(extra ?? {}), // 夹具条目先行合入；content.json/metadata.json 恒在后覆盖，核心条目不可被夹具击穿
    'content.json': strToU8(content),
    'metadata.json': strToU8('{"creator":"Gmind"}'),
  });
}
