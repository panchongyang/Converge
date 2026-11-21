# D-r3 答题

## Q1

结论：不按“同步正文”做，按“登记 + 按需读取/派生索引”评估。D1 冻结契约已定：工作区/Git 持有正文，看板只持登记、关系、状态、确认基线与审计，外置记录里没有 body/hash（项目 P 仓库 docs/WORKSPACE-DOCUMENTS-CONTRACT.md；项目 P 仓库 docs/CONTRACT.md §2.8），历史读模型也明确“不另存外置正文副本”（§8.1）。复制正文会造出第二份事实：外部编辑后副本变旧，全文检索命中过期内容，还要处理 256KB 内嵌上限、隐私与存储增长；“离线”也不是理由，文件本就在本机。已有路径够用：登记、inspect 按需读、knowledge 经登记/证据引用读正文、固定证据锚定历史版本。若确要跨设备离线，那是导出/同步的新产品责任，须显式复议。

## Q2

结论：不要双读双写加开关，做一次性离线迁移 + 硬切版本门。CONSTRAINTS 已写死“运行时只接受当前 schema，旧数据由离线迁移脚本升级，运行时不猜旧字段、不自动迁移真实 store”（项目 P 仓库 docs/CONSTRAINTS.md）。双档兼容把“哪个字段权威、同时存在怎么办、何时删旧档”变成新的隐含契约，而且它不提供真正的回滚安全：代码回退不是数据回退，唯一支持的回滚是迁移前完整备份 + 匹配旧构建，RPO 是备份时点（项目 P 仓库 docs/MIGRATION.md §4）。前提：停写窗口与整目录备份；全量读写路径盘点（事件回放、快照、索引、客户端投影、MCP/HTTP）；dry-run 报告计数与样例；迁移只追加不重写历史；旧构建遇新数据显式拒绝；在隔离副本演练重放、health 与计数。

## Q3

结论：反对，板不执行、不重跑、不判定命令/测试。契约把 command/test 定义为只登记 ref、summary、acceptanceId 的提交者材料，服务端不执行、不验签、不校验退出码；verify 明确“不复核命令执行结论”（项目 P 仓库 docs/CONTRACT.md §2.4、§2.6 verify）。自动执行会把任意模型输入变成宿主 RCE 面，还要回答 cwd/分支/依赖/网络/超时与不可信脚本，违反“不执行不可信外部程序”的底线；跑绿也不证明产物正确，只是多一层虚假保证。更合适：由 agent/CI 在板外执行，把命令、退出码、日志摘要作为 note/command 材料登记，板负责“谁在何时提交了什么、是否漂移”。要自动化就放进 Workflow/CI，别扩大板职责。

## Q4

结论：不能这样处理，结果不明必须走 interrupt。RFC-3 把 open intent 当 WAL：有 open intent 且 outcome=unknown 时 block 必须拒绝（intent-unresolved），唯一合法路径是 task.interrupt → interrupted → task.reconcile；abandoned 只表示“这次尝试停止”，不表示没有副作用或已回滚，关闭必须带 closeReason/outcome/sideEffects/actor/at（项目 P 仓库 docs/decisions/rfc-3-state-closure.md §2.2、I22）。同一 commit 写 abandoned 只在 stopped + sideEffects 已声明时成立；这里结果不明，写 stopped 等于伪造结算。正确顺序：先 interrupt（note 必填，记录已观察到的 sideEffects），保留 open intent 停在 interrupted，再由 owner/human reconcile(resume|completed|discard)。若任务已在 blocked 等异常态且带 open intent，只有 human 能 interrupt。

## Q5

结论：按高优先级治理，但不必包装成“事故级 P0”。方针三明确“架构缺陷可以独立构成高优先级治理事项，不以已经发生生产事故为前提”，排序看维护成本、隐含契约数量、误用概率、影响范围与未来变更频率（项目 P 仓库 docs/PRODUCT-PRINCIPLES.md）。两轮返工是实打实的维护成本证据，说明缺陷已在普通变更里反复收费；没有事故只说明影响尚未外溢，不降低优先级。做法：拆成可验收的治理任务，写清要消除哪些隐含契约、由什么机制强制、后续普通变更如何验证“更容易一次做对”；排在同类新功能之前。若它仍在拖慢当前迭代，就优先于一般功能，而不是等事故。

## Q6

