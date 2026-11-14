// xmind-import.ts：XMind 导入胶水（M4 Task 4，FR-IO-001/002；2026-11-14 导入保真 v2）。
//
// file × deps → { title, fileId, state, degraded }：20MB 预检 → parseXmind
// （@gmind/xmind-io v2：树＋resources 资源表＋命名制降级条目）→ 经 @gmind/core 操作层
// 组装 Y.Doc（唯一写入口约束：addChild/setNote/setDescription/setIcon/setHref/setStyle/
// setSummary/setCollapsed/setDocMeta，绝不直改 Y.Map）→ docToState → base64。
//
// 两段式（spec §五）：**无图快路径**维持现状单段行为——不调 deps，fileId=null，
// 调用方照旧 POST /files（现有 e2e 时序零扰动）；**有图两段式**——先 deps.createFile
// （无图 state0）建文件，再逐图 readImageSize→clampImageSize（复用 imageUpload.ts 的
// 200px 钳制，与手动上传同规则）→10MB 预检→deps.uploadImage→setImage
// {key,w,h,placement:align??'bottom'}，全部完成后 deps.putDocState 回写终态 doc-state。
// 任意图失败→计图片降级＋继续，导入不中断。
//
// 落盘接线（v2 补全）：概要（kids.slice(start,end+1)；SUMMARY_INVALID 捕获计概要，
// 校验先于事务零残缺）、结构（首画布 setDocMeta、次画布 addCanvas 带 structureType）、
// 折叠（setCollapsed）与 description/setHref/setStyle 一并落盘；图标组内单枚写失败
// （如 multi 上限拒绝）捕获计图标，不中断导入（markers.ts 头注裁定的胶水职责）。
//
// origin 纪律（v2 顺手修）：全部写入口显式 ORIGIN_SYSTEM——旧实现把 canvasId 误传进
// addChild/setText 等的 origin 形参位；导入是系统语义（不进撤销栈），canvasId 归位。
//
// 错误一律以 Error.message 归因（FR-IO-001；NFR-USE-005 文案均带「原因+下一步」两半）：
// - file.size > 20MB → 「文件大小超过 20MB 上限，请压缩后重试」（解析前预检）；
// - XmindParseError UNSUPPORTED_FORMAT → 「无法识别的文件格式（仅支持 .xmind），请更换文件后重试」；
// - 其余解析/组装错误（GmindCoreError 如 TEXT_TOO_LONG、深树栈溢出 RangeError）→
//   「文件已损坏，无法解析，请检查文件后重试」。
// 降级提示文案（FR-IO-002 v2 逐项点名）由 degradedSummary 统一构造。
import { type IconGroup,
  addCanvas,
  addChild,
  createTemplateDoc,
  docToState,
  GmindCoreError,
  listCanvases,
  ORIGIN_SYSTEM,
  renameCanvas,
  rootIdOf,
  setActiveCanvas,
  setCollapsed,
  setDescription,
  setHref,
  setIcon,
  setImage,
  setNodeSide,
  setNote,
  setStyle,
  setSummary,
  setText,
  setDocMeta,
} from '@gmind/core';
import {
  DEGRADED_LABELS,
  parseXmind,
  XmindParseError,
  type DegradedItem,
  type DegradedKey,
  type XmindNode,
  type XmindResources,
} from '@gmind/xmind-io';
import { clampImageSize, MAX_IMAGE_BYTES, readImageSize } from './imageUpload';

/** .xmind 导入大小上限（FR-IO-001）：超限直接拒绝，不进入解析。 */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** 导入写入口统一 origin：系统语义（不进撤销栈）。 */
const ORIGIN = ORIGIN_SYSTEM;

/** 降级目录键序（degradedSummary 文案序 / 合并后条目排序）：与 xmind-io 单源。 */
const DEGRADED_KEY_ORDER = Object.keys(DEGRADED_LABELS) as DegradedKey[];

/** deps 注入面（有图两段式的三个网络动作；无图快路径三者均不被调）。
 *  uploadImage 类型对齐 imageUpload.ts 真实签名（复用不复制）。 */
export interface ImportDeps {
  /** POST /files：用无图 state0 建文件，返回文件 id。 */
  createFile: (title: string, docStateB64: string) => Promise<{ id: string }>;
  /** POST /files/:id/images：multipart 上传单图，返回存储键。 */
  uploadImage: (fileId: string, file: File) => Promise<{ key: string }>;
  /** PUT /files/:id/doc-state：图片全部落盘后回写终态（不传 baseUpdatedAt，缺省恒放行）。 */
  putDocState: (fileId: string, docStateB64: string) => Promise<void>;
}

