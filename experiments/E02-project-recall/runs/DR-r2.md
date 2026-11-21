## Q1

结论：不建议把工作区设计文档正文同步一份到看板。看板的文档定位是“登记 + 引用”：项目工作区/Git 持有正文，看板只保存登记、关系、人工状态、确认基线与审计（`项目 P 仓库 docs/WORKSPACE-DOCUMENTS-CONTRACT.md` §0）。复制正文会造成两份内容不一致，并把检索建立在副本上，违反外置文档边界。离线查看/检索应读已登记的工作区文件或固定证据，正文不入看板；`项目 P 仓库 docs/EXTERNAL-DOCS.md` 明确外置记录不含 body。若确实需要缓存，也应标为派生、可丢弃、不成为事实源。

## Q2

结论：不要做“两档兼容”，做一次性显式迁移。依据：本项目未发布、只有本机 pre-release store；`项目 P 仓库 docs/decisions/product-policy-review-v6.md` 已把 v2→v3 硬切登记为开发者一次性负担，并写明“若未来出现外部 v2 store 再评估”。前提：确认没有外部 store/消费者；迁移前完整备份；脚本默认 dry-run、用绝对路径显式 apply；事件按 applied/additive/migration/refuse 分类；回滚只承诺“备份 + 旧构建”，不承诺双向兼容。运行时不得猜旧字段或自动迁移真实 store（`项目 P 仓库 docs/CONTRACT.md` 第 662 行）。旧名若只是显示层，做显示迁移即可。

## Q3

结论：反对。ProjectBoard 的 command/test 证据只是提交者材料：服务端不执行 ref、不重跑、不校验退出码，verify 也不复核命令结论（`项目 P 仓库 docs/CONTRACT.md` 第 19、394、398、522 行）。自动执行会把看板变成命令执行平台，引入副作用、超时、环境和依赖责任，违背“除 DSH 外零依赖”与“不执行看板里的任何内容”（`项目 P 仓库 docs/DESIGN.md` 第 593 行）。正确做法是让执行者/CI 真正跑，把结果作为材料记录；看板只识别漂移、不替证据正确性背书。若需更强证据，应引入独立执行器，而不是在 verify 前由看板代跑。

## Q4

结论：不能在同一 commit 里把 intent 标 abandoned 了事；结果不明时必须走 task.interrupt → interrupted → task.reconcile。abandoned 只表示“这次尝试停止”，不代表没有副作用或已回滚，且必须带 outcome/sideEffects/actor/at；若历史上已这样标过，应按遗留异常处理，核对副作用并走 interrupt/reconcile 修复，不能当没发生。block 遇 outcome=unknown 或缺结算记录应返回 intent-unresolved（409），零写入，并提示唯一合法路径是 interrupt（`项目 P 仓库 docs/decisions/rfc-3-state-closure.md` §2.3）。只有确认“已停止”并能声明已观察到的副作用时，才允许 block 并写 abandoned、closeReason 为 blocked。省事不能以隐藏不确定性为代价。

## Q5

结论：至少列为高优先级治理项，不必等生产事故。`项目 P 仓库 docs/PRODUCT-PRINCIPLES.md` 方针三明确：变更安全性与长期可维护性是一等质量属性，架构缺陷可独立构成高优先级；排序看实际维护成本、隐含契约数量、误用概率、影响范围、未来变更频率。两轮返工已证明变更摩擦和累计成本，但“高优先”不等于已证明整体失控，也不等于所有返工同源。应把它作为架构治理立项，给出边界、验收与后续变更是否更容易一次做对的观察指标，而不是只以测试全绿结案。

## Q6

结论：不算产品退化，但“只堆记录、不产出下一步”才是问题。项目的第一目的是记录真相：解决 AI 反复改动后没人看得懂现状（历史记录 E08）。评估应看三件事：现状可解释、改动可追问、历史可重建；档案标准是“三个月后能不能看懂、能不能反驳”，不是今天推进多快。`项目 P 仓库 docs/DESIGN.md` 也明确看板不替代 git/issue tracker、不做双向同步。因此计划和任务变多是正常的；若视图只增加条目、不突出 NEXT READY 与优先级、记录噪声化或脱离代码，那是投影/治理问题，不是记录本身的原罪。

## Q7

结论：不能跳过事件日志和证据登记。事件日志是唯一事实源，看板/进度都是可重建投影（`项目 P 仓库 docs/DESIGN.md` P3）；跳过日志等于放弃可追溯、恢复和漂移识别，也违反“不静默丢数据、不伪造”底线（`项目 P 仓库 docs/PRODUCT-PRINCIPLES.md`）。轻量化的正确层次是“轻的是判定，不是记录”：可放宽验收严格度、AI 自主权、流程步骤和界面，但凡声称完成，事实与材料仍须如实记录。证据可按 acceptance 要求分级，不能把“没登记”当成“没发生”。历史上也只接受了原则，未授权具体档位。

## Q8

结论：不赞成把“恢复时对账所有外部副作用”列为 ProjectBoard 的 P0。看板只记录经提交的任务/证据/来源与漂移，不观测所有执行通道；intent/reconcile 不证明外部进程停止，也不撤销副作用（`项目 A 仓库 docs/project-board-boundary.md` §1、§5）。“无法确认副作用”应如实记录为 unknown，由执行控制层（DSH/宿主/Workflow）对账；把它塞进看板会新增产品责任和不可实现的观测承诺。缺口若真实存在，应先在执行层立项，而不是把系统协作层的责任空白记成看板缺陷。

