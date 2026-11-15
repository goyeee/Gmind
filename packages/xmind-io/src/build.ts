// build.ts：XmindNode → 2020+ 格式 zip（[content.json, manifest.json, metadata.json]）。
// 备注写为 notes.plain.content；标记（2026-11-14 导入保真 v2）各数组逐枚出有 XMind
// 原生 marker-id 对应的值（iconsToMarkerIds：priority-N / flag-red / star-red / task-*
// / smiley-laugh / symbol 族 / c_symbol_like / people-orange / arrow-*；emoji/number
// 组与其余 other slug 无原生对应，不导出——映射口径见 markers.ts 头注）。
// 描述（M7c-C1）：description 非空出自定义键 `description`（2020+ JSON 宽容未知键；
// XML 侧无对应标签，登记不映射——见 types.ts XmindNode 头注）。
// 导出写回 v2（spec §六）：topic 非空 `href` 产键；非空 `style` 四键产
// `style:{properties:{…}}`（applyStyleKeyMap 的逆映射，fontSize 产 "<n>px"，表外键
// 不产——不造 XMind 不存在的属性名）；`buildXmind(sheets, extra?)` 第二参键原样合入
// zip（e2e 夹具与图片字节通道：node.image.path 指向 extra 键，本函数自身不产
// resources/ 条目）。概要/folded 不写回（图片 v2.3 起写回）。
// v2.1（2026-11-15 导出返工 Task 1）：sheet/topic 逐个产非空 `id`（缺省
// crypto.randomUUID，第三参 idFactory 可注入确定性工厂）、根 structureType 映射
// rootTopic `structureClass`、zip 增 `manifest.json`（file-entries 登记两核心条目）、
// metadata creator 升对象形式——依据：需求方反馈导出件在 XMind 8 打不开（Zen 解析器
// SheetDeserializer.parseTopic 对 topic id 断言非空），对照本机真实 Zen JSON 金样
// （creator Vana 24.01）补齐必需键。
// v2.3（2026-11-15 导出保真第三波 Task 1）：sheet 逐个携带 `theme`（DEFAULT_THEME
// 逐字借自本机真实 Zen 金样「张智建总结计划 2025-08-01」——mainTopic/subTopic 的
// `line-class: org.xmind.branchConnection.roundedElbow` 即 XMind 软件圆角连接线
// 质感来源，缺 theme 时 XMind 落直线观感）；topic 级 `image {src:'xap:<path>',width,
// height,align}` 写回（解析侧剥 `xap:` 的逆，w/h/align 缺省不产键）；manifest
// file-entries 登记 extra 全部键——依据：需求方 2026-11-15 验收反馈「图片没导出来」
// 「连接线直愣愣的和 XMind 软件创建的不一样」。
// v2.4（2026-11-15 导出主题按结构选型 Task 1）：sheet.theme 不再一律 DEFAULT_THEME，
// 改 `themeOf(s.structureType)` 二选一——mindmap→THEME_MINDMAP（逐字借自本机真实
// 思维导图金样「邢安家2025.08.01.xmind」map.unbalanced 画布的 theme：central/main/
// sub/summaryTopic line-class 全 `org.xmind.branchConnection.curve` 曲线，无
// skeletonThemeId/colorThemeId）；logic/org/缺省→THEME_LOGIC（即 v2.3 DEFAULT_THEME
// 改名，roundedElbow 金样零改动不回归）——依据：需求方 2026-11-15 反馈思维导图页
// 导出线条「直愣愣」+ 35 份真实思维导图文件中 27 份 theme 为 curve 的主流统计。
// 分侧忠实还原（2026-11-15 Task 2）：mindmap 画布且 s.rightCount!==undefined 时根
// topic 产 extensions right-number（金样逐字形状，见 rightNumberExtensions 头注）——
// XMind 打开导出件时分支左右与 Gmind 一致；缺省/非 mindmap 不产键，既有产物条目
// 字节零改动。
import { strToU8, zipSync } from 'fflate';
import { iconsToMarkerIds } from './markers';
import { UNBALANCED_PROVIDER } from './parse-json';
import type { JsonTopic, XmindNode, XmindSheet, XmindStructureType } from './types';