结论：数量增长本身不算退化，标准是它还能不能回答“现在做什么、什么在等我”。产品定位是跨会话项目事实与下一步决策，明确“不替代 git/issue tracker、不做双向同步”（项目 P 仓库 docs/DESIGN.md §1.3）；Flow 视图的假设是“决定下一步的是依赖，不是列”“待办不是工作池”（项目 P 仓库 docs/design/flow-view.md）。若计划/任务只是堆积，没有验收项、依赖和下一步，要靠筛选才找得到 #1，那才是向 issue 跟踪器退化。评估看：brief/digest 的 next 与 readyOrder 是否可用；ready 队列里真能开工的比例；backlog 是否全是“前置未完成”；计划是否仍是 initiative 容器；任务是否都有 acceptance 与 owner；维护心智成本是否上升——而不是看卡数。

## Q7

结论：反对“跳过证据登记和事件日志”的轻量档。事件日志是唯一事实源，看板/进度/digest 都是投影（项目 P 仓库 docs/DESIGN.md P3）；跳过事件会同时破坏恢复、幂等、租约/intent 对账、health 与审计，违反“不静默丢数据”；跳过证据则把“自述即事实”放回来，verify 失去材料基础，也无法再谈漂移。降级可以静默，但不能伪造可信状态。可行的轻量是降低操作成本而不删记录：更少默认字段、自动派生摘要、允许 note 作最小材料、UI 更简；记录仍落事件并标明强度。若要一个不可审计的临时模式，那是新的产品责任与信任档位，必须由所有者显式定案并明确标注“不可追溯”，不能做成默认。

## Q8

结论：不该把“对账所有外部副作用”列为 ProjectBoard 的 P0，这超出它的观测能力。板只记录“声明”：sideEffects 是提交者声明，宿主不验证（项目 P 仓库 docs/CONTRACT.md §2.4.2）；边界文档明确“板的 intent/reconcile 不证明外部进程停止，也不撤销副作用，不能拿板租约替代执行器身份或未知副作用核对”（项目 A 仓库 docs/project-board-boundary.md §5）。板没有执行、网络探测或外部系统读通道，“所有”也无法界定，宣称做到只会制造虚假保证。该做的是 P0 级“不静默关闭未知”：intent-unresolved 拒绝、interrupted/open intent 进 attention 与 digest、结算必须留痕、health 持续告警。真正的副作用对账属于执行器/Workflow 的 outbox、幂等键与人工 runbook。

## Q9

结论：不能。仓库硬规则要求“面向 Agent 的业务能力在 DSH 原生工具和 MCP 两侧同步交付”，共享 core 守卫与业务契约，业务参数、来源/覆盖与领域错误语义一致，并验证两侧实际注册及读写链路（项目 P 仓库 AGENTS.md §6）。MCP 测试通过只证明 MCP 这一端；原生工具注册、双端参数/错误码一致性、CONTRACT 更新、必要的 UI 暴露都还未被证明，而 MCP 还是默认关闭的可选入口。另外“上线”若指本机装配，也不等于发布：正式对外发布要项目所有者确认候选。宣布完成至少要给出两侧注册证据、契约 diff、双端读写测试与未覆盖项。

## Q10

结论：submit 的完整性检查应“只审可观测内容、硬错误零落盘、其余留痕”，不替人做严格度决策。DESIGN P4.2 说安全感来自可追溯而非拦截，拦截只决定这一次能不能做（项目 P 仓库 docs/DESIGN.md）。落到 submit：一次（不是逐条）审计 active evidence 的 file hash/存在性、doc head 或 pinned blob、固定 Git 结构；hard 错误 409、整条不落盘、lease 保留，错误带 details/hint 让 agent 同一租约内自修；不可观测降为 warning 随结果返回并进入 lastAudit。command/test/note/url 只登记，不执行不判成败；acceptance 覆盖只表示材料存在。人这一侧保留 refresh/acknowledge + reason，写入 waivedDrift/refreshedDrift 且 health 不隐藏；agent 不得豁免。

## Q11

结论：不要加；这个“可选、默认关闭”的开关本身就是被明确撤除的设计。ADR 0067 与节点契约的边界表写明：taskProtocol、凭据核验、凭据加入关联键、任务专用接续保护属于任务业务，“即使通过可选开关启用，也改变了 Agent、Router、Gate、Join、Human 的固有行为，应撤出这些节点的通用实现”；“其他节点上的‘任务协议参与’开关”已从目标契约中撤除（项目 A 仓库 docs/node-protocol.md；项目 A 仓库 docs/decisions/0067-generic-graph-and-node-contract-boundaries.md）。默认关闭仍会引入配置面、双路径测试、文档与“打开后谁负责”的隐含契约，并让通用层读任务字段。替代：任务节点公开查询/事件，Router/Gate 用显式字段映射与普通载荷协作。

