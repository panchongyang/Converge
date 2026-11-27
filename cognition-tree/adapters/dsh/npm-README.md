# Converge · 认知树 DSH 插件

把人和 AI 协作形成的判断、依据与取舍保存在认知树中，供新会话接着使用。AI 可以提出判断，但不能替人确认。认知树保存在所选工作区的 `.converge/`，不会迁移浏览器样例数据。

## 安装

需要已安装的 DeepSeek Harness（DSH）和 Node.js 24，且满足对应 DSH 版本的 Node 要求。请查看本 npm 版本的 `engines.dsh` 和[支持范围](https://github.com/panchongyang/Converge/blob/main/cognition-tree/adapters/dsh/README.md)。

```bash
dsh plugin --profile web add dsh-cognition-tree
```

将 `web` 换成你的 Web profile。安装后启动或重启该 profile，刷新 DSH 网页，在侧栏打开「认知树」。无需克隆源码、构建或加入 DSH 插件目录。可在包名后追加 `@版本` 固定版本。

首次体验建议在空工作区建一棵树，让 AI 加一条判断，再由你明确确认。卸载插件不等于删除工作区数据。更多操作和边界见[插件说明](https://github.com/panchongyang/Converge/blob/main/cognition-tree/adapters/dsh/README.md)。

## 在对话中增量记录

发布包附有 `skills/incremental-formalization/SKILL.md`。要启用工作区 skill，把该目录加入工作区的 `.dsh/skills/`，在此工作区会话明确选定认知树并加载 `incremental-formalization`。插件不自动修改 skill 配置或监听会话。未入树的过程只可按保存时返回的树 ID 和材料 ID 点读；续接根据当前树另写，旧过程不会自动补交。

[源码与完整研究](https://github.com/panchongyang/Converge) · [反馈问题](https://github.com/panchongyang/Converge/issues) · [BSD-3-Clause](https://github.com/panchongyang/Converge/blob/main/LICENSE)
