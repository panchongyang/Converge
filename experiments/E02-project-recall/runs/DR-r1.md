# DR-r1

## Q1

不建议。项目板的定位是登记外置文档、不持有正文：文档留在项目工作区、随项目上 git，看板只保存登记、定位、基线、状态与漂移观测（项目 P 仓库 docs/EXTERNAL-DOCS.md，冻结语义见同目录 WORKSPACE-DOCUMENTS-CONTRACT.md）。同步一份正文会重新造出两份真相：工作区改了看板不同步、检索命中旧副本，还要长期承担存储与一致性成本。离线检索可用"登记 + 基线/漂移标记"满足；确需快照就做成带 hash、来源、时间的显式证据，而不是长期维护的镜像。

## Q2

建议不做两档兼容，直接改名加一次性显式迁移。前提要先确认：项目未发布、只有本机 store、没有外部 v2 数据；这正是 2026-11-02 拍板"旧门直接降级、做显示迁移"的依据（项目 P 仓库 docs/decisions/product-policy-review-v6.md）。迁移要把旧数据显式转成新字段，不做静默降级；回滚边界写进设计——回滚到旧代码后按旧语义处理，不承诺双向兼容（docs/MIGRATION.md）。若已有发布版、外部 store 或第三方数据，前提不成立，需复议并考虑双读窗口与备份回滚。

## Q3

不应该。项目板只对证据做诚实记录、能识别漂移，不对证据正确性负责，跑命令不属于它的职责（项目 P 仓库 docs/DESIGN.md P4.2；项目 A 边界文档 §1–§3）。契约里 command/test 只登记 ref、summary、acceptanceId，服务端不执行、不重跑、不校验退出码。板子自己执行会把"记录"变成"背书"，并引入执行环境、权限、超时等第二套责任；通过也不等于结论正确。核验应由 worker/auditor 自己跑并提交材料，或交给 CI。

## Q4

拒绝，不能在同一 commit 标 abandoned。open intent 是 WAL，表示副作用可能已经发生；结果不明时 task.block 必须返回 intent-unresolved，改走 task.interrupt（→ interrupted，保留 open intent），再由 task.reconcile 显式结算 redo/applied/discarded（项目 P 仓库 docs/CONTRACT.md §2.4.2；RFC-3 §0/§2.1）。abandoned 只表示"这次尝试停止"，不代表没副作用或已回滚；为让不变量成立而标它，等于把不确定性藏起来。RFC-3 文档虽仍标 Proposed，该行为已在契约与实现中生效。

## Q5

应列为高优先级。方针三明确：变更安全性与长期可维护性是一等工程质量属性，架构缺陷可以独立构成高优先级，不以已发生生产事故为前提；排序按实际维护成本、隐含契约数量、误用概率、影响范围、未来变更频率（项目 P 仓库 docs/PRODUCT-PRINCIPLES.md）。两轮返工已证明变更摩擦与累计成本，不需要事故证据才够格；证据确定度只决定结论能写多满，不替代优先级判断。但也不要写成"已证明整体失控"或"所有返工同源"。

## Q6

不算退化，前提是记录得对。"记录真相"是这个项目的第一目的：解决持续推进中 AI 改来改去、后来谁都看不懂现状的问题。评估应看三件事——现状可解释、改动可追问、历史可重建，也就是"三个月后能不能看懂、能不能反驳"。计划与任务变多本身不是毛病，真正的失败是记录噪声化、脱离代码、无法重建。如果"决定下一步"变弱，那是视图与摘要的问题，应改视图、检索与归档，而不是削减记录。

## Q7

不建议。可放宽的是判定（自主权、验收严格度、流程体验可分级），不可削减的是事实层：如实记录、不伪装已验证、历史可追溯。跳过证据登记和事件日志，等于让"完成"不可复核，事后无法回答谁在何时依据什么做了什么，而这正是项目要解决的问题。轻量档可以少交互、少门禁、允许 AI 更大自主权，但状态变化仍要落事件、完成仍要带证据引用（note 也算）。另外当时人类明确说过"先不加档位"，原则接受不等于实现授权。

## Q8

缺口成立，但责任归属不成立，不建议列 P0。ProjectBoard 是建立在 DSH 上的应用，不是日志系统；它记录任务事实与证据，不宣称独立、完整地观测所有执行通道。要它在恢复时对账全部外部副作用，需要宿主/执行层提供通道信息，板子拿不到也不该假装拿到。合理边界是提供 task.interrupt + task.reconcile（允许 outcome=unknown），把"未知"显式留在记录里；跨通道对账作为系统协作层的责任空白另行立项。

## Q9

