# 认知树 CI 流程

## 公开仓的检查

[Converge 公开仓](https://github.com/panchongyang/Converge) 的 [DSH release candidate](https://github.com/panchongyang/Converge/blob/main/.github/workflows/release-candidate.yml) 是候选件验证流程。提 PR 会触发，也可从 [Actions](https://github.com/panchongyang/Converge/actions) 手动触发（`workflow_dispatch`）；它不监听普通 push。以对应 PR 或运行记录的检查结果为准。

| 看到的步骤 | 检查内容 |
| --- | --- |
| Check candidate source boundary | 候选源码根目录不能有 `.converge/` 工作区认知数据。 |
| Install from lockfile / Type check / Test | Windows 运行器，按工作流固定的 Node 和 pnpm 版本从锁文件安装，执行工作区各包的类型检查和测试。 |
| Build plugin / Check offline loading | 构建 DSH 插件，离线验证服务端入口、工作线程与客户端加载协议。 |
| Pack candidate and record provenance | 核对包名、版本、许可和包内文件清单；把候选 `.tgz`、源码提交号和 SHA-256 上传为 `dsh-release-candidate` 工件。 |

CI 不发布 npm 包、不安装或重启 DSH。离线加载检查不等于真实 DSH 安装、模型交互或 UI 验收。

## 在本地复跑

先对照工作流使用相同的 Node 和 pnpm 版本（Node 24、pnpm 12 系列）。从仓库根目录在 PowerShell 逐条运行，任一步失败先修复再继续：

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
pnpm --dir cognition-tree install --frozen-lockfile
pnpm --dir cognition-tree -r --if-present run typecheck
pnpm --dir cognition-tree -r --if-present run test
pnpm --dir cognition-tree/adapters/dsh run build
node cognition-tree/adapters/dsh/scripts/check-package.mjs
```

这些命令复跑类型检查、测试、构建和离线加载，插件产物在当前工作树的 `.local-work/dsh-plugin/`。候选源码与打包清单检查以公开副本和 Actions 结果为准：内部开发树可保留正式认知数据，本地构建通过不代表该工作树可以直接公开。

## 本机：从 `dev` 打包、安装与回退

1. 在独立任务 worktree 完成修改并验证，获授权后提交并合入本地联调 `dev`。插件版本写在 [DSH 包清单](<../adapters/dsh/package.json>)；要替换已安装包，应使用不同版本号。确认 `dev` 工作树无其他未提交改动，从该工作树根目录复跑上面的命令。不要用任务分支或 GitHub 下载的源码给本机升级。
2. 打包联调构建的 `.local-work/dsh-plugin/`。新建一个以版本或提交命名的产物目录；保存 `.tgz`、`source-commit.txt` 和 `SHA256SUMS.txt`。不覆盖上一版包，它是回退来源。

   ```powershell
   # 在通过联调的 dev 工作树根目录运行
   $stage = (Resolve-Path '.local-work/dsh-plugin').Path
   $commit = git rev-parse HEAD
   $manifest = Get-Content (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
   $out = (New-Item -ItemType Directory -Path ".local-work/dsh-releases/$($manifest.version)-$($commit.Substring(0, 7))").FullName
   npm pack $stage --ignore-scripts --pack-destination $out
   if ($LASTEXITCODE -ne 0) { throw '插件打包失败' }
   $tgz = Get-Item (Join-Path $out "$($manifest.name)-$($manifest.version).tgz")
   $commit | Set-Content (Join-Path $out 'source-commit.txt')
   "$((Get-FileHash $tgz.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($tgz.Name)" |
     Set-Content (Join-Path $out 'SHA256SUMS.txt')
   ```

3. **安装前**，从本机 DSH 安装目录的 `node_modules/@deepseek-ai/dsh/package.json` 读取宿主版本，核对产物的 `engines.dsh`，不匹配就停止，不自动使用兼容豁免。在目标 profile 的 `package.json` 记录现有 `dsh-cognition-tree` 依赖及 profile 名，确认上一版包可用，再备份 profile 的 `package.json` 和 `pnpm-lock.yaml` 到受忽略的本地目录。建议先在隔离 profile 试装。生产安装沿用现有 bundle 启用状态，不改运行时、其他插件或认知数据。

   ```powershell
   # $DshRoot 指当前 DSH 安装目录；$tgz 指刚通过校验的 dev 产物
   $cli = Join-Path $DshRoot 'node_modules/@deepseek-ai/dsh/lib/bin.js'
   node $cli plugin --profile web add "file:$($tgz.FullName.Replace('\','/'))" --offline
   if ($LASTEXITCODE -ne 0) { throw '本机插件安装失败' }
   ```

4. 核对目标 profile 的依赖来源、锁文件以及安装目录中包和构建文件的版本及哈希。留好交接后，用本机 DSH 安装目录下的重启脚本（仅换插件，不换 DSH 主程序），然后刷新页面。当前会话可能因重启断开，不直接在会话中裸跑 `pm2`。

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DshRoot 'restart-with-env.ps1')
   ```

   若需回退，用同一离线安装命令指回上一版 `.tgz`，再按同样方式重启；不手工覆盖 `node_modules`。涉及数据格式变更的版本另验升级与回退，不能只降插件包。

## 公开仓：从独立 `main` 开 release PR

1. 本地开发仓的 `master` / `dev` 与 [GitHub 公开仓](https://github.com/panchongyang/Converge) 的 `main` 是独立历史。单独检出公开仓的最新 `main`，从它建 `release/<版本或主题>`；不把开发仓分支直接推过去。
2. 从已验的 `dev` 提交提取本次获准公开的文件差异，在公开 checkout 先检查再应用（可以使用 `git diff --binary <起点> <终点> -- <明确文件清单>` 和 `git apply --check --index`）。若有上下文冲突，只移植相关改动、保留公开仓设置。核对暂存文件与完整 diff：不得包含 `.converge/`、`.local-work/`、本机配置、凭据或未获准材料。保留公开仓的许可与候选包检查。
3. 在公开 checkout 复跑本地检查后提交并推送 release 分支，向保护的 `main` 开 PR。PR 说明本地验证、版本兼容与范围；以 [Actions](https://github.com/panchongyang/Converge/actions) 的 PR 检查结果为远端证据。候选件通过不等于批准合并或发 npm；这两步各自按授权执行。

检查项或触发条件有变化时同步更新工作流与本页。
