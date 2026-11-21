# 内核骨架与契约：设计稿

**性质：**待授权的设计提案。对应「内核骨架与契约」这项后续工作。它只把[内核接口单](<kernel-interfaces.md>)落成可编译的包与类型，不含业务规则；命令、查询、存储实现分别在后续任务里做。

## 一、目标

给后续实现一个**能编译、能测、边界清楚**的地基：

1. `cognition-tree/kernel/` 成为独立包，在只引入 ES 标准库的 TypeScript 配置下编译通过，不认识 React、DOM、Node、SQLite 或任何宿主。
2. 把接口单第 3.1–3.4 节里的领域类型、决定、错误码和两个端口（`TreeStore`、`Clock`）写成 `src/types`，作为全仓唯一的契约来源。
3. 建好 Vitest 基座：这一层能测得动的只有“类型与契约的不变量”，例如决定形状、错误码、端口签名、纯函数工具。

**不做：**命令与查询的实现（下一任务）、存储实现（再下一任务）、任何 UI 或适配层代码。

## 二、流程图

```text
适配层（后续任务） ──意图──▶ catalog ──▶ models ──▶ commands（校验语义）
                                      │                 │
                                      │                 └─▶ operations（结构原语）
                                      │                          │
                                      └──────── transact ────────┴─▶ TreeStore（端口，本任务只定类型）
读：queries（后续任务） ──▶ openRead ──▶ ReadSnapshot（端口，本任务只定类型）
时间：commands 取一次 Clock.now()，同笔记录共享
```

本任务只交付图里两个端口的**类型**，以及所有节点、引用、修订、决定、分页、错误的数据形状。

## 三、接口单

### 3.1 包与编译

| 项 | 内容 |
| --- | --- |
| 包 | `cognition-tree/kernel/`：`package.json`（私有、`type: module`、脚本 `typecheck` / `test`）、`vitest.config.ts` |
| `tsconfig.json` | 常规严格配置：`target ES2022`、`module ESNext`、`moduleResolution bundler`、`strict`、`noUnusedLocals`、`noUnusedParameters`、`noEmit` |
| `tsconfig.esonly.json` | 只许 ES 标准库的编译检查：`lib: ["ES2022"]`、`types: []`，`include` 只有 `src`；测试文件不在其中 |
| 依赖方向 | `kernel` 不依赖任何工作区包；`ui` 与 `adapters` 反向依赖它 |

### 3.2 类型清单（`src/types/`）

按接口单一一对应，命名沿用接口单。共享的底层类型各自成文件，`node`、`revision`、`decision`、`read` 只依赖它们，互不引用（同层无环）：

| 文件 | 内容 |
| --- | --- |
| `ids.ts` | `TreeId`、`NodeId`、`RefId`、`RevisionId` |
| `actor.ts` | `DailyActor`（`human` / `ai`）、`RevisionActor`（再加 `import`） |
| `node-status.ts` | `BranchState`、`Confirmation` |
| `origin.ts` | `Origin`：普通分支、补充、勘误，以及替代（`replacesId` 与 `proposed` / `applied`） |
| `node-body.ts` | `NodeBody` |
| `ref-target.ts` | `RefKind`、`RefTarget`（树内节点与外部材料二选一，用对侧 `?: never` 互斥） |
| `ref.ts` | `Ref` |
| `node.ts` | `CognitionNode`：`state?`、`confirmation?` 缺键表示手稿未载；`currentChange.by` 为 `DailyActor` |
| `revision.ts` | `EffectItem`、`FormationDetail`（按 `action` 五支判别）、`ConfirmationDetail`、`FormationRevision`、`ConfirmationRevision`、`ImportedRevision`、`Revision` |
| `decision.ts` | `Draft`、`Placement`、`Decision`（剪除、重新启用、留 ↔ 未决、执行替代）、`PendingTarget`、`PendingPage`、`Page<T>` |
| `confirm-target.ts` | `ConfirmTarget`：修订 ID 与导入节点 ID 二选一，互斥 |
| `read.ts` | `Depth`、`Expand`、`Budget`、`NodeRow`（不带正文的轻行）、`ViewNode`（轻行加 `role`）、`Boundary`（`scope` / `exhausted` / `budget`）、`TreeView` |
| `node-detail.ts` | `NodeDetail`：`currentChange` 只收形成记录 |
| `seed.ts` | `SeedNode`、`SeedHistoryEntry`、`SeedTree`（自举输入；节点沿用原 ID，历史不带内核分配的修订 ID） |
| `ports.ts` | `TreeStore`、`WriteTransaction`、`ReadSnapshot`（含 `rootId`、`readRevision`、轻行读取与未确认索引分页）、`Clock`；只有签名 |
| `errors.ts` | `ErrorCode`（`missing` / `invalid` / `storage` / `rangeTooLarge` / `viewExpired`）、`CognitionError` |
| `index.ts` | 统一转出；层外只用这一处 |

