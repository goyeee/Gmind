export const MAX_TEXT_LENGTH = 500;
export const MAX_NOTE_LENGTH = 5000;
/** 节点描述上限（M7c-C1，对齐 mindgrid TaskNode.description）：一句话任务描述，
 *  与 note（企微备注角标语义）并存、语义不同——上限与 mindgrid 同为 200 字。 */
export const MAX_DESCRIPTION_LENGTH = 200;

/**
 * 标记八组制（M7b-W1，2026-09-29 需求方裁定「企微全量对标」）：M7a 三组制
 * （priority/icon/emoji）扩容为企微标记面板全量八组——mood 心情(5) / priority
 * 优先级(9) / number 数字(10) / arrow 箭头(5) / flag 旗帜(3) / progress 进度(9) /
 * other 其他(27) / emoji 表情(28)。值目录（组→值 slug/字符）由本模块单源导出：
 * setIcon 值校验、repair 旧值收敛、xmind-io 目录对齐与消费方目录遍历都指向这里；
 * 字形/配色的渲染层数据在 @gmind/engine MARKER_CATALOG（web MarkerPanel 同源消费）。
 *
 * 组语义（W0 企微实测矩阵，组内语义常量化可切换）见 MARKER_GROUP_MODE；
 * 存储为组值数组（见 operations.ts setIcon 头注的 Yjs 形状裁定）。
 */
export const ICON_GROUPS = [
  'mood',
  'priority',
  'number',
  'arrow',
  'flag',
  'progress',
  'other',
  'emoji',
] as const;
export type IconGroup = (typeof ICON_GROUPS)[number];

/**
 * 组语义矩阵（M7b-W1，企微实测定案）：优先级/心情/数字/箭头/旗帜/进度 = 组内
 * 单选替换（再点同值=移除该组）；其他/表情 = 组内多选叠加（单组上限
 * MARKER_MULTI_MAX，再点同值=移除该枚）；跨组并存。常量导出供 W3 面板/批量
 * 标记逻辑复用（「全含则移除否则设置」按组模式展开）。
 */
export type MarkerGroupMode = 'single' | 'multi';
export const MARKER_GROUP_MODE: Record<IconGroup, MarkerGroupMode> = {
  mood: 'single',
  priority: 'single',
  number: 'single',
  arrow: 'single',
  flag: 'single',
  progress: 'single',
  other: 'multi',
  emoji: 'multi',
};

/** multi 组单组上限（M7b-W1：超出拒绝 INVALID_ICON_OVERFLOW）。 */
export const MARKER_MULTI_MAX = 8;

/** 心情组（5，企微截图转录：橙底白脸 微笑/难过/哭/爱心眼/飞吻）。 */
export const MOOD_VALUES = ['smile', 'sad', 'cry', 'love', 'kiss'] as const;

/**
 * 优先级组（9，企微截图转录）：P0 红 / P1 橙 / P2 黄 / P3 绿 / P4 浅蓝 /
 * 急 红 / 高 橙 / 中 绿 / 低 深灰。slug 即目录值（PRIORITY_LEGACY_MAP 负责
 * M7a 数字档 '1'-'7' 的落位）。
 */
export const PRIORITY_VALUES = ['p0', 'p1', 'p2', 'p3', 'p4', 'urgent', 'high', 'mid', 'low'] as const;

/** 数字组（10，企微截图转录：蓝色圆徽 1-9、0）。 */
export const NUMBER_VALUES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;

/** 箭头组（5，企微截图转录：蓝色 ← → ↑ ↓ ↔）。 */
export const ARROW_VALUES = ['left', 'right', 'up', 'down', 'leftright'] as const;

/** 旗帜组（3，企微截图转录：红旗 波浪旗/方旗/三角旗；旧颜色信息无对应位，丢弃）。 */
export const FLAG_VALUES = ['flag', 'flagRect', 'flagPennant'] as const;

/**
 * 进度组（9，企微截图转录：未开始空心环 + 绿色饼图 1/8→7/8 + 完成对勾；XMind 进度
 * 八档同构，首位「未开始」为 2026-10-01 需求方反馈任务 3 补档）。组 id/存储键仍是
 * 'progress'（既有文档零迁移），组显示名改「进度」（engine MARKER_GROUP_LABELS）。
 * slug 口径：none=未开始（0%，空心环）、p12=1/8、p25=1/4、p37=3/8、p50=1/2、
 * p62=5/8、p75=3/4、p87=7/8、done=完成。旧百分比环经 progressStageOf 落对应档
 * （0% → none）。
 */
export const PROGRESS_VALUES = [
  'none',
  'p12',
  'p25',
  'p37',
  'p50',
  'p62',
  'p75',
  'p87',
  'done',
] as const;