/** XmindNode.style 键 → 2020+ 属性名（parse-json applyStyleKeyMap/STYLE_KEY_MAP 的逆）；
 *  fontSize 特殊处理（值已去 px 取整，产出补 "<n>px" 形状），故不入本表。 */
const STYLE_EXPORT_MAP: Record<string, string> = {
  color: 'fo:color',
  fill: 'svg:fill',
  border: 'svg:stroke-color',
};

/** structureType → 2020+ rootTopic `structureClass`（parse-json structureTypeOf 的逆；
 *  仅根携带——子 topic 不产，解析侧非根 structureClass 计 structureOverride）。logic 值
 *  实证自本机真实金样（Vana 24.01 导出件）；mindmap/org 为 XMind 标准结构 id（解析侧
 *  map./org-chart. 前缀匹配覆盖）。 */
const STRUCTURE_EXPORT_MAP: Record<XmindStructureType, string> = {
  mindmap: 'org.xmind.ui.map.unbalanced',
  logic: 'org.xmind.ui.logic.right',
  org: 'org.xmind.ui.org-chart.balanced',
};

/** 逻辑图主题（v2.3 名 DEFAULT_THEME，v2.4 改名；logic/org/缺省结构画布用）：
 *  **逐字**抄录自本机真实 Zen 金样「张智建总结计划 2025-08-01」
 *  content.json 的 sheet.theme（creator Vana 24.01）——十五键：centralTopic/mainTopic/
 *  subTopic/summaryTopic/calloutTopic/floatingTopic/boundary/summary/relationship/map/
 *  importantTopic/minorTopic/expiredTopic 各层 `{id,properties}` 全文（含 map 层
 *  multi-line-colors/color-list），加 skeletonThemeId/colorThemeId 两字符串。零值自造：
 *  层内 id 为主题定义的固定字面 UUID（XMind 主题 id 跨文件无唯一性要求），字体/颜色/
 *  line-class（roundedElbow=圆角肘形连接线，即 XMind 软件质感来源）一概金样原文。 */
