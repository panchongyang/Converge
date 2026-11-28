# DSH 认知树插件

这个适配器让 DSH 入口调用正式内核，把认知树保存在当前会话所属工作区的 `.converge/`。**独立网页不调用这个后端；已有浏览器测试数据不会自动迁移。** 插件源码、隔离构建与当前 DSH profile 是三个不同的东西。

## 使用 DSH 安装

在已安装 DSH 的机器上运行：

```bash
dsh plugin --profile web add dsh-cognition-tree
```

`web` 替换为你实际使用的 Web profile 名称。安装后按你的方式启动或重启该 profile，刷新页面，在侧栏打开「认知树」。无需克隆仓库、手改配置、构建源码或加入插件目录。[npm 0.4.9](https://www.npmjs.com/package/dsh-cognition-tree/v/0.4.9)声明兼容 DSH `0.2.2-rc.1`；其他 npm 版本以对应包的 `engines.dsh` 为准。插件需要 Node.js 24，并遵守 DSH 宿主自身的 Node 要求。

## 兼容性

| 插件版本 | DSH 版本 | 验证范围 |
| --- | --- | --- |
| `0.4.9`（已发布） | `0.2.2-rc.1` | Windows：隔离环境按 npm 包名安装并装配 |
| `0.4.10` | `0.2.2-rc.1`、`rc.2`、`rc.3`、`rc.4`、`rc.5` | Windows、Node.js `24.22.2`：逐版通过原生安装、Web 配置合成、真实 SDK 工具与路由、工作线程和持久化联测 |
| `0.4.14` | `0.2.2-rc.1` | Windows、Node.js `24.22.2`：隔离 SDK、工具与路由、真实 worker/SQLite，覆盖过程材料留存、跨会话点读和正式读面隔离 |

[包声明](package.json)沿用 `0.2.2-rc.1` 至 `rc.5` 的兼容范围，不自动包含后续 RC 或正式版。上表区分各版实测范围，不代表浏览器交互、真实模型调用或其他操作系统已验证。

## 从源码构建与验证（不安装）

使用 Node 自带的 `node:sqlite`，不需要额外的数据库服务。请先按[从源码运行](<../../../README.md#从源码运行>)安装 workspace 依赖，再在 `cognition-tree/` 目录运行：

```powershell
pnpm --dir adapters/dsh run typecheck
pnpm --dir adapters/dsh test                 # 存储端口、工作区建树、宿主权限与客户端协议
pnpm --dir adapters/dsh run build            # 生成仓库根的 .local-work/dsh-plugin，不改 profile
node adapters/dsh/scripts/check-package.mjs # 检查打包后的入口以及宿主加载器协议
```

可选的真实 SDK 隔离检查需要显式提供已有 DSH 安装根（包含 `node_modules/`）。从 `cognition-tree/` 运行 `node adapters/dsh/scripts/check-host.mjs --sdk-root "<DSH 安装根>"` 检查宿主回归，运行 `node adapters/dsh/scripts/check-autonomy.mjs "<DSH 安装根>"` 验证随包技能、同工作区会话隔离及同会话多树写入。单测中的 SDK 专项使用 `DSH_SDK_TEST_ROOT`，未设置时明确跳过，不代替核心测试。

从仓库根 `.local-work/dsh-plugin/` 可以查看完整待安装包：服务端入口、数据库工作线程、客户端模块、manifest 和 Cordis patch。`scripts/` 的检查不需要正在使用的 DSH 登录令牌，不访问它的 3080 服务，也不把认知数据写到真实工作区。

[本机隔离实测记录](<../../docs/evidence/dsh-isolated-2026-11-20.md>)列出了实库大小、重开结果、宿主影响样本，以及哪些部分使用了替身。

## 用起来是什么样

从绑定目标工作区的 DSH 会话打开侧栏「认知树」：这个会话看过树，就直接回到上次打开的那棵树；没有记录，或人显式回到过「← 全部树」，则显示**全部树**目录。这条记录只存在本机浏览器、按会话区分，不写服务端。目录每行显示一棵树的根问题和树 ID，点击根问题进入三栏阅读视图，左上角「← 全部树」返回列表并清掉这条记录。列表是导航，不是树上的一个“总根”。同工作区的其他会话创建了树，也能在这里找到，不必记 ID。

要新建，点列表页的「新建树」，填写未使用的树 ID（例如 `project-decisions`）和根问题（例如「本项目做过哪些重要取舍？」）。新树只有一个未确认的根，其 ID 同树 ID。AI 也可以使用 `cognition_tree_create_tree` 建树。

同名创建不会覆盖数据。创建者和根问题一起记入该树的形成记录；人创建也不自动确认。DSH 不提供手稿导入，无论在哪个工作区，也不会把 Converge 的项目内容带入新树。已有的 T1 及其历史照常可读写。

AI 工具的新增、剪除等变更保存即生效，但未获人确认。只读会话不能借插件写数据库；受限可写会话只能改获准工作区之内的树。聊天卡只负责定位判断；从阅读栏明确确认后才新增人确认记录。没有授予 AI 确认或导入权限。写入如果报告连接中断且结果未知，请先重新读取，不要自动重试。

## 归档与 SQLite 版本

通过 DSH 的 owner 身份登录后，可在当前工作区的「全部树」归档整树，在判断的检查栏归档分支；从相应的「归档」列表恢复。归档会从日常读取隐藏树或分支及相关引用，不删除原有判断与修订。恢复上层不会解除下层独立的归档标记。归档与恢复只在认证人侧界面提供，不是 AI 工具。

**升级提示：** 此版新建树使用 SQLite v2。已有 v1 树的普通读写不迁移；首次成功归档整树或分支时，归档标记和格式升级在同一事务中提交，失败不迁移。**0.4.14 无法打开 v2 库，新建或已升级的 v2 库不能直接降回 0.4.14 使用。** 如需保留退回旧版的选项，请先关闭数据库并备份完整数据。

## 增量形式化

对话中的自主选树与维护默认关闭。要启用，在对应 DSH profile 的 Cordis 配置中设置 `cognition-tree` 插件项的 `config.autonomousWorkspaces`：

```yaml
- id: cognition-tree
  config:
    autonomousWorkspaces:
      - 'D:\path\to\registered-workspace'
```

默认是空列表。每项填写 DSH 已注册工作区根目录的绝对路径，按解析后的注册根精确匹配。会话在子目录中启动，只有当 DSH 将该会话解析为同一个已启用的注册根时才启用；这项配置不会为任意子目录或独立注册的子工作区递归授权。该功能需要宿主提供 skills 能力，配置生效后可在新会话中使用。

启用的会话可看到随包的 [cognition-tree-autonomy skill](<skills/cognition-tree-autonomy/SKILL.md>)。AI 在普通对话回合按需用 `cognition_tree_list_trees({limit?, after?})` 分页找候选，取得目录中的 `treeId` 和 `rootQuestion`。成功用 `cognition_tree_read_view` 读到已有树，或成功用 `cognition_tree_create_tree` 建树后，会话可加载 [incremental-formalization skill](<skills/incremental-formalization/SKILL.md>)。两个 skill 由插件按会话提供，不需要全局或工作区 `.dsh/skills/` 副本。

一个会话可以先维护 `project-decisions`，再维护 `release-decisions`；每次读、写或处理过程材料都显式传入对应的 `treeId`。无按树分配的 skill 槽位，也不按标题或面板猜树。插件不监听对话、不在后台代写；启用或加载 skill 不授予写权限，只读会话不建树、不留档、不写树。

AI 可用 `cognition_tree_process` 在已有树下另存一段不成形的文本（最大 16 KiB UTF-8），或按 `treeId` + `processId` 点读。材料保存在 `.converge/process/`，独立于 SQLite；正常树查询、历史、通知里都不出现，不需要迁移树库。没有列表、回放或改旧材料的入口。知道 ID 的同工作区会话可读，把 ID 留在需要续接的上下文中；材料不是私密会话存储。

续接时参考这段材料、重读当前树，再按当前判断另写 `add_branch` 或 `decide_node`。新写入可带刚读到的 `expectedStamp`；变更发生后旧版本被拒绝，须重新读取和判断。没有变基或自动补交，既有工具不传该字段时行为不变。

## 边界

- 工作区 T1 保存为 `.converge/T1.sqlite`。树 ID 用可移植的文件名：1–64 位 ASCII 字母、数字、下划线或连字符，首位为字母或数字；拒绝 Windows 保留设备名。判断标题和正文不受此命名限制。SQLite 的 WAL/SHM 辅助文件不是额外的业务日志。不要在数据库仍打开时只复制主文件当作完整备份。
- SQLite 操作放在插件自己的工作线程中。宿主只转发当前插件的请求、通知，不接管其他工具或路由。见[接入设计](<../../docs/design/dsh-adapter.md>)。
- 独立网页的模拟器和开发坞不出现在 DSH 面板。安装真实插件、改 profile、重启、真实面板的视觉/交互走查是另一个明确步骤；不能用离线打包或隔离测试宣称已经上线。