export interface ImportXmindResult {
  title: string;
  /** null = 无图快路径（文件未建，调用方照旧 POST /files）；非 null = 两段式已建已回写。 */
  fileId: string | null;
  /** 最终文档状态 base64（快路径 = 无图状态；两段式 = 含图片终态，调用方免再传）。 */
  state: string;
  degraded: DegradedItem[];
}

/** 降级提示文案（FR-IO-002 v2 逐项点名，2026-11-14 裁定 3）：全零「已完整导入」；
 *  否则「未导入：」+ 按 DEGRADED_LABELS 目录序仅列非零项、「、」连接。未知 key
 *  （防御面）无目录标签可写，不进文案。 */
export function degradedSummary(degraded: DegradedItem[]): string {
  const known = degraded
    .filter((d) => d.count > 0 && d.key in DEGRADED_LABELS)
    .sort((a, b) => DEGRADED_KEY_ORDER.indexOf(a.key) - DEGRADED_KEY_ORDER.indexOf(b.key));
  if (known.length === 0) return '已完整导入';
  return `未导入：${known.map((d) => `${DEGRADED_LABELS[d.key]} ${d.count}`).join('、')}`;
}

/** bytes → base64（与 useEditorDoc.ts 的 base64ToBytes 对称的逆变换）。
 *  大数组分块 String.fromCharCode：一次性 spread 会撞引擎实参个数/call stack 上限。 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 降级累计器：parse 产物打底、胶水增量合并；finalize 按目录序出非零条目。 */
class DegradedTally {
  private readonly counts = new Map<DegradedKey, number>();

  constructor(items: DegradedItem[]) {
    for (const d of items) this.counts.set(d.key, (this.counts.get(d.key) ?? 0) + d.count);
  }

  add(key: DegradedKey, n = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  items(): DegradedItem[] {
    return [...this.counts.entries()]
      .filter(([, count]) => count > 0)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => DEGRADED_KEY_ORDER.indexOf(a.key) - DEGRADED_KEY_ORDER.indexOf(b.key));
  }
}

/** 待上传图片任务（walk 期收集：两段式需先建文件拿到 fileId 才能上传）。 */
interface ImageTask {
  nodeId: string;
  canvasId?: string;
  path: string;
  align?: 'top' | 'bottom' | 'left' | 'right';
}

/** .xmind 导入：解析 → core 组装 →（有图两段式上传回写 / 无图快路径）→ 文档状态。
 *  多画布（计划四，裁定 8）：首 Sheet 进首画布（root 文本 = 首 Sheet 根标题，缺省回落
 *  文件名去 .xmind 后缀），其余 Sheet 逐个 addCanvas（name=Sheet 标题，缺省「画布 N」，
 *  structureType 随 opts 携带；首画布结构经 setDocMeta）并按同款先序组装；树按先序
 *  addChild 组装，节点级字段（note/description/icons/href/style/folded/image/summaries）
 *  逐项落盘（见文件头注）。 */
