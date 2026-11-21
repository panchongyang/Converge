# 材料审计 B：过期与冲突清单（项目 P · 项目 A）

> 审计对象：`research/cognition-events-2026-11-15.md`（只读，未修改）。
> 审计方式：文档 ↔ 现行契约 ↔ 代码 ↔ git 提交逐项对账。只读命令仅用 `git log/show/status/grep` 与文件读取。
> 审计时间：2026-11-15（北京时间）。
> 本文件是唯一写入文件。
> 公开版说明：原文引文已改为要点转述；内部绝对路径、提交哈希、任务标识与归档位置不公开。冲突判定、计数与结论不变。完整原件保留在原仓。

## 0. 只读声明、仓库状态与方法

### 0.1 开工前 `git status --short`（两次，结果均为空）

| 仓库 | 时间点 | 命令 | 输出 |
|---|---|---|---|
| 项目 P | 开工前 | `git status --short` | （无输出） |
| 项目 A | 开工前 | `git status --short` | （无输出） |

### 0.2 收工前 `git status --short`（两次，结果均为空）

| 仓库 | 时间点 | 命令 | 输出 |
|---|---|---|---|
| 项目 P | 收工前 | `git status --short` | （无输出，exit 0） |
| 项目 A | 收工前 | `git status --short` | （无输出，exit 0） |

两次快照一致：来源仓库工作树无改动。本次审计未写入任何来源仓库，未创建临时文件（本机临时目录未使用）；未读取 `experiments/` 下除本文件外的内容。

### 0.3 路径别名