**不变量**（写进类型注释，测试只验能被静态或纯函数检查的部分）：

- 保存后的 `body` 不可覆盖；写入口只经有修订记录的操作。
- `confirmation` 只表示“当前变更是否由人确认”，与谁执行无关；没有日常变更的节点不带 `currentChange`。
- 手稿未载用**缺键**，不用 `null` 占位；`null` 只出现在 `EffectItem.beforeState`，表示原状态未载。
- 日常变更的执行者只能是人和 AI；`import` 只用于导入历史，以及在待确认列表里筛选导入判断。
- `FormationDetail.effects` 的第一项是被操作的节点；剪除必带理由与复活条件，执行替代必带新旧 ID，留 ↔ 未决必带目标状态与理由。
- `ConfirmTarget`、`PendingTarget`、`Placement`、`RefTarget` 都是二选一且互斥；`Page<T>` 的 `next` 只在还有下一页时给出。
- `Boundary` 三态显式标注，不用“没有标记”代替查尽；引用两端都必须在视图里，外部材料只返回定位符。
- 分页键编码与快照 `close` 的异步性留到实现时定，注释里已标明。

### 3.3 工具（`src/utils/`）

| 函数 | 作用 |
| --- | --- |
| `compareIds(a, b)` | 按段比较稳定 ID，供排序与分页 |
| `isNonBlank(text)` | 理由、复活条件的非空白校验 |
| `utf8ByteLength(text)` | 预算里的字节数计算 |
| `assertNever(value)` | 穷尽检查，防止漏掉决定种类 |

## 四、变化地图（到模块）

| 位置 | 内容 |
| --- | --- |
| `cognition-tree/kernel/package.json` | 新包：`type: module`、脚本 `typecheck`（两套 tsconfig）、`test`（vitest） |
| `cognition-tree/kernel/tsconfig.json`、`tsconfig.esonly.json` | 常规编译与“只许 ES 标准库”的检查 |
| `cognition-tree/kernel/src/types/` | 上表 17 个文件：叶子类型在下，`node`、`revision`、`decision`、`read` 互不引用 |
| `cognition-tree/kernel/src/utils/` | 上表四个纯函数 |
| `cognition-tree/kernel/src/config/` | 空目录占位不建；配置等有内容再加 |
| `cognition-tree/kernel/test/` | Vitest：纯函数；`Boundary` 三态、执行者分层、修订与决定的判别联合、二选一互斥的反例、缺键与 `null` 的区别、`SeedTree` 形状 |
| `pnpm-workspace.yaml` | 登记 `kernel` 包 |

**不改动：**`adapters/browser/**`、`docs/design/kernel-interfaces.md`、`docs/design/ux.md`、`docs/STRUCTURE.md` 与 PRINCIPLES。`STRUCTURE.md` 的“目标代码目录”已经写了 `kernel/src` 的分层，本任务照它落；若实现中需要改那份文档，先问人。

## 五、验收

| 使用效果 | 工程证据 |
| --- | --- |
| （本任务没有可直接使用的界面；它让后续任务能在“不认识宿主”的前提下编译和测试） | 在 `cognition-tree/kernel` 运行 `pnpm run typecheck`：`tsconfig.json` 与 `tsconfig.esonly.json` 都通过 |
| | `pnpm test`：Vitest 全部通过，覆盖纯函数、`Boundary` 三态、执行者分层、修订与决定的判别联合、二选一互斥、缺键与 `null` 的区别 |
| | 搜索核对：`kernel/src` 里没有 `react`、`document`、`window`、`node:`、`fs`、`sqlite` 等宿主符号；`types/index.ts` 之外没有各自的转出 |

**不能据此声称：**类型能编译不等于内核功能可用；本任务不产生任何可读写树的实现，也不改原型的运行时行为。