export async function importXmindFile(file: File, deps: ImportDeps): Promise<ImportXmindResult> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('文件大小超过 20MB 上限，请压缩后重试');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let parsed: ReturnType<typeof parseXmind>;
  try {
    parsed = parseXmind(bytes);
  } catch (e) {
    if (e instanceof XmindParseError && e.code === 'UNSUPPORTED_FORMAT') {
      throw new Error('无法识别的文件格式（仅支持 .xmind），请更换文件后重试');
    }
    throw new Error('文件已损坏，无法解析，请检查文件后重试');
  }

  const degraded = new DegradedTally(parsed.degraded);
  // 文件名 vs 中心主题（2026-11-14 需求方拍板）：文件名=原文件名去 .xmind 后缀；
  // 画布中心主题文本保持 XMind 根主题原文（createTemplateDoc 的 title 同时喂根文本与
  // meta.title，中心主题不可跟着文件名变——meta.title 随后 setDocMeta 覆写）。
  // 根主题只作文件名回落（文件名仅剩「.xmind」等失效场景）。
  const baseName = file.name.replace(/\.xmind$/i, '').trim();
  const rootTitle = parsed.sheets[0].root.title;
  const title = baseName || rootTitle;
  const doc = createTemplateDoc({ title: rootTitle, children: [] });
  // 多画布（计划四，裁定 8）：首画布名 = 首 Sheet 标题（XMind 语义：Sheet 名即画布名；
  // 空标题保持「画布 1」缺省）。renameCanvas 走唯一写入口；导入期文档未挂协同，撤销栈无观测。
  const firstCanvasId = listCanvases(doc)[0]?.id;
  if (baseName && baseName !== rootTitle) setDocMeta(doc, { title: baseName }, ORIGIN);
  if (parsed.sheets[0].title && firstCanvasId) {
    renameCanvas(doc, firstCanvasId, parsed.sheets[0].title, ORIGIN);
  }
  // addCanvas 副作用会把 activeCanvasId 拨到新画布——回拨放在全部 sheet 组装完之后
  // （打开文件停在第一张画布；旧实现误放在组装前、被后续 addCanvas 覆盖，本次顺手归位）。

  const imageTasks: ImageTask[] = [];

  /** 图标记落盘：组内单枚失败（multi 上限/目录外值——解析层正常不产，防御捕获）
   *  计图标降级，不中断导入（markers.ts 头注裁定的胶水职责）。 */
  const applyIcons = (id: string, icons: XmindNode['icons'], canvasId?: string): void => {
    if (!icons) return;
    for (const [group, values] of Object.entries(icons)) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        try {
          setIcon(doc, id, group as IconGroup, value, ORIGIN, canvasId);
        } catch (e) {
          if (e instanceof GmindCoreError) degraded.add('icon');
          else throw e;
        }
      }
    }
  };

  /** 概要落盘：start/end = attached 子节点下标闭区间 → kids.slice(start, end+1)；
   *  SUMMARY_INVALID（片段非法/标签超长）捕获计概要——校验先于事务，doc 零残缺。 */
  const applySummaries = (node: XmindNode, childIds: string[], canvasId?: string): void => {
    for (const s of node.summaries ?? []) {
      try {
        setSummary(doc, childIds.slice(s.start, s.end + 1), s.label, ORIGIN, canvasId);
      } catch (e) {
        if (e instanceof GmindCoreError && e.code === 'SUMMARY_INVALID') degraded.add('summary');
        else throw e;
      }
    }
  };

  /** 节点级字段落盘（root 与子节点同款，不特判）：顺序=校验便宜的在前；
   *  image 只登记任务（上传需 fileId，见两段式）。 */
  const applyNodeFields = (node: XmindNode, id: string, canvasId?: string): void => {
    if (node.note) setNote(doc, id, node.note, ORIGIN, canvasId);
    if (node.description) setDescription(doc, id, node.description, ORIGIN, canvasId);
    applyIcons(id, node.icons, canvasId);
    if (node.href) setHref(doc, id, node.href, ORIGIN, canvasId);
    if (node.style && Object.keys(node.style).length > 0) setStyle(doc, id, node.style, ORIGIN, canvasId);
    if (node.folded) setCollapsed(doc, id, true, ORIGIN, canvasId);
    if (node.image) {
      if (parsed.resources[node.image.path]) {
        imageTasks.push({ nodeId: id, canvasId, path: node.image.path, align: node.image.align });
      } else {
        degraded.add('image'); // 防御：解析层契约保证 path 可解析（查无键已在 parse 层计数跳过）
      }
    }
  };

  /** 分侧规则（2026-11-15 按需求方源文件 Gmind问题汇总.xmind 校准）：子树权重最大的
   *  分支**锚定左侧**，文档序在它之前的分支全部居右（保持文档序），它之后的分支随它
   *  居左（引擎左列文档序倒排，视觉顺序即与 XMind 一致）。上一版「轻侧贪心」会把靠前
   *  的小分支甩去左边、打乱读序，被打回；XMind 平衡算法无文档，此为按复测文件校准的
   *  规则，诚实边界见 features 文档④。 */
  const balancedSides = (children: XmindNode[]): Array<'left' | 'right'> => {
    const weight = (n: XmindNode): number => 1 + n.children.reduce((sum, c) => sum + weight(c), 0);
    const weights = children.map(weight);
    let maxIdx = 0;
    weights.forEach((w, i) => {
      if ((w as number) > (weights[maxIdx] as number)) maxIdx = i;
    });
    return children.map((_, i) => (i >= maxIdx ? 'left' : 'right'));
  };

  /** 先序组装（walk 携带节点 id）：本节点字段 → 子节点 addChild 收集 id → 概要 → 递归；
   *  返回直接子节点 id（画布根分支均衡定侧用）。 */
  const walk = (node: XmindNode, id: string, canvasId?: string): string[] => {
    applyNodeFields(node, id, canvasId);
    const childIds = node.children.map((child) => addChild(doc, id, { text: child.title }, ORIGIN, canvasId));
    applySummaries(node, childIds, canvasId);
    childIds.forEach((childId, i) => walk(node.children[i] as XmindNode, childId, canvasId));
    return childIds;
  };

  try {
    parsed.sheets.forEach((sheet, i) => {
      let canvasId: string | undefined;
      if (i === 0) {
        // 首画布结构类经 setDocMeta（画布缺省解析=第一画布）；未映射 sheet 无此项。
        if (sheet.structureType) setDocMeta(doc, { structureType: sheet.structureType }, ORIGIN);
      } else {
        canvasId = addCanvas(
          doc,
          {
            name: sheet.title || `画布 ${i + 1}`,
            ...(sheet.structureType ? { structureType: sheet.structureType } : {}),
          },
          ORIGIN,
        );
      }
      const rootId = rootIdOf(doc, canvasId);
      if (i > 0 && sheet.root.title) setText(doc, rootId, sheet.root.title, ORIGIN, canvasId); // 附加画布根文本 = Sheet 根标题
      const rootChildIds = walk(sheet.root, rootId, canvasId);
      // 左右均衡定侧（2026-11-14 需求方拍板）：mindmap 画布（未指定结构亦缺省 mindmap）
      // 根分支按子树规模均衡；logic/org 侧别无语义不处理。setNodeSide 同值守卫零开销。
      if ((sheet.structureType ?? 'mindmap') === 'mindmap') {
        balancedSides(sheet.root.children).forEach((side, i) =>
          setNodeSide(doc, rootChildIds[i] as string, side, ORIGIN, canvasId),
        );
      }
    });
  } catch (e) {
    // core 组装失败归因（M4 挂账清偿）：解析出的树超出文档模型可承载范围——
    // GmindCoreError（如 TEXT_TOO_LONG）与深树递归的栈溢出（RangeError）都按解析失败
    // 同文案兜底，core 错误不裸抛给用户。降级捕获类（图标/概要/图片）不在此列。
    if (e instanceof GmindCoreError || e instanceof RangeError) {
      throw new Error('文件已损坏，无法解析，请检查文件后重试');
    }
    throw e;
  }

  if (firstCanvasId) setActiveCanvas(doc, firstCanvasId); // 组装后回拨首画布（见上方注释）

  const stateOf = (): string => bytesToBase64(docToState(doc));

  // —— 两段式（spec §五）：有图才建文件；无图快路径保持现状单段（e2e 时序零扰动）——
  let fileId: string | null = null;
  if (imageTasks.length > 0) {
    fileId = (await deps.createFile(title, stateOf())).id;
    await uploadImages(doc, imageTasks, parsed.resources, fileId, deps, degraded);
    await deps.putDocState(fileId, stateOf()); // 全部图处理完（无论成败）回写终态
  }

  return { title, fileId, state: stateOf(), degraded: degraded.items() };
}