const THEME_LOGIC = {
  centralTopic: {
    id: 'e61f909d-0249-4b87-866f-2a7881b15030',
    properties: {
      'fo:font-family': 'NeverMind',
      'fo:font-size': '28pt',
      'fo:font-weight': '600',
      'fo:font-style': 'normal',
      'fo:text-transform': 'manual',
      'fo:text-decoration': 'none',
      'fo:text-align': 'center',
      'svg:fill': '#4D86DB',
      'fill-pattern': 'solid',
      'line-width': '2pt',
      'line-color': '#4D86DB',
      'line-pattern': 'solid',
      'border-line-width': '0pt',
      'shape-class': 'org.xmind.topicShape.roundedRect',
      'line-class': 'org.xmind.branchConnection.roundedfold',
      'arrow-end-class': 'org.xmind.arrowShape.none',
      'alignment-by-level': 'actived',
    },
  },
  mainTopic: {
    id: '537df260-9612-4fed-a26c-a114a66efde3',
    properties: {
      'fo:font-family': 'NeverMind',
      'fo:font-size': '18pt',
      'fo:font-weight': '600',
      'fo:font-style': 'normal',
      'fo:text-transform': 'manual',
      'fo:text-decoration': 'none',
      'fo:text-align': 'left',
      'fill-pattern': 'solid',
      'border-line-width': '0pt',
      'shape-class': 'org.xmind.topicShape.roundedRect',
      'line-class': 'org.xmind.branchConnection.roundedElbow',
    },
  },
  subTopic: {
    id: '9e449fd4-7218-4b16-ab44-4c5f5fc4127c',
    properties: {
      'fo:font-family': 'NeverMind',
      'fo:font-size': '14pt',
      'fo:font-weight': '400',
      'fo:font-style': 'normal',
      'fo:text-transform': 'manual',
      'fo:text-decoration': 'none',
      'fo:text-align': 'left',
      'fill-pattern': 'solid',
      'border-line-width': '0pt',
      'shape-class': 'org.xmind.topicShape.roundedRect',
      'line-class': 'org.xmind.branchConnection.roundedElbow',
    },
  },
  summaryTopic: {
    id: 'a2b6b85d-716b-4814-a5b3-4412a4f06ebf',
    properties: {
      'fo:font-family': 'Montserrat',
      'fo:font-size': '14pt',
      'fo:font-weight': '400',
      'fo:font-style': 'normal',
      'fo:text-transform': 'manual',
      'fo:text-decoration': 'none',
      'fo:text-align': 'center',
      'svg:fill': '#00000000',
      'fill-pattern': 'solid',
      'border-line-color': '#4D86DB',
      'shape-class': 'org.xmind.topicShape.roundedRect',
      'line-class': 'org.xmind.branchConnection.roundedElbow',
    },
  },
  calloutTopic: {
    id: 'd663932a-c424-4e13-8496-e26e3ce34283',
    properties: {
      'fo:font-family': 'NeverMind',
      'fo:font-size': '14pt',
      'fo:font-weight': '600',
      'fo:font-style': 'normal',
      'fo:text-transform': 'manual',
      'fo:text-decoration': 'none',
      'fo:text-align': 'left',
      'svg:fill': '#4D86DB',
      'fill-pattern': 'solid',
      'border-line-color': '#4D86DB',
      'shape-class': 'org.xmind.topicShape.ellipse',
    },
  },
  floatingTopic: {
    id: '9319e51f-7887-4891-a790-fc92128171fd',
    properties: {
      'fo:font-family': 'Montserrat',
      'fo:font-size': '14pt',
      'fo:font-weight': 'normal',
      'fo:font-style': 'normal',
      'fo:text-transform': 'manual',
      'fo:text-decoration': 'none',
      'fo:text-align': 'center',
      'svg:fill': '#EEEBEE',
      'fill-pattern': 'solid',
      'line-pattern': 'solid',
      'border-line-color': '#EEEBEE',
      'border-line-width': '0pt',
      'shape-class': 'org.xmind.topicShape.roundedRect',
      'line-class': 'org.xmind.branchConnection.roundedElbow',
      'arrow-end-class': 'org.xmind.arrowShape.none',
    },
  },
  boundary: {
    id: '71580337-3dff-489b-b5b3-927007835355',
    properties: {
      'fo:font-family': "'NeverMind','Microsoft YaHei','PingFang SC','Microsoft JhengHei','sans-serif',sans-serif",
      'fo:font-size': '14pt',
      'fo:font-weight': '600',
      'fo:font-style': 'normal',
      'fo:text-transform': 'manual',
      'fo:text-decoration': 'none',
      'fo:text-align': 'center',
      'svg:fill': '#4D86DB',
      'fill-pattern': 'solid',
      'line-width': '2',
      'line-color': '#4D86DB',
      'line-pattern': 'dash',
      'shape-class': 'org.xmind.boundaryShape.roundedRect',
    },
  },
  summary: {
    id: 'a2bbba5a-4253-437e-b807-d31b5dcff18d',
    properties: {
      'line-width': '2pt',
      'line-color': '#4D86DB',
      'line-pattern': 'solid',
      'shape-class': 'org.xmind.summaryShape.square',
    },
  },
  relationship: {
    id: '6eca12dd-30c8-44cc-ab5e-05685b89bc36',
    properties: {
      'fo:font-family': "'NeverMind','Microsoft YaHei','PingFang SC','Microsoft JhengHei','sans-serif',sans-serif",
      'fo:font-size': '13pt',
      'fo:font-weight': '600',
      'fo:font-style': 'normal',
      'fo:text-transform': 'manual',
      'fo:text-decoration': 'none',
      'fo:text-align': 'center',
      'line-width': '2',
      'line-color': '#4D86DB',
      'line-pattern': 'dash',
      'shape-class': 'org.xmind.relationshipShape.curved',
      'arrow-begin-class': 'org.xmind.arrowShape.none',
      'arrow-end-class': 'org.xmind.arrowShape.triangle',
    },
  },
  map: {
    id: '395b0355-65ec-4298-8267-b12857d8ab77',
    properties: {
      'svg:fill': '#FFFFFF',
      'multi-line-colors': '#D3BD6C #ADB66B #76B18A #54A39B #5192A4 #7878A0',
      'color-list': '#000229 #1F2766 #52CC83 #4D86DB #99142F #245570',
      'line-tapered': 'none',
    },
  },
  importantTopic: {
    id: '804cc97b-bce9-4393-8633-ac6a8957d319',
    properties: {
      'svg:fill': '#86DB4D',
      'fill-pattern': 'solid',
      'border-line-color': '#86DB4D',
    },
  },
  minorTopic: {
    id: '0ce9108f-71bc-4ef0-919c-697679279061',
    properties: {
      'svg:fill': '#DB4D86',
      'fill-pattern': 'solid',
      'border-line-color': '#DB4D86',
    },
  },
  expiredTopic: {
    id: 'cc15dbe9-4956-470d-b379-a55185ff73ef',
    properties: {
      'fo:text-decoration': 'line-through',
      'svg:fill': '#00000000',
    },
  },
  skeletonThemeId: 'a148ee55687bdfc44af2fa5f16',
  colorThemeId: 'Rainbow-#4D86DB-MULTI_LINE_COLORS',
};

