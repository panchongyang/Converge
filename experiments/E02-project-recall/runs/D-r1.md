## Q1

结论：不应默认同步正文。D1 冻结契约把正文留在工作区，看板只存登记、定位、状态、基线、审计，明确不自动同步、不持久化正文 blob（项目 P 仓库 docs/WORKSPACE-DOCUMENTS-CONTRACT.md §0）；内嵌写入也默认禁用。同步副本会制造第二权威：正文演化后副本陈旧，hash/@rev 与固定证据对不上，检索结果无法判定新鲜度，还增加容量和私密材料扩散。离线需求应做显式只读缓存，带 sourceHash、observedAt、非权威/可能过期标记，不写回、不作 fixed 证据，并按冻结契约走 D1 复议；现有知识检索已能在源可读时搜外置正文。

## Q2

结论：不建议长期两档兼容+开关，应做一次性显式 schema 迁移。项目先例是 v2→v3：停宿主、整目录备份、dry-run、追加迁移 commit、保留原始历史、幂等，旧 schema 返回 schema-migration-required（项目 P 仓库 docs/MIGRATION.md §1–4）。双读双写让“哪个字段权威”变成隐含契约，开关制造未测试路径；旧构建可能读入新数据却静默丢字段，回滚不能只回代码。前提：语义映射而非只改名、旧数据盘点、停写/独占锁、store 外一致性备份、迁移可重放、版本门禁、旧构建行为与 RPO 确认、副本上演练迁移和回滚。发布窗口若必须共存，只允许有边界的只读兼容，禁止双写。

## Q3

结论：反对把 command/test 自动执行设为 verify 前置门。契约规定 command/test 只登记 ref 和 summary，服务端不执行、不重跑、不验退出码，成功失败都只是提交者材料；verify 也不复核命令结论（项目 P 仓库 docs/CONTRACT.md 第 394、522 行）。项目底线还有“不执行不可信外部程序”；代跑会把看板变成执行平台，引入环境、密钥、副作用和不可复现问题，且命令通过不等于交付正确。若确需执行，应另立可选、沙箱化能力：调用者授权、限定工作区与超时、记录环境和退出码，标明是观测而非验收担保，不能成为 done 的自动通行证。

## Q4

结论：不能在同一 commit 把 unknown 的 intent 标成 abandoned 换 blocked。open intent 是 WAL，abandoned 只表示尝试停止，不表示没发生副作用；unknown 一律拒绝 intent-unresolved，block 只接受 stopped+sideEffects（项目 P 仓库 docs/CONTRACT.md §2.4.2 与 block 段）。把 unknown 写成 abandoned 会让日志谎称已结算，违反 I6/I22。正确路径：先 task.interrupt，note 必填，可带已观察 sideEffects；任务转 interrupted、intent 保持 open；再由 owner 用旧 fencingToken（binding/epoch 未变）或 human 做 reconcile（resume/completed/discard）。只有确认已停止，才可在 block 同一 commit 写 stopped+sideEffects+abandoned。关键是不把不确定写成确定。

## Q5

结论：应按高优先级治理，至少 P1，通常排在新增功能之前；“没有生产事故”不降低优先级。产品方针三明确，架构缺陷可独立构成高优先级，不以事故为前提；排序看维护成本、隐含契约数量、误用概率、影响范围和未来变更频率（项目 P 仓库 docs/PRODUCT-PRINCIPLES.md 方针三）。两轮返工已证明维护成本和误用概率，说明这个接缝每次改动都要重新踩。建议登记为架构治理任务，先冻结边界和验收（后续普通变更是否更容易一次做对），再改代码；是否升 P0 看影响范围和是否阻塞当前交付，而不是等事故。

## Q6

结论：任务/计划变多本身不算产品退化；判断标准是它是否还帮使用者决定下一步。计划 v2 把 Plan 定为 initiative 容器，Task 仍是唯一工作单元；focusPlanId、brief 的 nextAction 和候选排序就是为下一步服务的（项目 P 仓库 docs/PLAN-V2.md §1）。如果默认体验变成浏览、筛选、分诊队列，而 fresh session 不能在一次读取内拿到可信的“下一个”，那才是退化。评估看：新会话从 brief 到正确 claim 的时间与命中率、候选数量与相关性、ready 中陈旧/孤儿任务占比、WIP 与返工率、focus 是否清晰、attention 是否可行动；不是看任务总数或像不像 issue tracker。