## Q12

结论：touch 只证明“这个 session 还活着”，不能凭它重新取得或延长执行权；过了可续边界就必须回收。TTL 过期不等于立即死亡：在 ttl+grace 内、binding 未 detached、epoch 匹配、lastSeen 未过旧时租约仍可续；touch 只在绝对无进展期限（progressAt + (1+maxRenewalsWithoutProgress)×TTL）内滑动 expiresAt，不重置 progress、不消耗显式续租次数（项目 P 仓库 docs/CONTRACT.md §2.6；项目 P 仓库 lib/core/handle.js touch）。一旦超过宽限、lastSeen 过旧或 epoch 变了，touch 对租约是 no-op，sweep 写 lease/expired，任务转 interrupted（有 open intent）或 ready；回收后旧 token/epoch 不能复活，原 session 只能用原 token 做 interrupt/reconcile，否则重新 claim 拿新 token。

## Q13

结论：字段是 requiresAudit（布尔），或 labels 含 gate:audit；agent 只能开、不能关。task.create/task.update/task.gate 都接受 requiresAudit；开启后 review→done 的 agent 验收必须是独立 agent 且带 20–4000 字自述报告，human verify 始终可用；gate:audit 是等价标签。agent 在非 review 可设 true，显式设 false 返回 forbidden-role；review 期间 agent 也不能通过字段或标签改门，human 可开关（项目 P 仓库 docs/CONTRACT.md §2.4、§2.6）。已开审计门的任务 agent 不能 cancel。注意旧字段 requiresHumanReview/gate:human 已被 schema v3 迁移改名，现在不要再用。

## Q14

结论：RFC-3 文档头仍写 Proposed（人审前），但其规范内容已进入现行 CONTRACT 并落地；task.interrupt 现在可用。CONTRACT §2.4 命令表、§2.4.2 Intent 结算、§2.4.3 Archived 写闸都直接引用 RFC-3；项目 P 仓库 lib/shared/contract.js 的 op 列表含 task.interrupt，项目 P 仓库 lib/core/commands/task-gov.js 有 taskInterrupt 实现，MCP 也注册 interrupt_task。用法：note 必填，in_progress 需 lease+token（human 可强制），只把任务停到 interrupted、保留 open intent，之后必须 reconcile；遗留 blocked/review 等带 open intent 的状态仅 human 可 interrupt。提醒：RFC 的“Proposed”标注已过时，别据此认为能力未上线；§9 移交 S4 的租约活性约束也已在 CONTRACT 的续租/回收条款中细化。

## Q15

结论：目前不能按任意 asOf 查询，只能查事件流或带版本锚点的历史读取。query 视图只有 brief/board/task/plan/plans/docs/doc/events/health，events 只支持 after/limit，没有 asOf 参数（项目 P 仓库 docs/CONTRACT.md §2.5）；知识读取用 ref/historyRef 与 commit seq/hash 锚定来源，不是全项目时点快照。§8.1 明确“通用 asOf、/history 与旧分段阈值不作为此版交付条件”，lib 里也没有 asof 实现。注意 §8.2 仍残留 asof-out-of-range 的错误语义，那是旧历史读计划的文字，不能当作已实现证据；要近似只能读 events 到某个 seq 自行重放，且没有服务端保证。

## Q16

结论：已经拆出去了。ADR 0067（accepted，2026-11-14 代码整改完成）把任务内容/版本/凭据及业务解释收归 Task 节点；节点契约的整改表写明 Agent/Router/Gate/Join/Human 不再核验凭据、不并关联键、不做任务专用接续保护，任务协议类型与校验收在任务节点模块，关联字段改由 correlateBy/rememberBy 显式配置（项目 A 仓库 docs/node-protocol.md；项目 A 仓库 docs/decisions/0067-generic-graph-and-node-contract-boundaries.md）。项目 A 仓库 docs/status.md 也确认“任务协议收回任务节点，其他节点只把 task 当普通载荷”。提醒：同一 status.md 的“已贯通的行为”里仍有一句“Agent、Router、Gate、Join、Human 可显式采用协议”，与整改后的契约冲突，属过时描述，应以 ADR 0067 和 node-protocol 为准。