/**
 * other 组（27，企微截图「其他」组逐枚转录）：done ✓绿 / cancel ✕红 / calendar
 * 蓝方块31 / clock 蓝闹钟 / alert 黄三角! / info 蓝i / question 橙? / important
 * 橙星 / idea 黄灯泡 / pie 绿饼图 / group 蓝人群 / lock 蓝闭锁 / unlock 蓝开锁 /
 * plus 蓝+ / link 蓝曲别针 / nut 蓝螺母 / person 蓝人 / phone 绿手机 / tablet 黄平板 /
 * like 橙赞 / unlike 蓝踩 / key 绿钥匙 / heart 红心 / heartbroken 红碎心 / money
 * 橙钱袋 / pen 蓝笔 / printer 黄打印机。
 */
export const OTHER_VALUES = [
  'done',
  'cancel',
  'calendar',
  'clock',
  'alert',
  'info',
  'question',
  'important',
  'idea',
  'pie',
  'group',
  'lock',
  'unlock',
  'plus',
  'link',
  'nut',
  'person',
  'phone',
  'tablet',
  'like',
  'unlike',
  'key',
  'heart',
  'heartbroken',
  'money',
  'pen',
  'printer',
] as const;

/**
 * emoji 组（28，企微截图「emoji」组逐枚转录；黄脸表情/手势等企微贴图组按
 * 字形近似为 emoji 字符，近似清单登记于 markers 转录回报）。
 */
export const EMOJI_VALUES = [
  '😊',
  '😌',
  '😙',
  '😓',
  '😰',
  '😝',
  '😄',
  '😜',
  '😀',
  '😍',
  '😔',
  '😁',
  '😏',
  '😑',
  '😳',
  '😘',
  '😭',
  '😱',
  '🤣',
  '💪',
  '👊',
  '👍',
  '👏',
  '👎',
  '🙏',
  '👌',
  '☝️',
  '👀',
] as const;

/** 组 → 值目录（setIcon 值校验与消费方目录遍历的统一入口）。 */
export function iconValuesOf(group: IconGroup): readonly string[] {
  switch (group) {
    case 'mood':
      return MOOD_VALUES;
    case 'priority':
      return PRIORITY_VALUES;
    case 'number':
      return NUMBER_VALUES;
    case 'arrow':
      return ARROW_VALUES;
    case 'flag':
      return FLAG_VALUES;
    case 'progress':
      return PROGRESS_VALUES;
    case 'other':
      return OTHER_VALUES;
    default:
      return EMOJI_VALUES;
  }
}

/**
 * 旧优先级档 → 新目录映射（repair/xmind-io 共用；M7a 口径 '1'-'7' 按档位保留
 * 进企微九档：1 红→p0、2 橙→p1、3 黄→p2、4 绿→p3、5 蓝→p4、6 紫→mid、7 灰→low；
 * 8/9 先按 M7a clamp 到 7 再映射。「保留」= 标记不丢弃，落企微同档位）。
 */
export const PRIORITY_LEGACY_MAP: Record<string, string> = {
  '1': 'p0',
  '2': 'p1',
  '3': 'p2',
  '4': 'p3',
  '5': 'p4',
  '6': 'mid',
  '7': 'low',
};

/** M7a icon 组 10 slug → 新组落位（repair/xmind-io 共用；颜色/形状信息无对应位按
 *  M7a 口径丢弃：like ♥→heart（喜欢语义保真）、link 🔗→link（曲别针近似）、
 *  clock ⏰→clock（闹钟同义）、flag ⚑→flag 组 'flag'）。 */
export const ICON_LEGACY_MAP: Record<string, { group: IconGroup; value: string }> = {
  done: { group: 'other', value: 'done' },
  cancel: { group: 'other', value: 'cancel' },
  important: { group: 'other', value: 'important' },
  question: { group: 'other', value: 'question' },
  alert: { group: 'other', value: 'alert' },
  idea: { group: 'other', value: 'idea' },
  like: { group: 'other', value: 'heart' },
  link: { group: 'other', value: 'link' },
  clock: { group: 'other', value: 'clock' },
  flag: { group: 'flag', value: 'flag' },
};

/** 旧百分比进度环（M6 '0%'-'100%'，repair/xmind-io 共用）→ 进度组对应档
 *  （最近档：round(pct/12.5) 钳 0-8，0=none 未开始、8=done）。 */
export const PROGRESS_LEGACY_VALUES = ['0%', '10%', '25%', '40%', '50%', '60%', '75%', '100%'] as const;

/**
 * 百分比 → 进度组档位 slug（非法/越界输入返回 null，调用方确定性丢弃）。
 * 2026-10-01 补档「未开始」（PROGRESS_VALUES[0]='none'）后索引直接对位：
 * 0-6.25% 最近档为 none（0% 旧版落 p12，现语义修正为未开始），1-7 档 slug 与
 * 8=done 落位与旧版一致。
 */