## Q7

结论：不应提供跳过证据登记和事件日志、只留任务状态的档位。事件日志是唯一事实源，看板、进度、digest 都是投影（项目 P 仓库 docs/DESIGN.md P3）；跳过日志会同时破坏回放、崩溃恢复、租约/意图对账和审计，违反“不静默丢数据”。没有证据，acceptance.met 和 review 也失去可复核依据。轻量场景应省人的操作，不是省记录：允许 note/url 作为材料、UI 折叠证据细节、减少必填项，但 submit 仍写事件和 evidence 行，仍进 review。若按任务类型放宽，应做成可声明、可审计、可回退的项目策略，并保留历史。

## Q8

结论：把“恢复时对账所有外部副作用”列为 ProjectBoard 的 P0 是职责错位。板的边界是记录项目事实与状态守卫；它不执行外部动作，也没有外部系统的观测权。intent/reconcile 不证明外部进程停止，也不撤销副作用（项目 A 仓库 docs/project-board-boundary.md §5）。ProjectBoard 的 P0 应是：绝不把未对账 intent 当已解决，归档/完成前拒绝 open intent，interrupted 队列可见，sideEffects 必须显式声明，reconcile 记录 resolution。真正的对账归执行器/Workflow 或具体集成，作为它们的 P0；板只接收并展示结论。把无法观测的事写成板的 P0，只会逼出假声明。

## Q9

结论：不能宣布交付完成。项目硬规则要求面向 Agent 的业务能力在 DSH 原生工具与 MCP 两侧同步交付，共享 core 守卫与契约，并验证两侧实际注册、schema 和读写链路（项目 P 仓库 AGENTS.md §6；CONTRACT.md 双入口一致性）。MCP 上线且测试通过只覆盖一端；MCP 默认还是关闭的可选入口，DSH-only 使用者拿不到。要完成至少还需：DSH 原生工具注册与参数/错误语义对齐、同一 core 守卫、两侧读写回归与权限差异测试、契约和文档更新；涉及 UI 还要产品面验收。只在一侧通过测试就宣布完成，是把“能跑”当成“已交付”。

## Q10

结论：submit 做可追溯的完整性报告加少量记录完整性硬拦，不让 AI 自评，也不扩大拦截。DESIGN P4.2：agent 不得豁免证据漂移，submit/reconcile 遇内容漂移或完整性问题直接 409、零落盘、lease 保留；human 只在 verify 侧 refresh/waive，严格度属于项目所有者，放宽也要留记录（项目 P 仓库 docs/DESIGN.md P4.2）。具体：每次 submit 计算并落记录——每条 acceptance 是否有 active evidence、requiredKinds 是否满足、哪些是 command/test 自述、哪些不可观测；只对记录会失真的问题硬拦（ref/hash/路径不符、内容漂移、acceptance 无证据）；自述和不可观测作为 warnings 进 review，不冒充系统核验；严格度用 requiredKinds/requiresAudit 声明，可审计可回退；拒绝要给合法下一步，human verify 始终可用。

## Q11

结论：不要加；ADR 0067 已明确否掉同一提案：任务协议即使通过“可选参与”开关启用，也会改变 Agent、Router、Gate、Join、Human 的固有行为，应撤出通用实现（项目 A 仓库 docs/decisions/0067-generic-graph-and-node-contract-boundaries.md；docs/node-protocol.md 机制表）。默认关闭不等于无影响：它制造两类节点和未测试路径，并把凭据解释、关联键、接续保护重新塞进通用层，成为新的隐含契约。若 Router/Gate 需要任务版本，正确做法是任务节点用公开查询/输出把版本作为普通载荷给出；Router 用显式 rememberBy/defaults 路由，Gate 用显式 correlateBy 核对声明字段。业务核验由任务节点或承担该职责的 Agent 做，而不是通用节点理解任务协议。