/** 思维导图主题（v2.4）：**逐字**抄录自本机真实思维导图金样「邢安家2025.08.01.xmind」
 *  content.json 中 map.unbalanced 画布的 sheet.theme——十键：subTopic/summary/boundary/
 *  calloutTopic/centralTopic/mainTopic/summaryTopic/floatingTopic/relationship/map，各层
 *  `{type,properties}` 金样原文（键序亦原文，字节金样钉死）；无 importantTopic/
 *  minorTopic/expiredTopic，无 skeletonThemeId/colorThemeId（金样本无，不自造）。
 *  centralTopic/mainTopic/subTopic/summaryTopic 的 line-class 全
 *  `org.xmind.branchConnection.curve`（曲线连接线——35 份真实思维导图文件 27 份的主流
 *  形态），mainTopic svg:fill #DCE6F2 / border-line-width 2pt。零值自造。 */
const THEME_MINDMAP = {
  subTopic: {
    type: 'topic',
    properties: {
      'border-line-color': '#558ED5',
      'border-line-width': '3pt',
      'fo:font-family': 'Microsoft YaHei',
      'line-class': 'org.xmind.branchConnection.curve',
      'line-color': '#558ED5',
      'line-width': '1pt',
    },
  },
  summary: {
    type: 'summary',
    properties: {
      'line-color': '#C3D69B',
      'line-width': '5pt',
      'shape-class': 'org.xmind.summaryShape.square',
    },
  },
  boundary: {
    type: 'boundary',
    properties: {
      'fo:color': '#FFFFFF',
      'fo:font-family': 'Microsoft YaHei',
      'fo:font-size': '10pt',
      'fo:font-style': 'italic',
      'line-color': '#77933C',
      'line-pattern': 'dot',
      'line-width': '3pt',
      'shape-class': 'org.xmind.boundaryShape.roundedRect',
      'svg:fill': '#C3D69B',
      'svg:opacity': '.2',
    },
  },
  calloutTopic: {
    type: 'topic',
    properties: {
      'border-line-color': '#F1BD51',
      'border-line-width': '2pt',
      'fo:font-family': 'Microsoft YaHei',
      'svg:fill': '#FBF09C',
    },
  },
  centralTopic: {
    type: 'topic',
    properties: {
      'border-line-color': '#558ED5',
      'border-line-width': '5pt',
      'fo:color': '#376092',
      'fo:font-family': 'Microsoft YaHei',
      'line-class': 'org.xmind.branchConnection.curve',
      'line-color': '#558ED5',
      'line-width': '1pt',
      'shape-class': 'org.xmind.topicShape.roundedRect',
      'svg:fill': '#DCE6F2',
    },
  },
  mainTopic: {
    type: 'topic',
    properties: {
      'border-line-color': '#558ED5',
      'border-line-width': '2pt',
      'fo:color': '#17375E',
      'fo:font-family': 'Microsoft YaHei',
      'line-class': 'org.xmind.branchConnection.curve',
      'line-color': '#558ED5',
      'line-width': '1pt',
      'shape-class': 'org.xmind.topicShape.roundedRect',
      'svg:fill': '#DCE6F2',
    },
  },
  summaryTopic: {
    type: 'topic',
    properties: {
      'border-line-width': '0pt',
      'fo:color': '#FFFFFF',
      'fo:font-family': 'Microsoft YaHei',
      'fo:font-size': '10pt',
      'fo:font-style': 'italic',
      'line-class': 'org.xmind.branchConnection.curve',
      'shape-class': 'org.xmind.topicShape.roundedRect',
      'svg:fill': '#77933C',
    },
  },
  floatingTopic: {
    type: 'topic',
    properties: {
      'border-line-width': '0pt',
      'fo:color': '#FFFFFF',
      'fo:font-family': 'Microsoft YaHei',
      'fo:font-weight': 'bold',
      'line-color': '#558ED5',
      'svg:fill': '#558ED5',
    },
  },
  relationship: {
    type: 'relationship',
    properties: {
      'arrow-end-class': 'org.xmind.arrowShape.triangle',
      'fo:color': '#595959',
      'fo:font-family': 'Microsoft YaHei',
      'fo:font-size': '10pt',
      'fo:font-style': 'italic',
      'fo:font-weight': 'normal',
      'fo:text-decoration': 'none',
      'line-color': '#77933C',
      'line-pattern': 'dash',
      'line-width': '3pt',
    },
  },
  map: {
    type: 'map',
    properties: {
      'color-gradient': 'none',
      'line-tapered': 'none',
      'multi-line-colors': 'none',
      'svg:fill': '#FFFFFF',
    },
  },
};

