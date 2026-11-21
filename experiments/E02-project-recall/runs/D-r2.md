## Q1

结论：默认不做正文同步，那是在复制真相。外置文档只登记定位与元数据，服务端不存正文；内嵌文档是只读档案，新项目默认 inlineWritesDisabled:true（项目 P 仓库 docs/CONTRACT.md §2.8），知识检索也明确不另存外置正文副本（§8.1）。同步会制造第二份真相和漂移，并把看板变成私密文档副本。全文检索可对已登记、可读文档用 search_project_knowledge；离线阅读在源不可用时缺能力，应如实标不可重建。若确有留存需求，应做不可变快照+来源/hash+明确非当前版本，并作为改变冻结文档语义的产品决策由所有者确认。

## Q2

结论：不建议两档兼容+开关作为默认，按离线迁移+硬切。运行时只接受当前 schema，旧数据由包外脚本 dry-run/backup/apply 升级，不猜旧字段、不自动迁移真实 store（CONSTRAINTS §2.4、MIGRATION.md §1）。两档让同一日志有两种语义，读写、回放、测试翻倍，开关本身成为永久隐含契约；回滚安全也是假的，代码回退不是数据回退，旧构建还可能读入新数据却静默丢失审计门等语义（MIGRATION §4）。前提：字段使用面清单、转换是否无损、停写与源外备份、fixture 演练、契约与迁移文档、真实数据单独授权；回滚只走备份+匹配旧构建，并确认 RPO 与外部副作用。

## Q3

结论：不应在 verify 前自动执行。现行边界是记录材料、不替材料背书：command/test 只登记 ref/summary，服务端不执行、不重跑、不验签、不看退出码（CONTRACT §2.4；README 产品边界）。自动执行还违反不执行不可信外部程序底线（CONSTRAINTS §1），命令有副作用，verify 时重跑会把复核变成再执行。RFC-4 曾提宿主执行，当前契约明确没有该能力。若确需更强命令证据，应做独立、显式授权、隔离的执行观测，记录 executor/exitCode/output hash，并标明执行留痕≠任务正确，不能作为 verify 通过条件。

## Q4

结论：不能这样收口。open intent 是 WAL，表示副作用可能已发生；结果不明时标 abandoned 就是静默丢弃不确定性，违反 I6/I22。block 在 open intent 下必须带 intent.outcome=stopped + sideEffects，unknown 或缺结算一律 intent-unresolved 409，零落盘、rev/lease 不变（CONTRACT §2.4.2）。正确路径是先 task.interrupt（note 必填，→interrupted，保留 open intent、撤销 lease），再 task.reconcile 选 resume/completed/discard 结算；human 可修遗留异常状态。把未知写成已知，后续无法追责；拒绝不写日志，调用方需重读任务再选路径。

## Q5

结论：应作为独立高优先级架构治理项，但不因没出事故而降级，也不必自动等同 P0。产品方针三明确：架构缺陷可独立构成高优先级，不以事故为前提；排序看维护成本、隐含契约数量、误用概率、影响范围、未来变更频率（项目 P 仓库 docs/PRODUCT-PRINCIPLES.md）。两轮返工是维护成本实证，但还需确认根因是架构而非个别实现，并评估影响面是否阻塞交付或触及数据/安全。做法：单列治理任务，写清范围与退出标准，与功能任务同样进计划，不塞进某次修复顺手做。

## Q6

结论：数量增长本身不算退化，退化要看决定下一步的成本是否上升。定位是结构化连续知识库，任务/计划是知识入口之一，不是通用 issue tracker；DESIGN 明确不替代 issue tracker（项目 P 仓库 docs/DESIGN.md §1.3）。评估看：新会话靠 digest/nextAction/rank 多快选对下一步；ready 候选是否真有验收与证据；blocked/interrupted/陈旧任务是否堆积；计划是否承载决策背景；使用者是否被迫先学内部模型。只增加记录负担、降低决策质量才是退化；沉淀了可恢复知识，则是定位内积累。

## Q7

结论：不建议。跳过证据和事件日志、只留状态，等于换掉产品根基：事件日志是唯一事实源，状态、进度、租约、intent、崩溃恢复、fsck、审计都由它派生；没有日志就没有可追溯，也无法在中断后判断副作用（DESIGN P3/P6、CONSTRAINTS §2.4）。证据是 review/verify 的材料，去掉后 done 只剩自述，违反不伪造、不静默丢数据底线。轻量场景该减仪式而非事实：用 note/file 证据、无 Git 自动降级、manual 验收即可，日志与 intent 仍在。担心成本应优化投影和索引；加档位会增加配置与心智负担，违背方针一。

## Q8

结论：不应列为 ProjectBoard 的 P0。板只记录提交者声明的副作用并暴露不确定性：sideEffects 明确是声明不是验证，intent/reconcile 不证明外部进程停止、也不撤销副作用（CONTRACT §2.4.2；项目 A 仓库 docs/project-board-boundary.md §5）。对账所有外部副作用需要外部清单、访问权和业务裁决，超出板的产品职责，属于不扩大产品职责要先授权的范围（CONSTRAINTS §1）。板的 P0 应是防止假确定性：中断后保留 open intent、强制 reconcile、显式呈现 attention。真正对账 P0 应落在执行层，按副作用归属逐项处理。

