# 实现阶段：从内存端口到浏览器入口

## 目标

在同一页内用正式内核跑通「导入样例 → 追问判断 → 人或 AI 改变树 → 人按需确认」。沿用[内核接口单](<kernel-interfaces.md>)的事实模型和[UX 设计](<ux.md>)的阅读方式、原地书写及两套外观。不决定 Q5，不把网页样例写进工作区，不做 DSH、SQLite 或 MCP。下列落点是本阶段的工程设计，不是新增产品决定。

## 流程

```text
阅读栏 / 开发坞 → 浏览器分别绑定 human / ai → catalog.dispatch
  写 → models → commands + operations → TreeStore.transact(work)
       → 形成或确认与相关行一起提交 → 浏览器存储成功 → 切换内存版本 → UI 读回
  读 → queries → openRead → 当前版本的 ID / 关系 / 时间 / 未确认索引 → 轻行视图或详情
       → 超出预算时精确失败，或返回可续的连通树；不把两次提交的投影拼成同一页
```

## 接口单

| 调用点 | 输入、缺省与结果 | 由谁守住边界 |
| --- | --- | --- |
| 测试与浏览器装配 → `MemoryTreeStore` | `openRead(treeId)` 取得固定版本；`transact(treeId, existing / createNew, work)` 返回 work 的结果。浏览器可注入 `beforeCommit(treeId, mode, delta)` 持久化本次节点、引用、修订；缺省只保存在内存。 | 单树写排队。work 抛错或持久化失败不发布新版本；快照的读取不允许修改存储行。存储维护索引，不解释剪除或确认。 |
| 适配器 → `createKernel({store,clock}).dispatch(actor,op,input)` | 端口由装配注入，无默认宿主。日常写返回节点 ID，确认返回修订 ID，自举返回树 ID。读操作返回视图、详情或页。字段和分页键见[操作输入输出](<../../kernel/src/catalog/contracts.ts>)。 | 入口固定 actor；catalog 在读写前限制操作。只有模型开启写事务，命令校验新变更，确认绑定明确目标。 |
| 查询 → `ReadSnapshot` | 时间线按 `(at, revisionId)`；待确认先按执行者索引取仍有效的形成记录，再按 ID 取导入判断。视图的深度、跳数、方向、起跳范围、预算均显式提供；不传游标开启新读。 | 只按键读所需行，祖先、空查和探测也计扫描；结果保留原父链与引用方向。过期游标明确失败。 |
| 应用壳 → `CognitionClient` / `HostBridge` | 人明确发起导入和确认。写成功后给 UI 的刷新通知只提示读回；不把通知当作事实。外部出处导航可缺省。 | UI 的可变状态限于选中、投影、展开、草稿等；浏览器装配 AI 模拟输入与测试存储，不发送伪造确认。 |

## 变化地图

| 目录 | 改动及边界 |
| --- | --- |
| `kernel/src/storage/memory` | ES 标准库内的单树版本、事务与索引；供两个实际消费者（测试、独立网页）共用。没有宿主 I/O。 |
| `kernel/src/operations, commands, models, catalog` | 原语、业务约束、唯一写入协调者、入口角色与分派；领域类型仍在 `types`。 |
| `kernel/src/queries` | 有界局部树和续读状态、按 ID 的详情、按索引的分页。 |
| `ui/src` | 共享界面从浏览器包独立出来。仅类型桥接触内核；用户看到的是已提交变更，确认与执行分别操作。 |
| `adapters/browser` | 页面与本地 client、存储、样例、出处阅读器和开发坞。替身内核不在运行时或发布目录里，工作副本保存在 `.local-work/retired/`。 |

## 验收

人从 T1.3.1 查回剪除依据，模拟一次 AI 变更，在详情确认指定记录，再剪除、重新启用并重开页面。失败注入后树和时间线应保持原样，草稿应还在。布局、动画、交互感受以人实际操作为准。

工程证据分别来自内核事务/命令/查询 Vitest、浏览器边界和同存储重开用例、ES-only 与应用编译、网页构建和本机 HTTP 入口。不把内存负载测试当作 SQLite 性能，不以 HTTP 200 代替交互验收。
