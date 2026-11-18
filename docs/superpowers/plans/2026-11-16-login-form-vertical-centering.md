# 登录页原型布局修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左侧插画与文案不再重叠，右侧表单按最新原型调整垂直位置。

**Architecture:** 保留 `InfiniteMap`，将左栏从互相覆盖的绝对定位改为三段正常文档流；右栏复用现有 flex 居中并增加底部间距。用 Playwright 断言实际元素位置。

**Tech Stack:** React、CSS、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-16-login-form-vertical-centering-design.md`

## Global Constraints

- 保留 `InfiniteMap` 和四个特点标签；视觉细节与文案以 Task 2 的最新设计稿要求为准。
- 不改变登录、注册、忘记密码的内容、交互、testid 或业务逻辑。
- 保留工作区其他未提交改动；未经明确指令不得提交或推送。

## Review Focus

- 不同桌面视口下各段不得重叠，由 Task 1 的 `1440×900`、`1024×768` 位置断言覆盖。
- 手机视口不显示左栏，右侧位置仍正确，由 Task 1 的 `390×844` 断言覆盖。
- 三视图交互不能变化，由 Task 1 完整运行 `login-page.e2e.spec.ts` 覆盖。

---

### Task 1: 登录页左右栏布局

**Files:**
- Modify: `apps/web/src/pages/LoginPage.tsx:163-190`
- Modify: `apps/web/src/styles.css:32-64`
- Test: `apps/web/e2e/login-page.e2e.spec.ts`

**Interfaces:**
- Consumes: 现有 `InfiniteMap`、`.login-hero`、`.login-panel`。
- Produces: 三段不重叠的左栏，以及居中并保留 `4vh` 底部间距的右栏。

- [x] **Step 1: 写失败测试**

新增两项用例：
1. 「登录页左侧按原型三段排列，插画不与文案重叠」：在 `1440×900`、`1024×768` 下，断言标志底部不超过插画顶部、插画底部不超过标题顶部、特点标签底部不超过版权行顶部。
2. 「登录表单按原型垂直居中并保留 4vh 底部空间」：在 `1280×800`、`390×844` 下，断言 `.login-page` 的垂直中心等于 `.login-panel` 扣除视口高度 4% 底部空间后的内容区中心，允许 1px 舍入误差。

- [x] **Step 2: 验证测试先失败**

Run: `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web exec playwright test e2e/login-page.e2e.spec.ts --grep "原型"`
Expected: FAIL；左栏插画覆盖各段，右栏当前没有底部空间。

- [x] **Step 3: 实现最小布局修正**

- `.login-hero` 取消整体居中，使用正常三段纵向排列。
- `.login-hero-logo`、`.login-hero-art`、`.login-hero-copy` 取消绝对定位；插画段占据剩余空间并居中，左右负边距与左栏 padding 对齐。
- 标题去掉强制换行，按原型同一行显示。
- `.login-panel` 增加 `padding-bottom: 4vh`。
- 不改 `InfiniteMap` 和任何表单逻辑。

- [x] **Step 4: 验证新测试通过**

Run: `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web exec playwright test e2e/login-page.e2e.spec.ts --grep "原型"`
Expected: PASS。

- [x] **Step 5: 浏览器实际复核**

在 `1440×900` 打开 `/login`，保存并查看截图；确认左侧标志、脑图、标题、说明和标签互不重叠，右侧表单完整可见，浏览器无脚本错误。

- [x] **Step 6: 回归登录页全部用例**

Run: `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web exec playwright test e2e/login-page.e2e.spec.ts`
Expected: PASS；若有环境或既有工作区改动导致的失败，如实记录，不改无关代码。

- [x] **Step 7: 检查最终差异**

Run: `git diff -- apps/web/src/pages/LoginPage.tsx apps/web/src/styles.css apps/web/e2e/login-page.e2e.spec.ts`
Expected: 本任务只包含上述布局与测试改动；不提交、不推送。

### Task 2: 设计稿静态细节与脑图动效（2026-11-17 需求方追加）

**Files:**
- Modify: `apps/web/src/pages/LoginPage.tsx`、`apps/web/src/pages/InfiniteMap.tsx`、`apps/web/src/styles.css`
- Test: `apps/web/e2e/login-page.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 1 的三段布局与原型 `InfiniteMap` 分层数据。
- Produces: `.login-map-enter` 分层淡入、设计稿图标/光晕/比例/文案；表单接口不变。

- [x] **Step 1: 先写失败测试**

新增「登录页脑图按原型分层淡入」：断言连线与节点的动画名、700ms 时长、对应层级延迟，并验证系统减少动态效果时没有动画。新增设计稿结构断言：品牌与四个特点图标存在，左栏占 `11/21` 宽度。

- [x] **Step 2: 运行新测试并确认失败**

Run: `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web exec playwright test e2e/login-page.e2e.spec.ts --grep "分层淡入|设计稿"`
Expected: 动画名为 none，图标不存在，比例不符。

- [x] **Step 3: 按原型实现**

用本地 SVG 还原 Share2/Infinity/Users/Maximize/Network 图标；用两个伪元素还原光晕；将动画类替换为真实项目已定义的 `.login-map-enter`，保持原型延迟公式，添加减少动态效果支持。静态文案、字号与左右比例按 spec 最新一节。

- [x] **Step 4: 运行新测试并确认通过**

Run: 同 Step 2。Expected: PASS。

- [x] **Step 5: 实际复核与回归**

以 `1512×845` 检查动画开始、中间、结束截图及最终设计；再跑完整登录页 spec，并检查既有常见视口仍是一屏。按用户指令不提交、不推送。
