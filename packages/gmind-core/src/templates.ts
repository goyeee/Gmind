import type { TemplateSpec } from './doc';

/** 注册赠送的 3 个示例脑图（FR-ACC-001）。 */
export const SEED_TEMPLATES: TemplateSpec[] = [
  {
    title: '欢迎使用 Gmind',
    children: [
      {
        text: '基本操作',
        children: [{ text: 'Enter 新建同级节点' }, { text: 'Tab 新建子节点' }, { text: '拖拽节点调整结构' }],
      },
      {
        text: '协作能力',
        children: [{ text: '分享链接邀请协作者' }, { text: '节点级评论与 @ 提醒' }],
      },
      { text: '本文件可随意修改或删除' },
    ],
  },
  {
    title: '产品需求评审纪要',
    structure: 'org',
    children: [
      { text: '参会人', children: [{ text: '待补充' }] },
      { text: '评审结论', children: [{ text: '通过 / 有条件通过 / 驳回' }] },
      { text: '待办事项', children: [{ text: '更新 PRD' }, { text: '排期确认' }] },
    ],
  },
  {
    title: '本周计划',
    children: [
      { text: '周一', children: [{ text: '周会对齐' }] },
      { text: '周三', children: [{ text: '方案评审' }] },
      { text: '周五', children: [{ text: '周报复盘' }] },
    ],
  },
];
