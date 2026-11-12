/**
 * 内置精选模板目录（2026-10-20 工作台重设计，需求方裁定：内置精选、用户自制不做）：
 * 「模板库」视图画廊 + 「从模板创建」快速卡的数据源。模板本体 = core TemplateSpec
 * （createTemplateDoc 直出 Y.Doc，客户端侧生成 docState 走 POST /files 既有导入
 * 落库路径，服务端零改动）。thumbnail 为装饰性迷你图配色（accent）。
 */
import type { TemplateSpec } from '@gmind/core';

export interface WorkspaceTemplate {
  id: string;
  name: string;
  /** 画廊底部使用人数文案（原型 uses 口径，如 '3.2 万'）。 */
  uses: string;
  /** 角标：'热门'=红 Flame、'新'=品牌 Sparkles。 */
  tag?: '热门' | '新';
  /** 画廊卡片/预览的一句话简介。 */
  blurb: string;
  /** 模板中心分类 chip（2026-10-24 原型换装：全部/会议/项目/团队/学习/个人/表格；缺省只在「全部」出现）。 */
  category?: string;
  /** 文件类型（2026-10-25 原型表格类模板）：'table'=建表格文件（默认开表格视图）；
   *  缺省 map。 */
  kind?: 'map' | 'table';
  /** 装饰性缩略图主色（企微色系取板）。 */
  accent: string;
  spec: TemplateSpec;
}