## Q9

结论：不能。面向 Agent 的业务能力必须在 DSH 原生工具与 MCP 两侧同步交付，只接一端不算完成（`项目 P 仓库 AGENTS.md` 硬规则；`项目 P 仓库 docs/CONSTRAINTS.md` §2.1）。MCP 上线并通过测试只证明一侧链路；还必须验证 DSH 侧实际注册、schema、身份/授权与读写链路，并确认两侧共享 core 守卫和业务契约。历史上就发生过“MCP 上线、DSH 侧没有工具”的漏交付（E13）。正确说法是“MCP 侧可用，DSH 侧待补/待验”，不能宣布整体交付完成。

## Q10

结论：AI worker 的 submit 要做硬完整性拦截，人侧则保留可追溯的合法出路。`项目 P 仓库 docs/DESIGN.md` P4.2 明确分两侧：agent 不得豁免证据漂移，submit/reconcile 前对 missing/unreadable、file/doc 内容漂移、proof 错绑、路径逃逸等直接 409、零落盘、保留 lease；verify 同样阻断，审计门还要求独立 agent。人可以用 refresh/acknowledgeDrift + reason 处理，但每次阻断都要留记录并给出至少一条非豁免出路。不要把“可追溯”误解成对 AI 也放宽；AI 侧恰恰必须拦截，人才有最终裁量。

## Q11

结论：反对。任务协议是任务节点自己的业务，不是通用图的公共配置；给 Router/Gate 加“可选参与”开关仍然是耦合，会改变它们的准入、关联和接续行为，并让通用层解释任务字段（`项目 A 仓库 docs/node-protocol.md` 的边界表明确写着“即使通过可选开关启用也违反边界”）。“默认关闭、不影响其他人”不成立：开关本身、共享 helper 和隐式关联键都会成为其他节点必须记住的隐含契约；无任务图能跑也不证明解耦。正确做法是 Router/Gate 只按公开输入处理普通载荷；需要版本核对时显式查询任务节点的公开只读结果。

## Q12

结论：先看租约是否已被回收，不能一概“续上”。TTL 过期后仍有 grace：若 binding 未 detached、epoch 匹配、lastSeenAt 在 TTL+grace 内，touch 可以滑动续期，但只能在“无进展绝对期限”内（progressAt + (1+maxRenewalsWithoutProgress)*TTL），且不重置进展，默认最多 3 个 TTL（`项目 P 仓库 docs/CONTRACT.md` 第 589-596 行）。一旦已 sweep 回收、超过宽限、epoch 变了或已产生新 token，旧 touch 必须被拒（fencing-stale/no-op），不得复活旧租约。touch 只是活性信号，不是新的执行权；恢复只能走 task.interrupt/task.reconcile，执行权归当前 token。

## Q13

结论：设置 requiresAudit: true（等价标签 gate:audit）。`项目 P 仓库 docs/CONTRACT.md` 第 275-276、486 行规定 task.gate 只切这个开关；agent 可以在非 review 状态开门，但不能关门，显式 false 返回 forbidden-role；review 中 agent 也不得通过字段或标签改变门；只有 human 能开关。若允许 agent 关门，worker 就能自己绕过第三方审查。开门后 submit 停在 review，verify 需要独立 agent 带 audit.report，human verify 始终可用。注意旧文档里的 requiresHumanReview/gate:human 是旧名，不应再用于新任务。

## Q14

结论：RFC-3 文档仍是 Proposed（人审前），不能说是“已通过”；但它描述的 task.interrupt 已经实现并可用。`项目 P 仓库 docs/decisions/rfc-3-state-closure.md` 头部状态未更新；而 `项目 P 仓库 docs/CONTRACT.md` 已把 task.interrupt 列入命令表（in_progress → interrupted，保留 open intent），host 侧有 interrupt_task，`项目 P 仓库 lib/core/commands/task-gov.js` 有实际 handler，MCP/DSH 的 op 枚举也包含 interrupt。结论：能力可用，文档审批状态滞后；引用时应说“已实现、文档仍标 Proposed”，不要说“已人审通过”；建议把状态补成与实现一致，否则会误导新会话。

## Q15

结论：目前不能按 asOf 查询任务当时的状态。`项目 P 仓库 docs/CONTRACT.md` 明确“传统历史读计划暂停，通用 asOf、/history 与旧分段阈值不作为此版交付条件”（第 1098 行）；`项目 P 仓库 docs/design/history-knowledge-read-model.md` 也说不新增全项目 as-of 投影。现有能力是事件日志 + 知识检索/读取：search_project_knowledge/read_project_knowledge 可按来源版本、commit seq 定位片段，但不是“给一个时刻返回整板快照”。要得到历史状态，只能离线 replay 事件或按引用逐条读取；不能把检索命中当成 asOf 查询。

## Q16

结论：代码层面已经拆出，文档层面尚未完全收口。2026-11-14 整改后，生产代码中已无 taskProtocol；ADR 0067 标 accepted，`项目 A 仓库 docs/status.md` 声明“任务协议收回任务节点，其他节点只把 task 当普通载荷”，测试注释也写着“taskProtocol 已取消”。依据是 `项目 A 仓库 docs/decisions/0067-generic-graph-and-node-contract-boundaries.md` 和 `项目 A 仓库 docs/node-protocol.md` 的边界表。但 status.md 的“已贯通的行为”仍写 Agent/Router/Gate 可显式采用协议，README 也留“文档收口不代表代码整改完成”；应以生产代码 + ADR 0067 为准，并修掉这些旧段。