export function progressStageOf(pct: number): string | null {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  const idx = Math.min(8, Math.max(0, Math.round(pct / 12.5)));
  return PROGRESS_VALUES[idx] as string;
}

/* ── 任务字段约束（M7a-T1，setNodeTask 校验口径单源）────────────────────── */

export const TASK_STATUSES = ['todo', 'doing', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 负责人上限：去重后 ≤20 项，每项（用户ID）长度 1-64。 */
export const MAX_TASK_OWNERS = 20;
export const TASK_OWNER_MIN_LENGTH = 1;
export const TASK_OWNER_MAX_LENGTH = 64;

/** 'YYYY-MM-DD'（repair/read 防御读取与 op 校验共用的形状正则；合法性另做日历校验）。 */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 日期字符串日历合法性（形状 + 年月日回读一致，覆盖大小月/闰年边界）；read 与
 *  setNodeTask 校验共用的单源实现。 */
export function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/* ── 表格自定义列约束（doc 级 schema + 节点 custom 值；setCustomColumns /
 *    setCustomField 校验、read 防御读取、repair 收敛的口径单源）────────────── */

/** 列类型目录（需求方原话「可以自定义文本、人员、进度、日期类型的列」）。 */
export const CUSTOM_COLUMN_TYPES = ['text', 'person', 'progress', 'date'] as const;
export type CustomColumnType = (typeof CUSTOM_COLUMN_TYPES)[number];

/** doc 级 schema 上限：最多 20 列，超出写入口抛 CUSTOM_COLUMN_OVERFLOW。 */
export const CUSTOM_COLUMN_LIMIT = 20;

/** 列名长度：非空且 ≤30 字（写入口 CUSTOM_COLUMN_INVALID 拒绝空/超长）。 */
export const CUSTOM_COLUMN_NAME_MAX = 30;

/** text 列值上限：与节点文本 MAX_TEXT_LENGTH(500) 同口径。 */
export const CUSTOM_TEXT_MAX_LENGTH = MAX_TEXT_LENGTH;

/**
 * 自定义列定义（meta.customColumns 数组项）：id 由调用方生成（ULID 或 8 位随机
 * 均可，写入口只约束非空唯一）；name 1-30 字；type ∈ CUSTOM_COLUMN_TYPES。
 */
export interface CustomColumnDef {
  id: string;
  name: string;
  type: CustomColumnType;
}

/** 节点 custom 值联合：text=string、person=用户ID string[]（复用任务 owners 的
 *  项长/去重/上限规则）、progress=0-100 整数、date='YYYY-MM-DD'；null=删键（无键）。 */
export type CustomFieldValue = string | string[] | number | null;

/**
 * meta.customColumns 防御读取/规范化（纯函数）：read.getMeta 透传、operations 两个
 * op 的 schema 查找、repair.planCustomRepair 的替换判定共用此单源。
 * 规则：非数组 → []；逐项形状防御（非对象 / id 非空串 / name 非空且 ≤30 字 /
 * type ∈ 目录，任一不符剔除该项）；重复 id 保留首项；超 CUSTOM_COLUMN_LIMIT
 * 截断前 20 项。写入口（setCustomColumns）按严格校验拒绝，此处只兜远端坏数据
 * / crafted doc_state（同 isValidDateStr 的「校验器 + 防御器」分层）。
 */
export function canonicalCustomColumns(raw: unknown): CustomColumnDef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomColumnDef[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const { id, name, type } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') continue;
    if (seen.has(id)) continue;
    if (typeof name !== 'string' || name === '' || name.length > CUSTOM_COLUMN_NAME_MAX) continue;
    if (!(CUSTOM_COLUMN_TYPES as readonly string[]).includes(type as string)) continue;
    seen.add(id);
    out.push({ id, name, type: type as CustomColumnType });
    if (out.length >= CUSTOM_COLUMN_LIMIT) break;
  }
  return out;
}

/** custom 值与列类型的**形状**判定（repair 删键口径）：text=串、person=串数组、
 *  progress=0-100 整数、date=日历合法串。只判形状不做值域收敛（text 长度/person
 *  去重上限不在此处——写入口已归一，repair 保持「只删不改」的最小修复面，见
 *  planCustomRepair 头注）。 */
export function isValidCustomValueOfType(type: CustomColumnType, value: unknown): boolean {
  switch (type) {
    case 'text':
      return typeof value === 'string';
    case 'person':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'progress':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
    case 'date':
      return typeof value === 'string' && isValidDateStr(value);
  }
}

/* ── 表格视图列体系（meta.tableView；统一列模型：内置列 + 自定义列同列清单）──── */

