# 分享与协作（四页签弹窗）

## ① 这是什么

编辑器右上角“分享”和“成员”打开同一个弹窗，包含协作成员、邀请协作、链接分享、导出四页（`apps/web/src/pages/EditorPage.tsx:5173-5204`）。创建者点分享默认邀请，其他协作者默认导出；成员按钮直达协作成员（`apps/web/src/editor/ShareDialog.tsx:52-66`）。

## ② 规则

1. **角色**：创建者拥有全部管理能力；可编辑=编辑+评论；可评论=查看+评论+导出；仅查看=查看+导出。创建者可在成员页改其他成员角色或移除（`apps/server/src/files/files.service.ts:503-522`）。
2. **成员**：创建者首位，显示头像、归属、真实角色和在线/编辑状态；无其他成员时显示空态，底部为“共 N 人 · M 人在线”（`apps/web/src/editor/MemberPanel.tsx:266-315`）。
3. **邀请**：搜索真实站内用户，或从“可邀请成员”前 5 人添加；逐项默认“可编辑”，可改可评论/仅查看。确定后直接成为协作者、回成员页并刷新（`apps/web/src/editor/MemberPanel.tsx:68-197`）。
4. **通知**：真实新增的站内成员收到指向文件的权限通知；已注册联系人的 pending 邀请也收到通知。重复添加不重复通知（`apps/server/src/files/files.service.ts:610-642`；`apps/server/src/share/invite.service.ts:90-111`）。用户关闭站内通知总开关时维持既有偏好，不新生成通知。
5. **新链接默认值**：仅查看、永久有效、无密码；已有活跃链接不因升级改变设置（`apps/server/src/share/share.service.ts:75-107`）。
6. **链接角色**：可编辑/可评论/仅查看决定通过该链接新加入者的角色；已有协作者角色由成员页单独管理（`apps/server/src/share/share.service.ts:175-209`）。
7. **仍需登录**：未登录打开链接先登录并回跳；开启密码时再输入 4 位密码。密码由系统生成，关闭再开启会换码（`apps/web/src/pages/ShareLandingPage.tsx:22-104`）。
8. **有效期**：永久/7 天/30 天；有期限的设置在开启或修改时重新计时（`apps/server/src/share/share.service.ts:120-139`）。
9. **导出**：顺序 XMind、图片、Markdown、Excel、CSV；CSV/Excel 保持现有 7 列，图片按当前折叠态（`apps/web/src/editor/ShareDialog.tsx:175-184`）。

## ③ 特殊情况

- **链接关闭**：已发出的链接立即失效；重新开启会生成新链接。
- **链接过期**：旧地址永久失效，不能延长恢复；创建者重新开启会生成新链接并沿用当前设置，有期限的重新计时（`apps/server/src/share/share.service.ts:42-48`、`:75-107`）。
- **密码错误**：提示重新输入；同一用户同一链接连续错 5 次后 60 秒内不可继续尝试（`apps/server/src/share/share.service.ts:151-173`）。
- **名单/目录/链接状态加载失败**：显示失败与重试，不伪装成空名单或已关闭。
- **在线改角色/移除**：目标连接立即按新权限限制写入；移除会断开目标协同连接，页面收到权限更新后刷新本人角色（`apps/server/src/collab/collab.service.ts:204-217`；`apps/web/src/editor/useEditorDoc.ts:139-155`）。

## ④ 待需求方确认

本轮规则均来自 2026-11-18 需求方确认的计划。无新增未确认产品拍板。

## ⑤ 最后核对

- 核对日期：2026-11-18。
- 代码版本：commit `08f5750682d32e5c0a10f269a2442856dc705ada` 加当日分享弹窗工作区改动。