/** 精选模板（顺序即画廊展示序）。 */
export const TEMPLATE_CATALOG: WorkspaceTemplate[] = [
  {
    id: 'weekly-plan',
    uses: '3.6 万',
    name: '每周计划',
    blurb: '按工作日铺开一周安排，适合个人/团队周计划',
    category: '个人',
    accent: '#3370ff',
    spec: {
      title: '每周计划',
      children: [
        { text: '周一', children: [{ text: '本周目标对齐' }] },
        { text: '周二', children: [{ text: '需求拆解' }] },
        { text: '周三', children: [{ text: '方案评审' }] },
        { text: '周四', children: [{ text: '开发联调' }] },
        { text: '周五', children: [{ text: '复盘与下周预告' }] },
      ],
    },
  },
  {
    id: 'meeting-notes',
    uses: '5.8 万',
    tag: '热门',
    name: '会议纪要',
    blurb: '议题/结论/待办三段式，开完即成型',
    category: '会议',
    accent: '#0d9488',
    spec: {
      title: '会议纪要',
      children: [
        { text: '会议信息', children: [{ text: '时间 / 地点 / 参会人' }] },
        { text: '议题讨论', children: [{ text: '议题一' }, { text: '议题二' }] },
        { text: '结论', children: [{ text: '达成一致的结论' }] },
        { text: '待办', children: [{ text: '负责人 + 截止时间' }] },
      ],
    },
  },
  {
    id: 'okr',
    uses: '3.2 万',
    tag: '热门',
    name: 'OKR 目标管理',
    blurb: '目标 → 关键结果 → 行动项，季度对齐神器',
    category: '团队',
    accent: '#7c3aed',
    spec: {
      title: 'OKR 目标管理',
      children: [
        {
          text: '目标 O1',
          children: [
            { text: '关键结果 KR1' },
            { text: '关键结果 KR2' },
            { text: '关键结果 KR3' },
          ],
        },
        { text: '目标 O2', children: [{ text: '关键结果 KR1' }, { text: '关键结果 KR2' }] },
        { text: '行动项', children: [{ text: '本周动作' }] },
      ],
    },
  },
  {
    id: 'reading-notes',
    uses: '4.1 万',
    name: '读书笔记',
    blurb: '摘录/感悟/行动三层沉淀，读完不白读',
    category: '学习',
    accent: '#ea580c',
    spec: {
      title: '读书笔记',
      children: [
        { text: '书籍信息', children: [{ text: '作者 / 出版时间' }] },
        { text: '摘录', children: [{ text: '金句与要点' }] },
        { text: '感悟', children: [{ text: '我的理解' }] },
        { text: '行动', children: [{ text: '可以马上做的事' }] },
      ],
    },
  },
  {
    id: 'project-review',
    uses: '2.9 万',
    name: '项目复盘',
    blurb: '回顾目标/评估结果/分析原因/总结规律',
    category: '项目',
    accent: '#db2777',
    spec: {
      title: '项目复盘',
      children: [
        { text: '回顾目标', children: [{ text: '当初要达成什么' }] },
        { text: '评估结果', children: [{ text: '亮点' }, { text: '不足' }] },
        { text: '分析原因', children: [{ text: '成功因素' }, { text: '失败根因' }] },
        { text: '总结规律', children: [{ text: '下次怎么做' }] },
      ],
    },
  },
  {
    id: 'org-structure',
    uses: '1.9 万',
    name: '组织架构图',
    blurb: '自上而下的组织/汇报关系梳理（org 结构）',
    category: '团队',
    accent: '#0891b2',
    spec: {
      title: '组织架构',
      structure: 'org',
      children: [
        { text: '负责人', children: [{ text: '职能 A' }, { text: '职能 B' }] },
      ],
    },
  },
  // —— 表格类模板（2026-10-25 原型：任务看板/迭代跟踪表；节点带进度/日期预置，
  //    负责人不预置——模板无真实账号可指，落库后自行分配） ——
  {
    id: 'task-board',
    uses: '2.6 万',
    tag: '热门',
    name: '任务看板',
    blurb: '按阶段推进的任务清单，进度与截止一目了然',
    category: '表格',
    kind: 'table',
    accent: '#16a34a',
    spec: {
      title: '任务看板',
      children: [
        { text: '待办', children: [{ text: '需求整理', task: { progress: 0 } }, { text: '技术方案', task: { progress: 0 } }] },
        { text: '进行中', children: [{ text: '接口开发', task: { progress: 40 } }, { text: '视觉走查', task: { progress: 70 } }] },
        { text: '已完成', children: [{ text: '立项评审', task: { progress: 100 } }] },
      ],
    },
  },
  {
    id: 'iteration-tracker',
    uses: '9 千',
    tag: '新',
    name: '迭代跟踪表',
    blurb: '一个迭代一张表，任务/进度/截止集中追踪',
    category: '表格',
    kind: 'table',
    accent: '#0ea5e9',
    spec: {
      title: '迭代跟踪表',
      children: [
        { text: '第一周', children: [{ text: '联调提测', task: { progress: 100 } }, { text: '用例补齐', task: { progress: 50 } }] },
        { text: '第二周', children: [{ text: '回归测试', task: { progress: 0 } }, { text: '发布准备', task: { progress: 0 } }] },
      ],
    },
  },
  {
    id: 't-brain',
    name: '头脑风暴',
    uses: '2.4 万',
    blurb: '围绕一个主题发散、聚类、收敛',
    category: '会议',
    accent: '#f59e0b',
    spec: {
      title: '新品命名',
      children: [
        { text: '发散', children: [{ text: '关键词' }, { text: '类比' }, { text: '反向思考' }] },
        { text: '聚类', children: [{ text: '情感类' }, { text: '功能类' }] },
        { text: '候选', children: [{ text: '方案 A' }, { text: '方案 B' }, { text: '方案 C' }] },
        { text: '投票', children: [{ text: '规则' }, { text: '结果' }] },
      ],
    },
  },
  {
    id: 't-prd',
    name: '产品需求文档',
    uses: '1.7 万',
    tag: '新',
    blurb: '背景、用户故事、方案与指标',
    category: '项目',
    accent: '#8b5cf6',
    spec: {
      title: 'PRD · 智能搜索',
      children: [
        { text: '背景', children: [{ text: '问题' }, { text: '机会' }] },
        { text: '用户故事', children: [{ text: '新用户' }, { text: '高频用户' }] },
        { text: '方案', children: [{ text: '交互' }, { text: '算法' }, { text: '边界' }] },
        { text: '指标', children: [{ text: '北极星' }, { text: '护栏指标' }] },
      ],
    },
  },
  {
    id: 't-swot',
    name: 'SWOT 分析',
    uses: '1.3 万',
    blurb: '优势、劣势、机会与威胁四象限',
    category: '项目',
    accent: '#f43f5e',
    spec: {
      title: 'SWOT',
      children: [
        { text: '优势 S', children: [{ text: '技术积累' }, { text: '品牌' }] },
        { text: '劣势 W', children: [{ text: '渠道单一' }] },
        { text: '机会 O', children: [{ text: '新市场' }, { text: '政策' }] },
        { text: '威胁 T', children: [{ text: '竞品' }, { text: '成本' }] },
      ],
    },
  },
  {
    id: 't-know',
    name: '知识体系',
    uses: '1.9 万',
    blurb: '把零散知识串成可检索的结构',
    category: '学习',
    accent: '#06b6d4',
    spec: {
      title: '前端知识图谱',
      children: [
        { text: '语言', children: [{ text: 'JavaScript' }, { text: 'TypeScript' }] },
        { text: '框架', children: [{ text: 'React' }, { text: 'Vue' }] },
        { text: '工程化', children: [{ text: '构建' }, { text: '测试' }] },
        { text: '性能', children: [{ text: '加载' }, { text: '渲染' }] },
      ],
    },
  },
  {
    id: 't-trip',
    name: '旅行清单',
    uses: '2.2 万',
    blurb: '行程、预算与装备不再遗漏',
    category: '个人',
    accent: '#06b6d4',
    spec: {
      title: '云南旅行',
      children: [
        { text: '行程', children: [{ text: '大理' }, { text: '丽江' }, { text: '香格里拉' }] },
        { text: '预算', children: [{ text: '交通' }, { text: '住宿' }] },
        { text: '装备', children: [{ text: '衣物' }, { text: '证件' }] },
        { text: '美食', children: [{ text: '过桥米线' }] },
      ],
    },
  },
];
