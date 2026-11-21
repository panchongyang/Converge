# 文件结构与依赖方向

从入口追到树数据：在 `adapters/browser` 找独立网页，在 `adapters/dsh` 找宿主接线与工作区 SQLite；共享交互在 `ui/src`，唯一一份读写规则在 `kernel/src`。运行时路径见[总架构](<ARCHITECTURE.md>)，接线与隔离边界见[DSH 设计](<design/dsh-adapter.md>)。

![文件结构：浏览器和 DSH 各自负责环境接线，复用共享 UI 和业务内核](<diagrams/structure.svg>)

[独立看结构图](<diagrams/structure.svg>) · [图源](<diagrams/structure.mmd>)

## 现在阅读项目

```text
Converge/                             一个 Git 根，研究材料保留原位
├─ README.md                           接手顺序与研究导航
├─ 认知树.md                           手工 T1，含节点依据与原历史
├─ research/、experiments/、idea*.md   研究材料，不是运行时存储
└─ cognition-tree/                    产品工作区；pnpm-workspace.yaml 登记四个源码包
   ├─ README.md                       产品导航、启动与验证命令
   ├─ docs/                           人的决定、术语、架构、设计稿、插图
   ├─ scripts/                        从 docs/diagrams 的图源导出 SVG
   ├─ kernel/                         ES 标准库业务内核，测试在 test/
   ├─ ui/                             React 18 共享界面，不运行自己的树内核
   ├─ adapters/browser/               网页装配、开发坞、测试存储与样例
   └─ adapters/dsh/                   宿主工具与路由、SQLite 后端、面板与聊天卡
```

DSH 适配层在所属工作区的 `.converge/` 保存正式认知数据；浏览器 localStorage 只用于独立入口测试。`.local-work/` 是仓库内被忽略的工具缓存、构建产物与归档工作副本目录，不是正式源码或业务数据目录。

## 从职责找到功能

| 位置 | 持有什么；从哪里进 |
| --- | --- |
| `kernel/src/types`、`utils` | 节点、修订与读写端口的唯一类型来源；自然序、文本与字节等无副作用计算。 |
| `kernel/src/catalog` | 对外操作及具名参数；按可信 actor 分派，不持有树事实。 |
| `kernel/src/models`、`commands`、`operations` | 模型协调单树写入和新 ID；命令解释业务意图；原语构成明示的节点、引用与修订变化。 |
| `kernel/src/queries` | 按快照从 ID 或索引局部取数；树视图、分页与续读。查询不写树。 |
| `kernel/src/storage/memory` | 注入的 ES-only 存储实现；拥有已提交版本、索引与事务私有变更。不依赖浏览器，不决定哪个判断能确认。 |
| `ui/src/types`、`utils`、`styles` | 客户端与宿主桥端口、视图契约、显示计算和外观令牌。`types/kernel.ts` 是唯一内核类型桥。 |
| `ui/src/hooks`、`components` | 通用交互与 UI 原子件，不解释树的提交规则。 |
| `ui/src/models`、`modules`、`app` | 选中、展开、续读、草稿等页面状态；按空间视图、大纲、详情、时间线等能力组织模块；应用壳只组合，不判断宿主。 |
| `adapters/browser/src` | `main.tsx` 挂载应用；`adapter` 装配真实内核、人/AI 客户端、localStorage、模拟器、开发坞和出处阅读器；`fixtures` 把隔离样例译为 `SeedTree`。 |
| `adapters/dsh/src/server` | `host` 对接会话、工具与受认证路由，`backend` 在独立工作线程装配内核，`storage` 在工作区读写 SQLite。 |
| `adapters/dsh/src/client` | 注册宿主槽位，提供按根问题选树的工作区首页、新建树与返回列表导航，装配共享 UI 与同源客户端。`src/bootstrap` 的手稿翻译器只供兼容性测试，不参与 DSH 发布入口。 |

**层与模块是两条轴。** 剪除的业务校验在 `commands`，动作入口在 UI 的阅读栏模块；让一次提交持久化属于适配器。模块私有的类型或小组件留在模块里，有独立消费者再提升到共用层。不为未来可能的 `adapters/mcp` 建占位包。

## 不可倒置的边界

| 谁 | 可以认识 | 不可以认识或拥有 |
| --- | --- | --- |
| kernel | ES 标准库、内核自己的契约与层；运行时调用注入的端口 | adapters、DSH/MCP 包、Node/浏览器专有 API、React，也不拥有窗口或文件句柄 |
| ui | React 18、UI 端口和内部层；内核契约只取类型 | 具体宿主、直接 fetch 或宿主数据全局量；不做第二个树提交入口 |
| adapters | 各自环境与内核公开入口；有 UI 的入口可装配 ui | 跨宿主借内部实现；复制判断规则、从调用参数采信「人确认」 |
| 包内 | 上层经下层公开入口引用；同层无环。类型在下，状态与组装在上 | 纯操作回引模型、模型回引界面、跨层转发别人的 API 或绕开入口穿透实现 |

## 增改时怎么选位置

1. **先问改的是哪项事实。** 收起节点只改阅读状态；剪除节点改变正式判断，必须与形成记录一起提交；如何写入宿主则由适配器负责。
2. **再看最低消费者与签名。** 接收悬停或焦点的逻辑不是业务内核；接收只读行并返回推导链的计算也不因现在只有一个面板使用就归 React 组件。
3. **核对依赖方向。** 名字与粒度可以商量；不能借「便于复用」让内核依赖宿主，或让两份模型都成为树数据的权威。
4. **同步能读懂的地图。** 新增或移动边界时更新本页和对应图源，重导 SVG。不要为填满目录提前实现下一阶段。