/** sheet 主题按结构选型（v2.4）：mindmap→思维导图曲线主题（curve）；logic/org/缺省→
 *  逻辑图圆角主题（v2.3 行为不回归——logic 画布线条质感来源不变；org 无真实样本暂随
 *  logic）。 */
const themeOf = (t?: XmindStructureType) => (t === 'mindmap' ? THEME_MINDMAP : THEME_LOGIC);

/** 根 topic extensions right-number（分侧忠实还原 Task 2，仅 mindmap+rightCount!==undefined
 *  时产）：金样形状逐字采信自本机真实 Zen JSON 根 topic——
 *  `[{provider:'org.xmind.ui.map.unbalanced',content:[{name:'right-number',content:String(n)}]}]`
 *  （content 是 [{name,content}] 数组、值为字符串数字；语义=attached 文档序前 N 支居右）。
 *  rightCount=0 合法（content '0'=全左）；非 mindmap 结构或未计数不产键（XMind 只在
 *  map.unbalanced 画布读 right-number，写了也不被还原）。provider 字符串单源借解析侧
 *  UNBALANCED_PROVIDER（与 STRUCTURE_EXPORT_MAP.mindmap 同值，防口径分叉）。 */
function rightNumberExtensions(
  s: XmindSheet,
): { provider: string; content: { name: string; content: string }[] }[] | undefined {
  if (s.structureType !== 'mindmap' || s.rightCount === undefined) return undefined;
  return [{ provider: UNBALANCED_PROVIDER, content: [{ name: 'right-number', content: String(s.rightCount) }] }];
}

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

