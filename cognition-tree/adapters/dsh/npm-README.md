# Converge · 认知树 DSH 插件

把人和 AI 协作形成的判断、依据与取舍保存在认知树中，供新会话接着使用。AI 可以提出判断，但不能替人确认。认知树保存在所选工作区的 `.converge/`，不会迁移浏览器样例数据。

## 安装

需要已安装的 DeepSeek Harness（DSH）和 Node.js 24，且满足对应 DSH 版本的 Node 要求。请查看本 npm 版本的 `engines.dsh` 和[支持范围](https://github.com/panchongyang/Converge/blob/main/cognition-tree/adapters/dsh/README.md)。

```bash
dsh plugin --profile web add dsh-cognition-tree
```

将 `web` 换成你的 Web profile。安装后启动或重启该 profile，刷新 DSH 网页，在侧栏打开「认知树」。无需克隆源码、构建或加入 DSH 插件目录。可在包名后追加 `@版本` 固定版本。

首次体验建议在空工作区建一棵树，让 AI 加一条判断，再由你明确确认。卸载插件不等于删除工作区数据。更多操作和边界见[插件说明](https://github.com/panchongyang/Converge/blob/main/cognition-tree/adapters/dsh/README.md)。

## 归档与数据库升级

通过 DSH 的 owner 身份登录后，可在认知树界面归档或恢复当前工作区的树和分支；归档默认隐藏相应内容，不删除数据，也不向 AI 提供归档工具。

**SQLite v2：** 此版新建树使用 v2。已有 v1 树的普通读写不迁移，首次成功归档整树或分支时才原子升级至 v2。**0.4.14 无法打开 v2 数据库，包括新建或已升级的库。** 如需保留退回旧版的选项，请在首次归档前关闭数据库并保留完整备份。

## 在对话中增量记录

自主选树与维护默认关闭。需要支持 skills 的 DSH 宿主；在对应 profile 的 Cordis 配置中为 `cognition-tree` 插件项设置：

```yaml
- id: cognition-tree
  config:
    autonomousWorkspaces:
      - 'D:\path\to\registered-workspace'
```

`autonomousWorkspaces` 默认是空列表。只匹配已注册工作区的绝对根路径；子目录中的会话须被 DSH 解析为同一个已启用的注册根。

启用的会话可看到随包的 `cognition-tree-autonomy` skill。AI 成功读到已有树（`cognition_tree_read_view`）或成功创建树（`cognition_tree_create_tree`）后，可加载随包的 `incremental-formalization` skill。无需把文本复制到全局或工作区 `.dsh/skills/`。同一会话可以维护多棵树，每次读写和过程操作都显式传入对应的 `treeId`，不可按标题猜 ID。启用不授予写权限；只读会话不能创建树、保存材料或写树。插件不监听会话或在后台代写。

未入树的过程只可按保存时返回的树 ID 和材料 ID 点读；续接根据当前树另写，旧过程不会自动补交。

[源码与完整研究](https://github.com/panchongyang/Converge) · [反馈问题](https://github.com/panchongyang/Converge/issues) · [BSD-3-Clause](https://github.com/panchongyang/Converge/blob/main/LICENSE)
