import { buildXmind, zipEntries } from '@gmind/xmind-io';

/**
 * e2e 合成 .xmind 夹具（2026-11-14 导入保真 Task 6）——运行时构造，仓库不落 .xmind
 * 二进制文件；标题全部中性（根节点/分支一/待办一…），不含任何真实业务内容。
 *
 * 两条构造路径：
 * - buildCleanXmind：纯净水树（零降级源）经 @gmind/xmind-io 的 buildXmind 直出——既有
 *   导入用例同款的「包 API 构造」路径，toast「已完整导入」的断言载体（快路径导入）。
 * - buildFixtureXmind：全保真夹具（progress/mood/other/arrow 四族标记＋1 概要＋1
 *   http 超链接＋fill/color/fontSize 三键样式＋根 structureClass=logic.right＋zip 内嵌
 *   4×4 PNG），toast「未导入：图标 1」与画布落位断言的载体（有图两段式导入）。
 *
 * 为什么 buildFixtureXmind 的 content.json 手写而不过 buildXmind：buildXmind 是**导出**
 * 序列化器，按 spec §六「导出不写回：图片、概要、folded」产不出 structureClass／图片
 * 引用／概要两段式（也不产陌生 marker-id——iconsToMarkerIds 原则「不造 XMind 不存在的
 * marker-id」），而夹具须以真实文件形状（spec §二真值：markers:[{markerId}]、image.src
 * 剥 xap:、概要 summaries+children.summary 两段式、width float）驱动**导入**解析器。
 * 手写形状与 packages/xmind-io parse.test.ts 夹具同款先例。zip 组装经 @gmind/xmind-io
 * 的 zipEntries 极小开口（fflate 恒为 xmind-io 私有依赖，web 不直引——Task 6 fix
 * round 1 裁定①）；文本条目经 TextEncoder 编码（同 fflate strToU8 语义）。
 */

/** 4×4 RGBA PNG（84 字节，橙色棋盘；IHDR/IDAT/IEND 经 zlib deflate，sips 验读 4×4）。
 *  最小合法载荷：解析层魔数嗅探（\x89PNG）、server 上传白名单、浏览器 createImageBitmap
 *  解码（readImageSize）全链路可用；导入尺寸 200px 钳制后恒为 4×4。 */
const PIC_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAG0lEQVR4nGP4ukz5//+bWf9hNAMyB0QzEFQBAGHOL/HdU0L9AAAAAElFTkSuQmCC';

/**
 * 全保真夹具 content.json（2020+ 格式，形状=spec §二真值）。降级源恰好 1 个：
 * 待办三的陌生标记 arrow-refresh（导入丢弃→「图标 1」）；其余字段全部落在映射表内，
 * 故 toast 精确全文「未导入：图标 1」同时证明两段式图片/概要/样式/结构零额外降级。
 */
const FIXTURE_CONTENT = [
  {
    class: 'sheet',
    title: '画布 1',
    rootTopic: {
      class: 'topic',
      title: '根节点',
      structureClass: 'org.xmind.ui.logic.right', // → structureType 'logic'（setDocMeta 落画布）
      children: {
        attached: [
          {
            class: 'topic',
            title: '分支一',
            markers: [{ markerId: 'task-done' }, { markerId: 'smiley-laugh' }], // → progress.done＋mood.smile
            children: {
              attached: [
                {
                  class: 'topic',
                  title: '待办一',
                  href: 'https://example.com/gmind-e2e', // → .gm-link-badge
                  image: {
                    src: 'xap:resources/pic.png', // 剥 xap: 查 resources 表（下方 zip 条目）
                    width: 79.9, // float 宽高（真实文件形状；导入尺寸按真实字节 4×4）
                    height: 178.4,
                    align: 'bottom', // → data-image-placement="bottom"
                  },
                },
              ],
            },
          },
          {
            class: 'topic',
            title: '分支二',
            markers: [
              { markerId: 'arrow-up' }, // → arrow.up（画布徽章）
              { markerId: 'c_symbol_like' }, // → other.like（下划线精确 id）
              { markerId: 'people-orange' }, // → other.person（other 组并存）
            ],
            // 概要两段式（spec §二真值）：引用 summaries[] + 标签文本在 children.summary[]
            summaries: [{ id: 'sum-ref-1', topicId: 'sum-lbl-1', range: '(0,1)' }],
            children: {
              summary: [{ id: 'sum-lbl-1', title: '示例概要' }],
              attached: [
                {
                  class: 'topic',
                  title: '待办二',
                  markers: [{ markerId: 'task-half' }], // → progress.p50（任务行 50%）
                  style: {
                    properties: {
                      'svg:fill': '#e8f0fe', // → 节点 rect fill
                      'fo:color': '#1a73e8',
                      'fo:font-size': '14px', // → fontSize '14'
                    },
                  },
                },
                {
                  class: 'topic',
                  title: '待办三',
                  markers: [{ markerId: 'arrow-refresh' }], // 陌生族：丢弃→「图标 1」
                },
              ],
            },
          },
        ],
      },
    },
  },
];

/** 全保真夹具：content.json（手写，见文件头注）+ resources/pic.png（4×4 PNG 字节常量
 *  内嵌）+ metadata.json → zip。返回 Buffer（setInputFiles buffer 契约）。 */
export function buildFixtureXmind(): Buffer {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  return Buffer.from(
    zipEntries({
      'resources/pic.png': Buffer.from(PIC_PNG_BASE64, 'base64'), // Buffer 即 Uint8Array 子类
      'content.json': encode(JSON.stringify(FIXTURE_CONTENT)),
      'metadata.json': encode('{"creator":"Gmind"}'),
    }),
  );
}

/** 纯净水树：buildXmind 直出（无标记/无图/无样式——快路径导入，零降级）。 */
export function buildCleanXmind(): Buffer {
  return Buffer.from(
    buildXmind([
      { title: '画布 1', root: { title: '示例树', children: [{ title: '子节点甲', children: [] }] } },
    ]),
  );
}