/** 逐图上传并 setImage：readImageSize → clampImageSize（复用 200px 钳制，与手动上传
 *  同规则）→ 10MB 预检 → uploadImage → setImage {key,w,h,placement:align??'bottom'}。
 *  任意图失败（解析尺寸/上传/落盘）→ 计图片降级＋继续，导入不中断（spec §五）。 */
async function uploadImages(
  doc: ReturnType<typeof createTemplateDoc>,
  tasks: ImageTask[],
  resources: XmindResources,
  fileId: string,
  deps: ImportDeps,
  degraded: DegradedTally,
): Promise<void> {
  for (const task of tasks) {
    const resource = resources[task.path];
    if (!resource) {
      degraded.add('image'); // 防御（同 applyNodeFields 契约注释）
      continue;
    }
    try {
      const name = task.path.split('/').pop() || 'image';
      const imageFile = new File([resource.bytes as BlobPart], name, { type: resource.mime });
      if (imageFile.size > MAX_IMAGE_BYTES) {
        degraded.add('image'); // 10MB 预检（与手动上传同规则）前置：不发起上传也不必解码尺寸（终审 Minor#4）
        continue;
      }
      const { w: naturalW, h: naturalH, url } = await readImageSize(imageFile);
      const { w, h } = clampImageSize(naturalW, naturalH); // ≤200px 等比钳制（与手动上传同规则）
      try {
        const { key } = await deps.uploadImage(fileId, imageFile);
        setImage(doc, task.nodeId, { key, w, h, placement: task.align ?? 'bottom' }, ORIGIN, task.canvasId);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      degraded.add('image'); // 尺寸解析/上传/落盘失败：单图降级，导入继续
    }
  }
}