/**
 * 内置列固定 key（需求方 2026-10-01「自定义列能挪进固定列中间」）：与自定义列
 * colId 同处一个有序清单。'owner' 与 shared sortValue 的排序键同名（读取侧零映射），
 * 与节点 task.owners 字段名差一个 s——web 渲染侧负责对应（testid 仍用 -owners）。
 */
export const TABLE_BUILTIN_COLUMN_KEYS = [
  'title',
  'owner',
  'status',
  'progress',
  'startDate',
  'dueDate',
  'doneDate',
  'updatedAt',
] as const;

/** 任务名不可隐藏（需求方列体系升级，core 层裁定）：行锚点列，隐藏后行失去识别
 *  与标题编辑入口——canonical 层恒从 hidden 剔除，UI 复选框置灰只作展示。 */
export const TABLE_UNHIDABLE_COLUMN_KEYS: readonly string[] = ['title'];

/** 表格视图持久态（meta.tableView）：统一列序 order（全列 key 完整排列，缺省=
 *  内置序+自定义列尾）/ 隐藏 hidden / 固定（冻结左侧）pinned / 显示层排序 sort。 */
export interface TableViewSort {
  /** 排序列 key（内置 key 或自定义列 colId）。 */
  key: string;
  /** 1=升序、-1=降序。 */
  dir: 1 | -1;
}

export interface TableViewMeta {
  /** 全列 key 的完整排列（canonical 补全后恒覆盖 内置∪当前自定义列 的每个 key）。 */
  order: string[];
  /** 隐藏列 key 集（'title' 恒被剔除，见 TABLE_UNHIDABLE_COLUMN_KEYS）。 */
  hidden: string[];
  /** 固定（冻结）到表格左侧的列 key 集（渲染相对序仍按 order）。 */
  pinned: string[];
  /** 显示层排序态（不动树结构）；null=无排序（树序）。 */
  sort: TableViewSort | null;
}

/** 列 key 合法集：内置 key ∪ 当前自定义列 id。 */
function validColumnKeys(customColumns: CustomColumnDef[]): Set<string> {
  const set = new Set<string>(TABLE_BUILTIN_COLUMN_KEYS);
  for (const c of customColumns) set.add(c.id);
  return set;
}

/** 缺省列序：内置序在前、自定义列按 schema 序追加在后。 */
function defaultColumnOrder(customColumns: CustomColumnDef[]): string[] {
  return [...TABLE_BUILTIN_COLUMN_KEYS, ...customColumns.map((c) => c.id)];
}

/** 字符串数组防御：非数组→fallback；过滤合法 key、去重保首（in-place 语义纯函数）。 */
function canonicalKeyArray(raw: unknown, valid: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of raw) {
    if (typeof key !== 'string' || key === '' || seen.has(key) || !valid.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * meta.tableView 防御读取/规范化（纯函数，canonicalCustomColumns 同款分层）：
 * read.getMeta 透传 + operations.setTableView 写入归一共用此单源。规则：
 * - raw 非对象（含 undefined/数组）→ undefined（缺省，消费侧按默认列序处理）；
 * - order 非字符串数组 → 缺省序（内置+自定义尾）；否则过滤合法 key、去重保首、
 *   缺失 key 按缺省序追加补全（恒为 内置∪自定义 的完整排列——新加列自动落尾、
 *   已删列的残留 key 剔除）；
 * - hidden/pinned 非字符串数组 → []；过滤 + 去重；hidden 恒剔 'title'（不可隐藏）；
 * - sort 非 {key,dir} 形状（key 不在合法集 / dir 非 ±1）→ null。
 * 写入口按同规则归一后落盘，远端坏数据/crafted doc_state 只影响读取、不抛错。
 */
export function canonicalTableView(
  raw: unknown,
  customColumns: CustomColumnDef[],
): TableViewMeta | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const valid = validColumnKeys(customColumns);
  const order = canonicalKeyArray(rec.order, valid);
  const missing = defaultColumnOrder(customColumns).filter((k) => !order.includes(k));
  const hidden = canonicalKeyArray(rec.hidden, valid).filter(
    (k) => !TABLE_UNHIDABLE_COLUMN_KEYS.includes(k),
  );
  const pinned = canonicalKeyArray(rec.pinned, valid);
  const sortRaw = rec.sort;
  const sort: TableViewSort | null =
    sortRaw !== null && typeof sortRaw === 'object' && !Array.isArray(sortRaw)
      ? (() => {
          const s = sortRaw as Record<string, unknown>;
          const key = typeof s.key === 'string' ? s.key : '';
          const dir = s.dir;
          return valid.has(key) && (dir === 1 || dir === -1)
            ? { key, dir: dir as 1 | -1 }
            : null;
        })()
      : null;
  return { order: [...order, ...missing], hidden, pinned, sort };
}