## Q9

结论：不能。面向 Agent 的能力必须在 DSH 原生工具与 MCP 两侧同步交付，只接一端违反仓库硬规则（AGENTS.md §6；CONSTRAINTS §2.1）。MCP 通过测试只证明一端功能，未证明 DSH 侧实际注册、参数/错误语义一致、读写链路可用，也未覆盖 UI、文档与契约同步。发布边界还把本地测试、HTTP/工具面成功与线上发布、目标宿主部署分开，正式发布须所有者确认（RELEASE.md）。因此最多说 MCP 侧候选可用；交付完成需两侧注册与回归、契约与文档、独立审查、部署验证。

## Q10

结论：submit 检查应记录事实，只拦会让记录失真的问题。硬拦（409、零落盘、lease 保留）仅限形状/白名单、身份授权、rev/租约、证据不可读或 hash/身份不符、跨项目引用等会让日志说谎的情况（CONTRACT §2.4、§2.8）。Git 不可观测、current-only 降级只作 warning+fixedReason；command/test 只按提交者材料登记，不执行也不产生伪校验。agent 不得豁免漂移；human 在 verify 可 refresh 或 acknowledge+reason，waivedDrift 留痕、可见、可回退（DESIGN P4.1–P4.2）。每个阻断都要给非豁免出路和可复核记录；严格度由项目策略声明、可审计、可回退。

## Q11

结论：不应加。节点契约明确把其他节点上的任务协议参与开关从目标契约中撤除，理由正是：即使可选、默认关闭，也改变了 Agent/Router/Gate/Join/Human 的固有行为，让非任务节点承担任务业务（项目 A 仓库 docs/node-protocol.md）。ADR 0067 已 accepted，整改后 taskProtocol 已取消，其他节点只把 task 当普通载荷。若 Router/Gate 真要核对任务版本，应经 Task 节点的公开查询/观察，或由图显式配置普通关联字段，由 Agent 判断；不要用开关制造两条行为路径和新的隐含契约。

## Q12

结论：先判可回收再谈续期，不能一概给或拒。若 binding 已 detached、epoch 变了、lastSeen 超过 TTL+grace，或已过 expiresAt+grace，则租约可回收，touch 是 no-op，随后 sweep 写 lease/expired 并转 interrupted（有 open intent）或 ready，旧 token 不能复活（CONTRACT §2.6）。若只是 TTL 过期但仍在 grace 内、binding/epoch 匹配、未到 progressAt+(1+maxRenewalsWithoutProgress)*TTL 的绝对期限，touch 可把 expiresAt 滑到 min(now+TTL, 绝对期限)，执行权仍属该 session，不写 commit、不重置进展；到绝对期限后不得再延长；touch 不消耗显式续租次数，但仍受同一绝对期限约束。

## Q13

结论：字段是 requiresAudit:true（也可用 labels 的 gate:audit），或用 task.gate {taskId, requiresAudit:true} 开启（CONTRACT §2.4）。开启后 verify 必须由不在 worker 集合内的独立 agent 带 audit.report，或由 human 验收；human verify 始终可用。agent 只能开不能关：非 human 只能在非 review 状态把门打开，传 false 会被拒；human 可开关，且门不需要租约（CONTRACT task.update/task.gate；CONSTRAINTS §4.3）。所以 AI 不能自行关掉第三方审查门，这是有意的防绕过设计，审计门独立性靠此保证，human 兜底始终保留。

## Q14

结论：决策记录仍写 Proposed（人审前），但现行契约和代码已经落地，task.interrupt 现在可用。CONTRACT §2.4 把 interrupt 列入命令表（in_progress→interrupted，保留 open intent，遗留异常状态仅 human），§2.4.2 规定它不关闭 intent、由 reconcile 收口；core task-gov、host 工具与 MCP 写入口都注册了该 op，intent-settlement/lease-reclaim 测试覆盖。结论以契约与代码为准；RFC-3 文档状态与实际不一致，属文档滞后，建议人审后更新决策记录，而非当成未实现。

## Q15

结论：不能按任意 asOf 查询。现行契约只提供按事件/实体版本的精确定位与历史读取：任务修订、计划版本、内嵌 doc rev、固定 Git 引用各有身份，历史知识检索不承诺通用时间旅行，也不把当前关联包装成旧时点（CONTRACT §8.1；项目 P 仓库 docs/design/history-knowledge-read-model.md §4）。通用 asOf 与 /history 被明确列为暂停的旧方案、不作交付条件（CONTRACT §8.1 末）。离线重放日志理论上可重建某 seq 状态，但那是诊断/恢复手段，不是查询 API。需要 asOf 得单独立项，先定语义和成本。

## Q16

结论：已拆出。2026-11-14 整改把任务协议收回 Task 节点：类型与校验在 prototype/shared/nodes/task/，Agent/Router/Gate/Join/Human 不再核验凭据、不并关联键、不做任务专用接续保护，关联字段改由图配置的 correlateBy/rememberBy 决定（项目 A 仓库 docs/status.md；node-protocol.md；ADR 0067 accepted）。代码里 taskProtocol 只剩测试注释，旧开关已取消。遗留：共享 protocol 描述仍保留 Task 节点的 task 信封声明，但通用驱动不读，属于 Task 节点自己的公开契约，不是跨节点耦合。
