# DSH 接入：工作区树在哪里，谁能写它

## 目标

让当前 DSH 会话里的人和 AI 维护**同一份工作区树**。关掉插件、重开工作区，已提交的判断和历史仍可读；事务失败不能把状态与日志拆成两半。每树一个 SQLite 主库，浏览器独立入口仍是隔离测试存储，不自动迁移或覆盖任何已有数据。源码与隔离验证属于本阶段；安装到正在使用的 DSH、真实 profile 变更和重启另行授权。

## 流程

```text
人点击阅读栏 / 聊天卡 → 同源、已认证的宿主 UI 路由 ┐
AI 选择本插件的工具 → 工具执行上下文            ├→ 按受信会话找工作区，绑定 human 或 ai
                                               └→ 工作线程 → catalog → 内核 → 单树 SQLite 事务
                                                                                      ↓
界面读回最新事实 ← 该工作区的提交通知 ← 事务提交成功；失败回滚、不发成功通知
```

打开卡片、展开节点、连接通知流不等于人确认。人必须在共享 UI 看见明确目标并点击确认；AI 只能读或做留下历史的日常变更。

## 接口单

| 入口 | 输入、输出及作用 | 不变量和调用方 |
| --- | --- | --- |
| `SqliteTreeStore(workspaceRoot, onCommit?)` | 根目录来自宿主；`openRead(treeId)` 固定已提交快照，`transact(treeId, mode, work)` 把变更与修订放在一个事务。提交后可通知 `{treeId,stamp,revisions}`。 | 遵循[内核端口](<../../kernel/src/types/ports.ts>)，身份及业务语义仍由 catalog 与模型负责。写者与读快照独立，节点、引用、修订及未确认索引都在本树主库。关闭时释放句柄。 |
| `POST /api/cognition-tree/call` | 人侧客户端提交 `{sessionId,op,input}`，成功 `{ok:true,value}`，失败 `{ok:false,error:{code,message}}`。op/input 采用[操作契约](<../../kernel/src/catalog/contracts.ts>)。 | 只经宿主已认证的 owner 路由；sessionId 是定位符而不是调用者的文件访问授权。不从载荷取 cwd、actor 或用户身份。 |
| `GET /api/cognition-tree/watch?sessionId=…` | SSE 建连事件 `ready` 与提交事件 `change`；UI 只订阅当前会话、当前树。 | 只在已提交后提示 UI 重读；断线不承诺补发历史。界面卸载/会话切换要解绑。 |
| `cognition_tree_*` 工具 | 三个写意图 `create_tree`、`add_branch`、`decide_node`，三个读意图 `read_view`、`read_history`、`read_unconfirmed`。节点正文只通过 `read_view` 的详情模式交给 AI；人侧详情栏通过认证 `/call` 点查。写卡可带树和节点定位符。 | 工具固定 `ai`，工作区来自实际执行会话。写入沿用宿主文件策略：只读拒写，workspace-write 不能写到获准根目录之外，不开放提权参数。没有“人确认工具”、任意 SQL 或通用 patch。 |
| `GET /api/cognition-tree/trees?sessionId=…` | 默认首页与返回列表时，通过受信会话获取工作区目录。每个可读项只有 `rootQuestion`、`treeId`、`rootId`；不能读取的候选单列，不把部分结果误报为“没有树”。 | 仅提供给宿主已认证的人侧 UI。工作线程只从当前工作区的正式库定位真实根，不建立跨库索引、不迁移或写入任何判断；不是 AI 工具或领域变更。 |
| 列表选树与「新建树」 | `createTree({treeId,rootQuestion})` 以人侧身份建树；AI 工具也可用同一意图建树。完成后可从根阅读，聊天卡的 `initialNodeId?` 只指定阅读位置。 | 每次建树只有一个未确认的根，ID 与树 ID 相同，形成记录保留创建者。同名拒绝而非打开或覆盖。打开已有树是只读操作；人侧和工具均不提供手稿导入。 |

AI 的 `cognition_tree_read_view` 只在整项省略 `budget` 时使用默认：400 次扫描、24 个节点、4000 UTF-8 字节。显式传入须完整给出三个正安全整数。人侧 `/call` 和内核仍必须收到明确的三项预算；`focus`、`expand`、`onLimit` 没有 AI 默认。视图边界和超限反馈遵循[内核读取契约 §3.2](<kernel-interfaces.md>)。

`read_view` 可用 `includeDetails: true` 随页批量读取正文；详情页直接交付 JSON。需要从轻量页聚焦某个节点时，按工具说明将它的短写拼成真实 ID，作为新查询的 `focus`。轻量页默认用 `CTV2`：缩进表示真实父链，每页独立可读；超过 128 节点或 256 条引用时使用 JSON。worker 与宿主之间以及人侧 `/call` 使用规范 JSON，AI 的 `maxBytes` 按实际交付给模型的正文计费。

## 变化地图

| 目录 | 职责与隔离 |
| --- | --- |
| `adapters/dsh/src/server/host` | 宿主 ABI、注册与解绑、会话到工作区、可信工具与路由。插件只注册自己的名字和路径。 |
| `adapters/dsh/src/server/backend` | 主线程只接消息，首次业务请求才启动 worker。工作线程按工作区装配既有内核；出错只拒绝对应请求，不自动重发写操作。 |
| `adapters/dsh/src/server/storage` | 使用 Node 自带 SQLite 驱动，在工作区 `.converge/` 内维护树；处理事务、索引和快照，不解释剪除、替代或确认。 |
| `adapters/dsh/src/client` | DSH 槽位、建树/切换、通知翻译和宿主外观隔离。独立网页、DSH 使用同一套 `ui/src`；共享快捷键在各自的渲染根监听。 |
| `adapters/dsh/scripts`、`test` | 构建出可供 DSH 加载的插件包；隔离实测只在仓库根 `.local-work/` 创建数据库与构建产物。 |

## 验收

[本机验证记录](<../evidence/dsh-isolated-2026-11-20.md>)区分磁盘实测、宿主 SDK 装配和真实上线。

- **数据**：在隔离工作区建 T1，执行一个 AI 变更；关闭连接和工作线程后，从同一目录重开，按稳定 ID 读回正文、当前变更和历史。另一个目录同名 T1 不应读到它。提交中途失败，版本、标记、记录都不动。
- **宿主**：核对只注册插件自己的工具、owner 路由与槽；无关操作不启动数据库，重查询不在 DSH 主线程做。区分 SQL 实库、真实 SDK 的隔离装配、服务替身与正在使用的 DSH。不把本机观测写成零延迟保证。
- **人的使用效果**：从侧栏先看全部根问题，选中一行才进入该树；在列表页创建，从树内返回列表，或从聊天卡直接定位判断。独立网页截图或单纯返回 200 均不能代替这项验收。