## Q12

结论：TTL 过期不等于执行权立即丢失，要看宽限与活性。CONTRACT 规定：在 leaseTtl+leaseGrace 内、binding 未 detached、epoch 匹配、lastSeenAt 未超 TTL+grace，且未到绝对无进展期限 progressAt+(1+maxRenewalsWithoutProgress)*TTL 时，touch 可滑动续期；它不消费显式 renew 次数，也不重置进展，系统应保留该会话执行权，不写回收事件（项目 P 仓库 docs/CONTRACT.md“过期/恢复”段）。超过宽限、lastSeen 太旧或到达绝对期限，则成为可回收：sweep 写 lease/expired，并按有无 open intent 转 interrupted 或 ready；回收后旧 token/epoch 的 touch 不得复活，owner 只能用原 token 走 interrupt/reconcile（binding/epoch 未变时），否则请 human。

## Q13

结论：设 requiresAudit: true，或在 labels 里放 gate:audit；也可用 task.gate 只切这个开关。agent 只能开、不能关：非 review 状态可开，review 中不能通过字段或标签改门，关闭返回 forbidden-role；human 可开关（项目 P 仓库 docs/CONTRACT.md task.create/update/gate 段与 §2.6）。开启后 agent verify 必须是独立 agent 且带报告，human verify 始终可用；gated 任务的 cancel 也只能 human。所以“必须第三方审查”的门一旦由 agent 打开，agent 自己关不掉；这是有意的单向安全边界。agent 要降低严格度只能请 human 处理，且变更会留 task/meta-edited 记录。

## Q14

结论：文档状态与实现状态不一致。rfc-3-state-closure.md 首行仍写“状态：Proposed（人审前）”，但其 intent 结算与 task.interrupt 已进入现行契约和代码：CONTRACT.md §2.4.2 与 interrupt 段、lib/core/commands/task-gov.js、MCP 的 interrupt op 与测试都在（项目 P 仓库 docs/decisions/rfc-3-state-closure.md）。因此 task.interrupt 现在能用：in_progress → interrupted，保留 open intent，之后只能 reconcile。注意 RFC-3 明确不在本轮实现的部分仍未交付（§9 S4 租约活性约束、全量 I21 等）；别把“RFC 文件是 Proposed”当成“功能不可用”，也别把已实现当成 RFC 已人审通过。建议把文档状态改为 Implemented/部分实现并注明范围。

## Q15

结论：不能按任意历史时刻 asOf 查询任务状态。现行契约明确“传统历史读计划暂停，通用 asOf、/history 与旧分段阈值不作为此版交付条件”（项目 P 仓库 docs/CONTRACT.md §8.1 末）；代码与测试里也没有 asOf 实现。asof-out-of-range/bad-seq 只是保留的语义口径，不是已交付 API（同文件 §8.2）。现有能力是事件日志、按记录版本/修订的历史知识读取与检索：可以拿到某条任务/计划/文档的保存版本及其来源，但不提供整个项目在 T 时刻的投影，也不承诺时间旅行（docs/design/history-knowledge-read-model.md“版本与关联”）。若业务需要，只能另行设计 asOf 读模型，并明确外部副作用不可回滚。

## Q16

结论：是，已按 ADR 0067 拆出。2026-11-14 的整改把任务协议收回任务节点：类型与校验在 prototype/shared/nodes/task/，Agent/Router/Gate/Join/Human 不核验凭据、不并关联键、不做任务专用接续保护，task 只是普通载荷（项目 A 仓库 docs/decisions/0067-generic-graph-and-node-contract-boundaries.md accepted；docs/node-protocol.md“任务节点的职责”“整改落地”；测试里也写明 taskProtocol 已取消）。但文档自相矛盾：docs/status.md 顶部说整改完成，下面“已贯通的行为”仍写 Agent、Router、Gate、Join、Human 可显式采用协议，那是整改前的旧描述，不应作为现状依据。另有 shared/node-contract/protocols.ts 仍声明 Task 节点的公开信封，但通用驱动不读它。