- `P\` = 项目 P 源仓库
- `A\` = 项目 A 源仓库
- `报告` = `research/cognition-events-2026-11-15.md`

行号以当前工作树为准。

### 0.4 方法与覆盖

1. 用 `grep` 列出两仓库 `docs/` 下所有带状态标记的文档（`状态/Status/Proposed/Draft/Accepted/closed/暂停/废弃/已实现/待实现/未实现/superseded`），得到候选 30 余处。
2. 每条候选逐一对照：现行契约（项目 P 的 `docs/CONTRACT.md`、`docs/DESIGN.md`）、实现代码（项目 P 的 `lib/**`、项目 A 的 `prototype/**`），以及后续提交（`git log`、`git log -S` pickaxe）。
3. 只保留"两侧都有明确原文/代码"的冲突；口径模糊或范围不明的条目移入 §3「待人工确认」。
4. 文档层级判断依据项目 P `docs/INDEX.md`：`decisions/` 是决策背景、不替代现行契约，`CONTRACT`/`DESIGN` 是长期维护的现行文档；"现行文档只写现在的事实"。

---

## 1. 核实报告 §6 第 1、2、8 条

### 1.1 §6 第 1 条：RFC-3「是否已通过」

**报告结论**（E 报告 §6 第 1 条）：代码已实现，`docs/decisions/rfc-3-state-closure.md` 仍标 **Proposed（人审前）**，文档状态与实现状态不一致。

**冲突双方与位置**

- 一方（文档自称未通过）：项目 P `docs/decisions/rfc-3-state-closure.md:3` 的状态行仍写 Proposed（人审前）；同文结论摘要把整份 RFC 写成待批准方案（open intent 是 WAL、新增 `task.interrupt` 等）。
- 另一方（现行契约把它当既定规则）：
  - `docs/CONTRACT.md:304` 设「2.4.2 Intent 结算（RFC-3）」，:320-324 写死运行时语义：`outcome` 只接受 `stopped|unknown`；`unknown` 一律拒绝（`intent-unresolved`），应改用 `task.interrupt`；`task.interrupt` 不关闭 intent，任务转 `interrupted`。
  - `docs/CONTRACT.md:326` 设「2.4.3 Archived 写闸（RFC-3）」，:328-333 写死归档写闸。
  - `docs/DESIGN.md:270`（不变量 I6）、:286（不变量 I22）与 RFC-3 :278、:286 同源，均作为当前不变量列出。

**代码/提交证据**

- 有一笔实现提交（2026-10-28 12:07:07 +0800），标题写明 RFC-3 intent 结算 + task.interrupt + fencing 补齐，review pending。
- 实现文件存在且为现行代码：`lib/core/intent.js`、`lib/core/commands/task-work.js`（`intent-unresolved`/`interrupt` 语义）、`lib/core/commands/task-gov.js`；测试 `test/core/intent-settlement.test.mjs`。
- 该 RFC 文档自创建后只被搬移过一次（2026-11-04 的文档搬迁提交），状态行从未随实现更新（`git log --follow` 仅此一条）。
- 实现后的内部验证记录（本机归档，非仓库内文件）有三条要点：RFC-3 治理结算只有 stopped + sideEffects 可关闭；settlement 参数行规模；无 RFC-3 身份字段的旧结算是历史。

**现行事实**

行为以 `CONTRACT.md` §2.4.2/§2.4.3 与 `DESIGN.md` I6/I22 为准，代码已实现；`rfc-3-state-closure.md` 的 `Proposed（人审前）` 是过期状态行。**报告结论成立**，只需把"文档状态滞后"写成"文档状态未更新"，而不是"未通过"。

**"是否已通过人审"：不确定。** 缺什么：对应看板任务的验收记录（任务板 store 不在仓库内，本机归档只有证据），以及任何把该 RFC 标为 accepted 的提交或文档。实现提交标题自带的 `review pending` 表明提交当时**尚未**验收；其后没有更新该文档状态的提交。

**置信度：高**（"文档状态与实现冲突"有原文与代码/提交三重证据）；**"人审已通过"本身未核实**。

---

### 1.2 §6 第 2 条：RFC-4 与测试清单的口径冲突

**报告结论**：`docs/decisions/rfc-4-evidence-strength.md` 仍标 Proposed 且描述"命令由宿主执行"，而 `docs/design/test-implicit-contracts.md` 明确 command/test 仅作材料、不执行；资料未记载这次转变的过程。不能把旧实现的"宿主执行"当现行事实。

**冲突双方与位置**

- 一方（RFC-4，主张宿主执行）：
  - `docs/decisions/rfc-4-evidence-strength.md:1` 标题为「RFC-4 证据强度与宿主执行」；:3 状态为 Proposed（人审前）。
  - :10 承认 command/test 完全 self-reported，没有 exitCode、没有 stdout、宿主不执行。
  - :12 提出把证据分成强/弱，并让宿主在 submit/reconcile 前执行 command/test，留下可复核的执行记录。
  - :20 的 strong 判据含 `execution.executor=host`；:26-28 要求 `project_task` 的 `submit`/`reconcile` 分支在发命令前，对每条 `kind ∈ {command, test}` 执行 `ref`。
- 另一方（测试清单，主张只登记）：
  - `docs/design/test-implicit-contracts.md:113`（evidence-runner 行）明确 command/test/note/url 是材料、execution 清空、不会跑 ref；requiredKinds 不匹配原子拒绝。
- 第三方（现行契约，与测试清单一致）：
  - `docs/CONTRACT.md:19` 说明证据中 file hash 与 doc 内容由服务端观测；command/test/note/url 只登记提交者材料，不执行、不探测、不判定成败。
  - `CONTRACT.md:387` 把 `execution?: object|null` 标为历史字段：只回放旧日志；新提交恒为 null，不执行、不签名。
  - `CONTRACT.md:394` 重申 command/test 只登记 `ref`，服务端不执行、不重跑、不签名、不校验退出码；execution 只用于回放旧日志，不参与新提交、审计或完成判定。
  - `CONTRACT.md:618` 说明 `rootDir/execution.key` 是旧版 command/test proof 密钥；新实现不读取、不创建；旧密钥即使留在磁盘上也不参与任何判定。

**代码/提交证据**

- `lib/core/evidence.js:114` 新证据行固定 `execution: null,`；:236-237 注释说明 command/test 元数据只是历史提交者材料，从不是执行或正确性门禁。
- 转变提交（2026-11-05）标题为记录证据但不执行、不设信任门；pickaxe `git log -S"executor: 'host'"` 与 `-S'PB_COMMAND_EVIDENCE'` 均显示该提交批次为删改点（更早的 2026-10-28 command 证据宿主执行提交是被撤回的一方）。
- `grep execution.key|executionKey` 在 `lib/**` 下 0 命中；`test/docs/evidence-runner.test.mjs` 存在并覆盖"不会跑 ref"。
- RFC-4 文档同样只有一次搬移历史提交，状态行未更新。

**现行事实**

现行事实是**不执行**（`CONTRACT.md` + `lib/core/evidence.js` + `evidence-runner.test.mjs` 三方一致）；RFC-4 描述的宿主执行已被撤回，文档仍保留 Proposed 与旧设计。**报告结论成立**。补充：同一主张在第三处仍有残留——`docs/decisions/rfc-1-history-read-model.md:91` 仍把 command 证据由宿主执行列为独立议题，也未被标注为废弃。

**"资料未记载这次转变的过程"：部分未核实。** 可核实的是"文档里没有记载"（RFC-4 与 rfc-4-addendum 均无撤销说明，git log 无对应文档提交）；"会话里是否讨论/拍板过"未核实（本报告未读 DSH/Codex 会话存档，见 §4）。

**置信度：高**。

---

### 1.3 §6 第 8 条：历史读模型（RFC-1 closed ≠ 已实现）

**报告结论**：RFC-1 已 closed，但传统历史读计划随后暂停（`history-audit-rollback-layering.md` 第 3 行），能力被"历史知识检索"取代；不能把 RFC-1 的关闭写成"已实现"。

**冲突双方与位置**

- 一方（"closed"）：
  - `docs/decisions/rfc-1-history-read-model.md:5` 状态为 **closed**（R1 / R2 均采纳）。
  - :82 决议采用 R1、R2，无保留，并在 CONTRACT 增加三条（含 `history.index.attribution = event-only`）；:85 宣布本 RFC 关闭，后续异议另开 RFC-2。
- 另一方（"暂停/未交付"）：
  - 同一文件 :3 的执行状态写明：传统历史读计划暂停开发，旧能力清单与规模阈值不自动成为新阶段交付要求。
  - `docs/decisions/history-audit-rollback-layering.md:3`（报告所指第 3 行）写明：传统历史读计划暂停开发；项目所有者确定历史知识读取与检索为当前最高优先方向，可以取代传统历史读，未覆盖的旧能力仍暂停。
  - `docs/decisions/structured-continuous-knowledge-base.md:71` 写明传统历史读计划暂停开发，本方向可以取代它，未覆盖的传统能力继续暂停，不作为前置条件或并行工作。
  - `docs/design/history-knowledge-read-model.md:40` 说明旧历史方案的通用 asOf、HTTP /history、固定分段阈值不作为本阶段验收条件。
  - `CONTRACT.md:1098` 同义照录：传统历史读计划暂停，通用 asOf、/history 与旧分段阈值不作为此版交付条件。

**代码/提交证据（"未实现"）**

- 全仓 `grep asof-out-of-range` 仅 3 处，全部在文档（`CONTRACT.md`、`history-audit-rollback-layering.md`、`rfc-1-history-read-model.md`），`lib/**`、`src/**` 0 命中 → 该错误码无实现。
- `grep "/history\?|historyIndex|entityKey"` 在 `lib/**` 只命中知识检索的 SQL（`lib/core/knowledge/sqlite-index.js:31-37` 的 `entityKey` 分组），没有任何 `/history` 路由或实体索引读模型。
- `git log --grep`（`history read model`/`history-read`/`历史读`/`asOf`）无实现类提交；唯一 `asOf` 命中是文档外置计划。
- 反向证据（"R2 边界被现行契约采纳、但不等于功能实现"）：`CONTRACT.md:1109` 要求索引只认事件自带归属（`event.taskId` / `event.data.id`），禁止用 `doc.links` 回填归属（RFC-1 R2）——这是**约束**，不是读模型的交付。

**现行事实**

`closed` 指**决议关闭**（R1/R2 采纳），不是能力交付；读模型（通用 `asOf`、`/history`、实体索引）确实未实现且已暂停，被"历史知识读取与检索"取代。**报告结论成立**。唯一需要提醒的是措辞：同一文件 :3（执行状态：暂停）与 :5（状态：closed）并列，容易被读成自相矛盾——两者是不同层级的状态（执行/交付 vs 决议），报告写"RFC-1 已 closed"时应同时说明这一点，否则读者会误以为能力已交付。

**置信度：高**（决议、暂停、无实现的证据齐全）；**"未来是否会实现"未核实且不在本次范围**。

---

## 2. 主动搜索到的同类问题（7 条）

### C1 人审门文档仍称 `requiresHumanReview` "已实现"为唯一开关，运行时已换成 `requiresAudit`

- **冲突 A**：`docs/decisions/human-review-gate.md:1` 的标题仍是"人审门用 requiresHumanReview 开关，agent 只能开不能关"；:4 状态写"已实现（0.1.1）"；:10 把 `requiresHumanReview: boolean` 写成唯一开关、`gate:human` 标签兼容旧数据；:11 说 `project_task` op=gate 切换该开关；:13 说已开启人审的任务只有 human/verifier 能 verify/reject。
- **冲突 B**（现行契约）：`CONTRACT.md:421` 的任务 Card 字段为 `requiresAudit`（无 `requiresHumanReview`）；:517 规定审计门（`requiresAudit` / `gate:audit`）仍要求独立 agent；同文件 `grep requiresHumanReview|gate:human` **0 命中**。
- **代码证据**：`lib/core/audit.js:9` 只判断 `task.requiresAudit` 或 `gate:audit` 标签；`lib/core/command-shape.js:5,7,24` 只接受 `requiresAudit`。`grep requiresHumanReview` 全仓 45 处，`lib/**` 0 处，仅剩迁移与发布门禁：`scripts/migrate-gate-v3.mjs:82,88,89`（把旧字段转成 `requiresAudit` 后删除）、`scripts/check-release-purity.mjs:12`（把旧名当禁词）。替换提交为 2026-11-05 的独立审计门与 schema v3 候选。
- **现行事实**：`requiresAudit`/`gate:audit`。`human-review-gate.md` 是已被替换的旧决策，但头部仍写"已实现"，且没有 superseded 标记（对比项目 A 的 ADR 惯例见 C7）。
- **置信度：高**。

### C2 审查治理 v6 设计稿仍写"待实现"，实现自 2026-11-05 起就在 master

- **冲突 A**：`docs/design/review-governance-v6.md:1` 标题仍是"设计草案：AI 驳回与第三方审计门（审查治理 v6）"；:4 状态写"v6 方案**待实现**（用户拍板 B：无迁移 marker）"。
- **冲突 B**：同文 :8-11 记录的三条用户拍板内容已全部落地：旧门直接降级为第三方审计门；发布里彻底去掉旧门字段与字样、运行时只认 v3；不新增 `schema/upgraded` 事件（B）。
- **证据**：2026-11-05 的独立审计门提交、同日的审计范围绑定/废弃门意图修复、2026-11-11 的发布列车合入；迁移脚本 `scripts/migrate-gate-v3.mjs` 存在；发布零旧名门禁 `scripts/check-release-purity.mjs` 存在；`docs/MIGRATION.md:48` 说明独立 v2 读取器重放旧日志，将旧字段转为 `requiresAudit` / `gate:audit`，旧字段只存在于迁移工具、测试与历史数据。
- **现行事实**：v6 已实现（契约 `CONTRACT.md:517` + 代码 + 迁移/纯净门禁）。设计稿状态行是过期值。
- **置信度：高**。

### C3 RFC-4 增补自称 "Implemented（持久 execution 凭证）"，当前实现已不执行命令、不读 execution 密钥

- **冲突 A**：`docs/decisions/rfc-4-addendum-preflight.md:1` 标题仍是"RFC-4 增补：执行前校验、持久 execution 凭证与证据 supersede"；:3 状态为 **Implemented**（复核返工第 2 轮）；:10 说首轮 `project_task` 在 `handle.command()` 校验任务/rev/lease 之前就执行了 command 证据；:16 说成功 preflight 后才执行 command/test，随后 `handle.command` 再走真实提交。
- **冲突 B**：`CONTRACT.md:394`（不执行 `ref`）、:618（`execution.key` 新实现不读取、不创建）、:19（只登记提交者材料）。
- **代码证据**：`lib/core/evidence.js:114` 为 `execution: null`；`grep execution.key|executionKey` 在 `lib/**` **0 命中**；`lib/core/handle.js:273` 的 `_preflight` 仍在，但只做命令校验，不再触发 command 执行（执行路径已被 2026-11-05 的提交移除）。同一批文档的撤回点即该提交。
- **现行事实**：preflight 结构校验保留，`execution` 凭证与新提交执行**已不存在**；增补文档的 `Implemented` 只对 2026-10-28 那个实现成立，未标 superseded。
- **置信度：高**（"状态过期"这一判断）；**"是否被显式撤销"未找到文档，只有提交证据**。

### C4 计划能力 v2 决策仍写"待人类确认"，PLAN-V2 与契约写"全部完成/已实现"

- **冲突 A**：`docs/decisions/plan-capability-v2.md:1` 标题为"决策：计划能力 v2…"；:4 状态写"**待人类确认**（见任务 D1）"。
- **冲突 B**：`docs/PLAN-V2.md:3` 状态写"**设计定稿（D1）**，C1 / C2 / H1 / U1 / U2 / T1 **全部完成**（2026-10-26 收口）"；`CONTRACT.md:335` 设「2.4.1 Plan v2 命令（C1–C2 已实现）」、:337 说明按 PLAN-V2.md 冻结的设计实现，全部走 `handle.command`。
- **代码证据**：`lib/core/commands/plan.js` 存在；`CONTRACT.md:339-349` 列出 `plan.create/revise/publish/rename/archive/unarchive/focus/adopt/release` 现行命令与语义。
- **现行事实**：计划 v2 已实现并进入契约；`plan-capability-v2.md` 的"待人类确认"是过期状态。
- **置信度：高**。

### C5 RFC-5 证据漂移仍写"Proposed，不是已落地契约"，刷新与固定证据已在契约/代码中

- **冲突 A**：`docs/decisions/rfc-5-evidence-drift.md:3` 状态写"**Proposed，等待用户验收；不是已落地契约。**"；:5 写"完整验收前不合入 master、不部署"；:39 建议新增 `task.refreshEvidence`：仅 review + human，必须 `expectedRev`、`reason`。
- **冲突 B**：`CONTRACT.md:522` 规定获授权的验收者只能验收 review 且所有 acceptance met 的任务；verify 前重新审计内容观测，漂移返回 `evidence-drift`；:523 规定人工刷新（file 内容漂移）：hard 错误里有 `file-drift` 时，human 传 `refreshDrift:true` + `reason`，服务端重读文件、重算 hash、追加新证据并退休旧行。
- **代码证据**：`lib/core/commands/task-work.js:193`（非 human 传 `refreshDrift/acknowledgeDrift` → `forbidden-role`）、:201-203（仅 `file-drift`、reason ≥4 字）、:218（`canAcknowledgeDrift`）；`lib/host/tools/task.js:83`（工具参数）；`lib/client.js:8066`（UI 走 refresh）。
- **现行事实**：漂移分级与人工刷新已落地（形态与 RFC-5 提案不同：现行是 `verify` 上带 `refreshDrift`，不是新命令 `task.refreshEvidence`），所以文档"不是已落地契约"与契约/代码矛盾。
- **置信度：高**（对"刷新机制已落地"）；**"全量 A–E 是否都落地"未核实**，文档 :5 的完整验收范围没有对应证据。

### C6 外置文档实施计划仍写"待实施"，同日之后已有实现与现行契约

- **冲突 A**：`docs/WORKSPACE-DOCUMENTS-PLAN.md:3` 状态写"**待实施计划**。创建计划和登记依赖不代表实现、验收、真实数据迁移、合入、部署或公开发布获准。"（该文件创建后再无更新：`git log` 只有 2026-11-01 一条）
- **冲突 B**：`docs/EXTERNAL-DOCS.md:3` 写"本文写的是外置文档**现在怎么工作**。语义以 D1 冻结契约为准"；`CONTRACT.md:296-298` 列出现行命令 `doc.external.rebind/confirm/unregister`；`docs/INDEX.md:32-34` 把 D1 契约、外置文档实现、固定内容证据列为现行文档。
- **代码证据**：`lib/core/commands/doc-external.js:201,205`（`doc.external.register`/`confirm` 分派）；`lib/shared/contract.js:70,74`；2026-11-02 的外置文档登记核心层与说明提交。
- **现行事实**：外置文档登记/定位/观测/基线已实现（E01 的"已实现"成立）；"待实施计划"过期。注意该计划还包含"真实数据迁移"等范围，那部分是否完成**未核实**。
- **置信度：高**（"实现已落地、计划状态过期"）；计划整体的其余范围未逐项核对。

### C7 项目 A：Q38 状态仍写"尚待整改/代码尚未解耦"，status.md 与 ADR 0067 写"2026-11-14 已完成代码整改"

- **冲突 A**：`docs/open-questions.md:220` 写"内容管理已有本机实现；跨节点任务协议经用户纠正，尚待整改（2026-11-13）"；:222 写"本轮先收口通用契约，单节点随后评审；**代码尚未解耦**，旧验证不是新边界已通过的证据。"
- **冲突 B**：`docs/status.md:3` 写"2026-11-14 通用图与节点契约整改已完成…"；:5 写"**通用图边界已落实到代码。**…任务协议收回任务节点，其他节点只把 `task` 当普通载荷"；`docs/decisions/0067-generic-graph-and-node-contract-boundaries.md:3` 状态为 accepted（2026-11-14 代码整改已完成）、:33 写"2026-11-14 已完成代码整改：任务协议收回任务节点，其他节点不再核验凭据、并关联键或做任务专用接续保护"；`docs/node-protocol.md:5` 写"**2026-11-14 已完成代码整改**"。
- **代码证据**：`grep taskProtocol` 全仓仅 7 处——`AGENTS.md:36`、`docs/node-protocol.md:35`、`docs/decisions/0067…md:18`（均为规则说明）与两个测试文件（`prototype/tests/integration/task-protocol.test.ts:307,436,608`、`node-contract.test.ts:115`）；`prototype/backend|frontend|shared/**` 源码 **0 命中** → 与"代码已解耦"一致，与"代码尚未解耦"矛盾。
- **现行事实**：已完成整改（status.md + 0067 + 代码一致）；`open-questions.md` 的 Q38 段是 11-13 的旧状态，未随 11-14 整改更新。
- **置信度：高**。

---

## 3. 待人工确认（判断不了，缺具体材料）

1. **`docs/design/project-access-lifecycle-boundaries.md:3`** 状态写"用户已批准本方案定稿建卡……实现、回归、独立验收与运行生效仍待执行。本文件不是当前实现已具备这些能力的声明。"
   与之相对：`CONTRACT.md:301` 已把 `project.relocate` 写成现行命令；`lib/core/commands/project.js:74,150`、`lib/core/identity/ops.js:99,150` 有实现；`docs/INDEX.md:36` 把"项目身份（改绑定、搬迁、打开项目）"列为现行文档。
   **不确定点**：该设计覆盖的生命周期能力不止 `relocate`（还含 attach/detach、archived 等），"实现待执行"是否对**整体**仍成立，需逐项核对实现；缺：设计文档的能力清单与代码的逐条映射。
2. **`CONTRACT.md:1098` 与 `:1110` 同节口径**：:1098 写传统历史读计划暂停，通用 asOf、/history 与旧分段阈值**不作为此版交付条件**；:1110 写语义：实体不存在或该时刻不存在 → 200 空结果；`asOf` 非法/越界 → `4xx asof-out-of-range`；`fromSeq` 非法 → `4xx bad-seq`。
   **不确定点**：:1110 是"保留的旧契约"还是"现行要求"未标注；代码中 `asof-out-of-range`/`bad-seq` 均无实现（全仓仅文档命中）。缺：:1110 的适用范围声明（若保留，应像 :1098 一样标明暂停）。
3. **RFC-3 的"人审"结论**：见 §1.1。缺：对应任务的验收记录/看板 verify 证据（store 不在仓库内）。
4. **RFC-4 撤回（宿主执行 → 只登记）的决策过程**：2026-11-05 的提交标题写的是记录证据但不执行、不设信任门，但没有 RFC/决策文档记录这次方向改变；RFC-4 与其增补均未更新。缺：该批次的会话记录或新决策文档。
5. **RFC-5 完整验收范围**：`docs/decisions/rfc-5-evidence-drift.md:5` 声明"完整验收前不合入 master、不部署"，而 `refreshDrift` 已在 master 与契约中。缺：A–E 各项的验收状态清单，无法判断是"全部落地"还是"部分落地"。

---

## 4. 未核实与缺口（明确声明）

- **未读会话存档**：本次只做"文档 ↔ 契约 ↔ 代码 ↔ 提交"对账，未解压 DSH 与 Codex 会话存档，因此"某次转变发生在哪次对话、人类是否拍板、有没有形成共识"一律**未核实**。§1.2 的"资料未记载过程"只指**文档/git**层面。
- **看板 store 不在仓库内**：任务验收（如 RFC-3 的任务是否 verified）无法从仓库读出；本机归档只有证据（另一个 git 仓库），不能作为任务状态证据。
- **发布包纯净度未实测**：C1/C2 涉及"npm pack 零旧名"，只核对了 `scripts/check-release-purity.mjs:12` 与 `MIGRATION.md:48` 的存在，未运行打包。
- **项目 A `prototype` 的行为级验证未做**：C7 以静态 grep 证明 `taskProtocol` 已不在源码，未运行其测试；"整改后行为是否符合 0067"以 `evidence/node-boundary-remediation-2026-11-14.md`（文档声明）为间接证据，本报告未逐条核对该记录的覆盖范围。

---

## 5. 与报告 §6 的关系（结论速览）

| 报告条目 | 本次核实 | 需修正的措辞 |
|---|---|---|
| §6-1 RFC-3 | 成立：文档 `Proposed（人审前）` 与现行契约/设计/代码冲突 | 把"是否已通过"改为"是否有验收记录：未核实"；不要写成"未通过" |
| §6-2 RFC-4 | 成立：RFC-4 宿主执行 vs `test-implicit-contracts.md:113`/`CONTRACT.md:19,394` 只登记 | 补"第三处残留：`rfc-1-history-read-model.md:91`"；"转变过程"限定为"文档未记载" |
| §6-8 RFC-1 | 成立：`closed`=决议关闭，读模型未实现且暂停 | 明确"closed ≠ 已实现"；避免把 :3 与 :5 读成矛盾 |
| 新增 C1–C7 | 7 条同类问题（5 条项目 P、1 条项目 P 计划、1 条项目 A） | 均给出冲突双方位置、代码/提交证据与现行事实 |

---

*本文件只做只读审计，未修改 `cognition-events-2026-11-15.md`，未修改任何来源仓库。*
