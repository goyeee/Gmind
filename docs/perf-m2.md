# M2 性能基线：50 机器人协同延迟（FR-COL-001 / NFR-PERF-005）

核验日期：2026-09-22。**非 CI 门**：压测为本地手工执行；结果为当日实跑输出（非转抄）。**发布验收需在 spec §6.1.1 基准机重跑**（见文末声明）。

## 工具与命令

- 脚本：`apps/server/tools/latency-bots.mjs`（M2 Task 9 交付；单进程 N 机器人）
- 复现（三步，本机 dev 服务器 `:3001` 已运行的前提下）：

```bash
# ① 登录拿 token（登录即注册；开发环境验证码固定 123456）
TOKEN=$(curl -s -X POST http://127.0.0.1:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"method":"phone","phone":"13900009101","code":"123456"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# ② 建文件拿 fileId（空文档：首连时服务端按裁定建仅含 root 的模板）
FID=$(curl -s -X POST http://127.0.0.1:3001/api/files \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"延迟压测-M2T9"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

# ③ 50 机器人 × 60s（经 tsx：@gmind/core 以 TS 源码为入口，裸 node 无法解析）
cd apps/server && ./node_modules/.bin/tsx tools/latency-bots.mjs \
  --url ws://127.0.0.1:3001/collab --token "$TOKEN" --file "$FID" --bots 50 --duration 60000
```

## 方法（口径）

1. 单 Node 进程持有 **50 个 @hocuspocus/provider 机器人**（Task 1 e2e 验证过的连接形态：
   `HocuspocusProvider + WebSocketPolyfill=ws`，标准 y-sync + auth 帧），全部连同一文档；
   bot 0 一次性经 `@gmind/core addChild` 播种 **30 个一级节点**（等全部 bot 收敛可见），
   bot i 编辑 `kids[i % 30]`（节点所有权互不重叠，即「user 写」的真实形态）。
2. 每 bot 以 **500ms ± 100ms 抖动**（bot 间 10ms 错峰）`setText` 短文本，文本即操作标记
   `b{bot}s{seq}`；每次写前记 `t0 = performance.now()`（单进程共享时钟，无跨机对时问题）。
3. **延迟相关为精确口径，非近似**：其余 49 个 bot 监听各自 Y.Doc 的 `afterTransaction`，
   `tr.local === false`（远端 applyUpdate）且 `changed` 含某节点 `'text'` 时，读新文本解析出
   `b{bot}s{seq}` → 记录该 op 在本副本的**最早到达时刻**。单 op 延迟 = 各接收端
   「最早到达 − t0」的**中位数**（抗单 bot 事件循环抖动）；汇总全部 op 输出 P50/P95/P99。
   标记经全量替换（`^b\d+s\d+$`）与种子文本（`节点-i`）无碰撞；normalize 修复不写
   text，无误报。任务简报设想的「接收端比对 RTT 表」即此形态（简报中的「min arrival ≥ t0
   近似匹配」方案已由此精确相关取代，无插值/错配）。
4. 判定：**P95 < 100ms** 且全部 bot sync 成功、写失败 = 0 → 退出码 0，否则 1（FR-COL-001
   「≥50 并发客户端」与 NFR-PERF-005「任一操作端到端 P95 <100ms」）。

## 结果（2026-09-22，两次独立运行，同一 token/文件）

> **2026-09-22 M2 终审修复轮补记——10 分钟长稳（`--duration 600000`，全新 token/文件）**：
> 50 bot / 59,885 ops（~99.8 ops/s）/ 写失败 0 / 鉴权失败 0 / 未被远端观测 210（0.35%）；
> **P50=2.5ms P95=7.2ms P99=10.4ms MAX=59.7ms，结论 PASS（退出码 0）**；结束后 docState
> 复核 `countAliveReachable`=30、重复文本 0（结构完整、计数无膨胀）。此轮把
> m2-acceptance FR-COL-001「连续 10 分钟」子项从待手动核验收口为机器执行。

环境：Apple M4 Pro / 24GB / macOS 15.5 / Node 22.22.3 / @hocuspocus 4.7.0（server+provider）/ 本机 dev 服务器（NestJS tsx `:3001`，持久化防抖默认 2000/10000ms）。机器人与服务器同机（环回，无网络延迟）。

| 指标 | Run 1 | Run 2 | 阈值 | 结论 |
| --- | --- | --- | --- | --- |
| 并发客户端 | 50 | 50 | ≥ 50（FR-COL-001） | **通过** |
| ops 总数（~ops/s） | 5987（99.8/s） | 6001（100.0/s） | — | — |
| 写失败 / 鉴权失败 | 0 / 0 | 0 / 0 | 0 | 通过 |
| 传播延迟 P50 | **1.3 ms** | **1.6 ms** | — | — |
| 传播延迟 P95 | **3.7 ms** | **2.3 ms** | < 100 ms（NFR-PERF-005） | **通过**（余量 ≥ 27×） |
| 传播延迟 P99 | 18.9 ms | 2.6 ms | — | — |
| MAX | 225.3 ms | 10.1 ms | — | 见口径边界 |

原始输出（Run 1）：`P50=1.3ms P95=3.7ms P99=18.9ms MAX=225.3ms（目标 P95 < 100ms）结论：PASS`；
（Run 2）：`P50=1.6ms P95=2.3ms P99=2.6ms MAX=10.1ms 结论：PASS`。

## 口径边界（如实记录）

- **单进程模拟**：50 个 bot 同处一个 Node 进程（spec 验证方式「模拟 50 客户端」），测量含
  客户端事件循环排队；对所有 bot 一视同仁，不失偏，但真实分布式客户端的调度噪声更大。
- **MAX 尾部**：Run 1 MAX=225ms 来自个别 op 的单接收端 GC/事件循环停顿（P99 仍在 19ms
  内）；该尾部经「接收端中位数」聚合已抑制，不触发 P95 超标。
- **未被观测 op**：Run 1 有 28/5987（0.47%）、Run 2 有 9/6001（0.15%）的 op 未被任何
  其他 bot 观测到（集中在压测收尾窗口的在途更新），不计入分位数；量级不影响结论。
- **同 token**：50 连接复用同一用户会话（owner），服务端按连接逐次过 onAuthenticate
  （Redis 校验）——即压测同时覆盖了 50 并发下的鉴权路径；协作编辑冲突（多端同节点
  并写）由 yjs CRDT 收敛，节点所有权互斥是为延迟口径干净而设。
- 本基线为本机开发机实测，无网络延迟与受控负载；达标余量大（≥ 27×），但**发布验收
  仍须在 spec §6.1.1 基准机重跑**（同机/跨机各一轮，跨机时 P95 预期由网络 RTT 主导）。
- 配额告警（onChange `countAliveReachable`）为每事务一次的轻量计数（30 节点亚毫秒），
  本次压测未观察到其成为瓶颈（P95 个位数毫秒）；如基准机重跑超标，优先排查方向为
  onStoreDocument 防抖窗口内的全量序列化（`docToState`）与 MySQL 回写竞争。
