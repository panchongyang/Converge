# 认知树 MVP

让人和 AI 能在下一次会话中追问一个判断：**为什么这样定，为什么排除另一条路，还有什么没有定？** 树保存判断和依据，不保存逐句聊天。独立网页把共享 UI 接到正式内核，使用隔离的浏览器测试存储。DSH 插件和工作区正式存储不在这个入口里。

| 你想做什么 | 从这里进 |
| --- | --- |
| 看产品边界、一次提议怎样到达确认 | [总架构与前后端图](<docs/ARCHITECTURE.md>) |
| 理解变更、确认、参数化树视图和单树存储 | [内核接口单](<docs/design/kernel-interfaces.md>) · [实现设计与运行边界](<docs/design/implementation.md>) |
| 找能把树写进工作区的 DSH 插件 | [接入与权限设计](<docs/design/dsh-adapter.md>) · [构建与隔离验证](<adapters/dsh/README.md>) |
| 看视觉与交互设计、使用网页 | [UX 原型设计稿](<docs/design/ux.md>) · 启动见下文[独立浏览器](#独立浏览器) |
| 找代码职责或判断新文件该放哪 | [文件结构图与放置判据](<docs/STRUCTURE.md>) |
| 区分哪些是人拍板、哪些不能由 AI 推定 | [人的决定](<docs/PRINCIPLES.md>) · [待决问题](<docs/open-questions.md>) · [术语](<docs/glossary.md>) |
| 用真实的阅读例子对照设计 | [手工自举的 T1](<../认知树.md>)（可从 T1.3.1“纯树为什么被剪”开始） |

**直接看图，无需装工具：** [总图](<docs/diagrams/overall.svg>) · [后端](<docs/diagrams/backend.svg>) · [前端](<docs/diagrams/frontend.svg>) · [文件结构](<docs/diagrams/structure.svg>)。总图区分独立网页和 DSH 插件两条路径；构建出插件不等于已在当前 DSH profile 启用。

## 阅读与开发

从仓库根目录进入 `cognition-tree/`。先读[设计决定](<docs/PRINCIPLES.md>)和[文件结构](<docs/STRUCTURE.md>)；构建与测试不依赖内部项目看板。安装插件到自己的 DSH profile 与源码验包是不同操作。

原研究材料保持原位。[认知表达结构](<../认知表达结构.md>)记录了候选结构的推导；其中提议的**当前确认程度**以[自举树的节点与形成记录 #8](<../认知树.md>)为准。设计确认不是有效性实验证据。

## 独立浏览器

在[浏览器入口](<adapters/browser/>)点「导入样例 T1」，再用查找定位 T1.3.1，查看纯树为什么被剪。要试写入，用开发坞模拟 AI 添加一条补充，打开新增判断后再明确确认。剪除、重新启用和确认是不同操作；失败注入可检查未提交的变更是否保持原样。刷新页面会从本浏览器的 localStorage 重开，**不读写工作区的正式树**。样例来自手稿，不是 Q4 正式导入。

在 `cognition-tree` 下按下文命令装好工作区依赖后：

```powershell
# 从仓库根目录进入产品工作区
Set-Location -LiteralPath 'cognition-tree'
pnpm --dir adapters/browser dev             # http://127.0.0.1:5317
pnpm --dir kernel run typecheck             # 严格类型与只许 ES2022 的编译检查
pnpm --dir kernel test                      # 事务、命令、查询、权限与负载
pnpm --dir ui run typecheck                 # 共享界面独立编译
pnpm --dir ui test                          # 投影合并与交互状态的纯逻辑，不跑浏览器
pnpm --dir adapters/browser run typecheck
pnpm --dir adapters/browser test            # 宿主边界：组装、重开与失败
pnpm --dir adapters/browser run build       # 产物：仓库根 .local-work/browser-dist
```

[UX 原型设计稿](<docs/design/ux.md>)保留视觉与操作位置的设计依据；实际的写入和确认语义以[内核接口单](<docs/design/kernel-interfaces.md>)为准。

## 重绘插图

不需要构建就能打开仓库里的 SVG。要更新图，在 `docs/diagrams/` 编辑 `.mmd`，用 Node.js 24、pnpm 12 和本机 Chrome 批量导出。已安装依赖时只需最后一条命令。

```powershell
# 从仓库根目录进入产品工作区
Set-Location -LiteralPath 'cognition-tree'
# 首次装制图依赖：锁文件固定版本，缓存和临时目录留在仓库内。
$work = [System.IO.Path]::GetFullPath((Join-Path $PWD '../.local-work'))
$env:TEMP = $env:TMP = (New-Item -ItemType Directory -Force (Join-Path $work 'temp')).FullName
$env:npm_config_cache = Join-Path $work 'npm-cache'
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
pnpm install --frozen-lockfile --store-dir (Join-Path $work 'pnpm-store')
if ($LASTEXITCODE -ne 0) { throw '制图依赖安装失败' }
pnpm run diagrams
```

若 Chrome 不在默认位置，用 `CHROME_PATH` 指向已有的可执行文件。绘图不启动 DSH 或下载 Chromium；Vitest 用例、产品 UI 与真实 DSH 接入都不属于制图命令。
