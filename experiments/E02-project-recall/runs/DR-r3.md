## Q1

结论：不要做“同步一份正文”。项目板只登记外置文档（locator、基线、状态、漂移），正文归项目工作区并上 git；复制正文会造出两份权威、需要双向同步，还会把“未漂移≠正确”变成假象。离线查看与检索应走登记 + 固定证据（fixed）读取与知识检索，不另存副本；工作区不可用时如实标 missing_binding/current-only，不能用副本冒充。出处：docs/EXTERNAL-DOCS.md §1、CONTRACT §8.1“不另存外置正文副本”、README 产品边界。

## Q2

建议不做两档兼容，直接显式迁移/硬切。项目未发布、只有本机 store，没有外部 v2 数据；双读+开关是为不存在的对象付维护成本，还留下两套语义。前提：确认无外部 store；停写并完整备份；离线迁移脚本 dry-run、幂等、坏数据 fail-closed；回滚只承诺“备份+旧构建”，代码回退不等于数据回退。若已发布或出现外部 v2 store，再复议。出处：product-policy-review-v6.md、CONSTRAINTS §2.4、MIGRATION.md。

## Q3

反对。项目板只诚实记录证据，不替证据正确性背书；command/test 是提交者材料，服务端不执行、不重跑、不校验退出码，成功与失败同样只是材料。自动执行会把不可信外部程序、环境依赖和“未通过即不能完成”的责任揽进产品，也越过了 DSH 宿主与审计者的职责。需要核验时由独立 auditor 自行跑并出报告；漂移可识别，但“未漂移≠结论正确”。出处：CONTRACT §1、§2.5；README 产品边界；产品方针底线。

## Q4

不行。open intent 是 WAL，表示副作用可能已发生；结果不明时 block 必须拒绝（intent-unresolved），提示走 interrupt→interrupted→reconcile，intent 保持 open。确认停止且列出 sideEffects 时，才可带 intent:{outcome:'stopped', sideEffects:[...]} 关闭后 block；abandoned 只表示尝试停止，不表示无副作用。出处：RFC-3 §2.2–2.4、CONTRACT task.block。

## Q5

应列为高优先，不必等生产事故。依据产品方针三：变更安全性与长期可维护性是一等质量属性，架构缺陷可独立构成高优先级；排序看实际维护成本、隐含契约数量、误用概率、影响范围、未来变更频率，而不是只看事故严重度。两轮返工是变更摩擦的实证，说明成本已经发生，但不能据此宣称整体失控；证据确定度只决定结论能写多满，不替代优先级判断。出处：docs/PRODUCT-PRINCIPLES.md 方针三、AGENTS.md §1。

## Q6

不必然是退化。记录真相是这个项目的第一目的：解决持续推进中 AI 改来改去、后来谁都看不懂现状的问题；“决定下一步”只是用途之一。评估应看三件事：现状可解释、改动可追问、历史可重建——三个月后能不能看懂、能不能反驳。任务/计划变多本身不是问题；若变成噪声化、脱离代码的 issue 流，那是档案质量出了问题，应修档案而不是否定记录目的。出处：历史记录 E08；README 产品边界。

## Q7

反对跳过证据登记和事件日志。可轻的是判定与流程体验（自主权、验收严格度、交互步骤），不可轻的是事实层：事件日志是唯一事实，看板只是投影；删掉证据与事件会让“未验证完成”无法与“已验证”区分，违反不伪造、不静默丢数据。轻量档位若要存在，只能放宽验收严格度或人工步骤，并如实记录放宽本身；未验证完成仍须可见。出处：产品方针底线、DESIGN P3/P4、历史记录 E11。

## Q8

缺口成立，责任归属不成立。任务板是建立在 DSH 上的应用，不是日志系统：它记录任务事实与证据，不宣称独立、完整地观测所有执行通道；reconcile 允许“未知”，也不等于验证外部动作可安全重做。把“恢复时对账所有外部副作用”列为任务板 P0，会把宿主/执行层的责任错配给产品。应先划清归属：需要全局副作用台账就在 DSH/执行层做，任务板只承接可记录、可追溯的部分。出处：历史记录 E12；产品边界；CONSTRAINTS §1。

