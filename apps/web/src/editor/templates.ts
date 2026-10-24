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
  /** 画廊卡片/预览的一句话简介。 */
  blurb: string;
  /** 模板中心分类 chip（2026-10-24 原型换装：全部/会议/项目/团队/学习/个人；缺省只在「全部」出现）。 */
  category?: string;
  /** 装饰性缩略图主色（企微色系取板）。 */
  accent: string;
  spec: TemplateSpec;
}

/** 精选模板（顺序即画廊展示序）。 */
export const TEMPLATE_CATALOG: WorkspaceTemplate[] = [
  {
    id: 'weekly-plan',
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
];