/** 生成 2020+ 格式 zip：[content.json, manifest.json, metadata.json]（v2.1 起 manifest
 *  入列）。多画布（计划四，裁定 8）：全部画布逐个出 sheet（title=画布名）；单画布调用方
 *  传单元素数组（兼容形态不变）。v2.3 起每 sheet 携带 theme（v2.4 起按 structureType
 *  选型，见 themeOf）；分侧忠实还原 Task 2 起 mindmap+rightCount 的根 topic 产
 *  extensions right-number（见 rightNumberExtensions）；extra：键原样合入
 *  的 zip 条目（如 `resources/pic.png`，node.image.path 指向其键——本函数自身不产
 *  resources/），manifest 同步登记 extra 全部键；缺省/空对象时载荷与注入 idFactory 的
 *  期望逐字节一致（build.test 金样钉）。idFactory：缺省 crypto.randomUUID（生产路径），
 *  测试注入确定性工厂钉死 id 序。 */
export function buildXmind(
  sheets: XmindSheet[],
  extra?: Record<string, Uint8Array>,
  idFactory: () => string = () => crypto.randomUUID(),
): Uint8Array {
  const topic = (n: XmindNode): JsonTopic => {
    const markerIds = iconsToMarkerIds(n.icons);
    const styleProps = n.style ? stylePropertiesOf(n.style) : {};
    return {
      class: 'topic',
      id: idFactory(), // XMind 8 Zen 解析器对 topic id 断言非空（v2.1 写回依据）
      title: n.title,
      ...(markerIds.length > 0 ? { markers: markerIds.map((markerId) => ({ markerId })) } : {}),
      ...(n.note ? { notes: { plain: { content: n.note } } } : {}),
      ...(n.description ? { description: n.description } : {}),
      ...(n.href ? { href: n.href } : {}), // 有值才产键（调用方只透传 http/https，与解析侧对称）
      // 图片（v2.3）：src=解析侧剥 `xap:` 的逆（path 为 zip 资源键，如 resources/p.png）；
      // w/h/align 缺省不产键；path 空串视同无图不产键
      ...(n.image && n.image.path !== ''
        ? {
            image: {
              src: `xap:${n.image.path}`,
              ...(n.image.w != null ? { width: n.image.w } : {}),
              ...(n.image.h != null ? { height: n.image.h } : {}),
              ...(n.image.align ? { align: n.image.align } : {}),
            },
          }
        : {}),
      ...(Object.keys(styleProps).length > 0 ? { style: { properties: styleProps } } : {}),
      ...(n.children.length ? { children: { attached: n.children.map(topic) } } : {}),
    };
  };
  const content = JSON.stringify(
    sheets.map((s, i) => {
      const extensions = rightNumberExtensions(s);
      return {
        class: 'sheet',
        id: idFactory(), // 调用序=先序：sheet id 先于本画布全部 topic id
        title: s.title || `Sheet ${i + 1}`,
        rootTopic: {
          ...topic(s.root),
          // 结构类只写在根（金样实证；子 topic 产键会被解析侧计 structureOverride）
          ...(s.structureType ? { structureClass: STRUCTURE_EXPORT_MAP[s.structureType] } : {}),
          // 分侧计数只写在根（分侧忠实还原 Task 2；紧随 structureClass，仅 mindmap+已计数）
          ...(extensions ? { extensions } : {}),
        },
        // 主题恒在末位（金样 sheet 键序实证）；值=themeOf 按结构选型（v2.4，解析侧不计降级）
        theme: themeOf(s.structureType),
      };
    }),
  );
  return zipSync({
    ...(extra ?? {}), // 夹具条目先行合入；核心条目恒在后覆盖，不可被夹具击穿
    'content.json': strToU8(content),
    // manifest 登记 extra 全部键（v2.3）：同名核心键展开覆盖同值 {}，键序不变字节稳定
    'manifest.json': strToU8(
      JSON.stringify({
        'file-entries': {
          'content.json': {},
          'metadata.json': {},
          ...Object.fromEntries(Object.keys(extra ?? {}).map((k) => [k, {}])),
        },
      }),
    ),
    'metadata.json': strToU8('{"creator":{"name":"Gmind","version":"1.0"}}'),
  });
}