## Q9

不能。面向 Agent 的业务能力必须在 DSH 原生工具与 MCP 两侧同步交付；MCP 上线只证明一端可用。宣布完成前要验证：DSH 侧工具实际注册、schema 与业务参数一致、读写链路可用、共享 core 守卫、身份/授权差异已写入契约；只接一端正是这条约束要防的遗漏。UI 不要求与入口等价。出处：CONSTRAINTS §2.1、AGENTS.md 硬规则、CONTRACT 工具表。

## Q10

分两侧设计，不能把“可追溯优先”理解成对 AI 也放宽。AI worker 在 submit/reconcile 进入 review 前，完整性错误与内容漂移直接打回（409、零落盘、lease 保留），verify 时同样阻断；审计门还要求独立 agent 带报告，review 期间 agent 不得改门。人一侧不以死路拦截：保留事实、合法出路与可复核记录，freshness 由 owner 选择 refresh/waive/返工。硬底线只保留“记录会失真”的完整性问题。出处：DESIGN P4.2、产品方针底线。

## Q11

反对。通用图是架构硬边界：图管连接与推进，节点拥有自己的业务协议；任务内容、版本、凭据属于任务节点，不能通过“可选开关”扩散。默认关闭仍是耦合，因为它改变了 Router/Gate 的固有行为与准入前提。正确做法是 Task 节点把 workId/round 等业务键作为普通载荷发布，其他节点按公开输入处理；分组用显式 correlateBy 字段，不核验凭据。新增全局机制须先论证通用图语义。出处：项目 A README、docs/node-protocol.md、ADR 0067。

## Q12

TTL 过期不等于死亡。仍在 grace 内、binding 未 detached、epoch 与 token 匹配时，touch 可滑动续期，但受绝对无进展期限：progressAt+(1+maxRenewalsWithoutProgress)×TTL，最多 3 个 TTL，到限后不得再延长；到期由 sweep 回收。回收后或产生新 token，旧 token/epoch 的 touch 必须拒绝或 fencing-stale，不能复活旧租约。出处：CONTRACT 租约/过期恢复、lib/core/lease.js、RFC-3 §9。

## Q13

设 requiresAudit: true（等价标签 gate:audit），通过 task.create/update/gate 设置。agent 只能在非 review 状态开门，不能关门（forbidden-role）；review 中 agent 也不能经字段或标签改门，防止开门后自审；human 可开关。门控任务取消也只能由 human 执行。旧名只在迁移工具与历史数据，运行时只认新名。出处：CONTRACT §2.4/§5、DESIGN 审计门、MIGRATION v3。

## Q14

文档状态是 Proposed（人审前），但能力已实现可用：task.interrupt 已注册进命令表与工具映射，CONTRACT 有该 op（in_progress→interrupted，保留 open intent），intent-settlement 测试覆盖该行为。“能用”成立；但不能说“已通过人审”——RFC 头部仍标 Proposed，属文档滞后，需人审更新，别把实现当批准。出处：rfc-3-state-closure.md 头部、CONTRACT、lib/core/commands/task.js。

## Q15

不能。通用 asOf 未实现：CONTRACT §8.1 明确“传统历史读计划暂停，通用 asOf、/history 不作为此版交付条件”，调研文档也提醒规格里的 asOf 不代表已实现；lib 中没有 asOf 入口。现有能力是完整事件日志、按实体版本锚点的知识检索/读取（refs 带版本），而不是“某时刻全项目状态投影”。§8.2 里 asOf 的错误码语义是规格残留，不能当能力证据。要回答历史时刻，只能重放日志或另做 asOf 投影。

## Q16

是，已拆出。2026-11-14 完成代码整改：任务协议只剩任务节点模块（shared/nodes/task/protocol.ts），taskProtocol 已从 Agent/Router/Gate/Join/Human 移除，仅测试注释等非生产代码残留旧语义；其他节点把 task 当普通载荷，分组/实例记忆改用显式字段配置。依据：docs/status.md、docs/node-protocol.md、ADR 0067。README 与 status 的“已贯通行为”段仍有旧表述，属文档滞后。