不可以。面向 Agent 的业务能力必须在 DSH 原生工具与 MCP 两侧同步交付，不能只接一端（项目 P 仓库 docs/CONSTRAINTS.md §2.1；AGENTS.md 硬规则）。历史检索那次就是只接通 MCP 就报"两个工具已上线"，人类实测 DSH 侧没有工具。宣布完成前要验证两侧实际注册、schema、业务参数、来源/覆盖与领域错误语义，并写明身份与授权差异；单侧测试通过只证明已接通那侧的行为。

## Q10

分两侧：对 AI worker 必须拦截，对人不设死路（项目 P 仓库 docs/DESIGN.md P4.2）。submit/reconcile 进 review 前，完整性错误与内容漂移直接打回（409、零落盘、保留 lease）；verify 同样阻断，审计门要求独立 agent 带报告，review 期间 agent 不得改门。硬底线只保留"记录会失真"的完整性问题：missing/unreadable、command 报告失败、proof 错绑、路径逃逸；新鲜度与严格度归 owner。每个阻断留可复核记录，并给一条非豁免出路。

## Q11

不接受。给 Router/Gate 加"可选任务协议开关"仍是耦合：默认关闭也改变了这些节点的固有行为，把任务业务变成全局图的前提（项目 A 仓库 AGENTS.md、docs/node-protocol.md、ADR 0067）。通用图是架构硬边界：任务内容、版本、凭据归 Task 节点，流出的只是普通载荷，含 task 字段也不触发全局核验或关联。需要按业务键分组时用节点显式配置——Gate/Human 的 correlateBy、Router 的 rememberBy。

## Q12

未回收可续，已回收不复活。TTL 过期不等于立刻死：在 ttl + grace 内、binding 未 detached、epoch 匹配、lastSeenAt 未超宽限时，touch 可把 expiresAt 滑到不超过 progressAt + (1 + maxRenewalsWithoutProgress) × ttl；touch 不计显式次数，但同受该期限约束；判据是租约活性（binding、epoch、宽限、无进展期限），不是"同会话"这个身份条件。一旦超宽限或被 sweep 回收（写 lease/expired、epoch 变化、任务转 interrupted/readied），旧 token 的 touch/renew 不得复活，只能重新 claim 取新 token；恢复路径仅 interrupt/reconcile（项目 P 仓库 docs/CONTRACT.md §2.6）。

## Q13

用 requiresAudit: true（等价标签 gate:audit），经 task.gate、task.update 或 task.create 设置。agent 只能在非 review 状态开门，不能关门（forbidden-role）；review 中 agent 不得通过字段或标签改门，试图改会被拒绝；human 可开可关，且已开审计门的任务只能由 human 取消。门只改变验收路径，不降低证据登记与漂移检查的要求，也不给 agent 额外的关门权限。开门后 verify 需独立 agent 带 audit.report，或由 human 验收（项目 P 仓库 docs/CONTRACT.md §2.4 / §2.6）。

## Q14

文档状态仍是 Proposed（人审前），但 task.interrupt 已实现可用。rfc-3-state-closure.md 头部写"Proposed（人审前）"，正文还说"只冻结原则、不在本轮实现"——这是文档滞后；现行契约已把它列为任务操作：in_progress → interrupted、撤销 lease、保留 open intent 待 reconcile（项目 P 仓库 docs/CONTRACT.md §2.6），lib/core/commands/task.js 与 DSH/MCP 入口都已注册。故"能用"有契约与实现依据，"已通过人审"没有依据。

## Q15

不能。通用 asOf 没有交付：传统历史读计划已暂停，通用 asOf、HTTP /history 与旧分段阈值不作为本版交付条件（项目 P 仓库 docs/CONTRACT.md §8.1；docs/design/history-knowledge-read-model.md），lib 里也搜不到 asOf 实现。现在能做的是按实体读历史版本与来源（read_project_knowledge / search_project_knowledge，带版本、覆盖水位与降级标记）；第一版明确不为旧时点新增全项目 asOf 投影，也不把当前关联目标包装成那时点的状态。

## Q16

已拆出，代码里不再有 taskProtocol：prototype/backend/src 与 shared 全量搜索无匹配，只剩测试注释记"taskProtocol 已取消/旧语义已撤除"；非任务节点改为显式配置，Gate/Human 用 correlateBy、Router 用 rememberBy，只按指定顶层字段关联。文档侧 项目 A 仓库 AGENTS.md 与 docs/node-protocol.md 禁止用 taskProtocol、可选开关或共享 helper 扩散，ADR 0067 记录这条边界。早先"文档收口≠代码整改完成"的保留，现在代码已跟上。
