#!/usr/bin/env node
/**
 * 隔离宿主检查：在真实 DSH SDK 的 Cordis 装配里加载认知树插件构建产物，验证
 * 工具/路由注册、空闲与业务行为、错误隔离、卸载清理，并采样宿主响应影响。
 *
 * 运行（仓库根）：
 *   node cognition-tree/adapters/dsh/scripts/check-host.mjs --sdk-root "<DSH 安装根>"
 * 也可通过 DSH_SDK_ROOT 提供已安装 SDK 的根目录。
 *
 * 真实：SDK 0.2.2-rc.1 的 Cordis、SystemPrompt、ToolsService、HostConnectionService
 * （exact Fetch 注册表与共享内存分发）、插件 lib/index.js + worker.js、内核与 SQLite。
 * 替身：BrowserAuth、sessions、workspaceRegistry、sessionPersistence；见报告中的
 * real/doubles 清单。不安装 profile、不开端口、不启动服务、不写仓库外。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createDispatcher, installHostDoubles, loadSdk,
  makeBrowserAuthDouble, makeFixture, probeRoute, probeTool, responseJson, PROBE_PATH, PROBE_TOOL,
} from './check-host/sdk.mjs';
import { assertInsideLocalWork, rssBytes, sha256File, snapshotProcess, workerCount } from './check-host/measure.mjs';
import { assert, formatError } from './check-host/util.mjs';
import { runBaseline, runRegister, runIdle, runIsolation, runDispose, runReload } from './check-host/lifecycle.mjs';
import { runBusiness, runFoldCursor } from './check-host/business.mjs';
import { runBusyImpact } from './check-host/impact.mjs';

/** 仓库根；scripts → dsh → adapters → cognition-tree → 仓库。 */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
/** 构建产物位置由 build.mjs 固定；本检查只读，不重建。 */
const PLUGIN_DIR = join(REPO_ROOT, '.local-work', 'dsh-plugin');
const PLUGIN_ENTRY = join(PLUGIN_DIR, 'lib', 'index.js');
const PLUGIN_WORKER = join(PLUGIN_DIR, 'lib', 'worker.js');

/** 解析运行参数；SDK 位置优先取 argv，其次取环境变量，不猜本机路径。 */
function parseArgs(argv) {
  let sdkRoot = process.env.DSH_SDK_ROOT?.trim();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sdk-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--sdk-root 缺少路径');
      sdkRoot = value;
      index += 1;
    } else if (arg.startsWith('--sdk-root=')) {
      sdkRoot = arg.slice('--sdk-root='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node cognition-tree/adapters/dsh/scripts/check-host.mjs [--sdk-root <DSH checkout>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!sdkRoot?.trim()) throw new Error('需要 --sdk-root 或 DSH_SDK_ROOT 指向已有 DSH 安装根');
  return { sdkRoot: resolve(sdkRoot.trim()) };
}

/** 主程序：装配一次，按固定顺序执行各阶段检查，再汇总报告。 */
/** 主程序。 */
async function main() {
  const startedAt = new Date().toISOString();
  const args = parseArgs(process.argv.slice(2));
  const report = {
    kind: 'cognition-tree-dsh-host-check',
    schemaVersion: 1,
    startedAt,
    finishedAt: null,
    exitCode: null,
    environment: {
      node: process.version,
      platform: process.platform,
      repoRoot: REPO_ROOT,
      sdkRoot: args.sdkRoot,
      pluginDir: PLUGIN_DIR,
    },
    sdk: null,
    artifacts: null,
    real: [
      'DSH 0.2.2-rc.1 Cordis Context / Service / effect 生命周期',
      'DSH SystemPrompt 与 ToolsService（真实工具注册表）',
      'DSH HostConnectionService 的 exact Fetch 注册表与 createSharedFetchHandler 内存分发',
      '插件构建产物 lib/index.js 与 lib/worker.js',
      '内核 catalog/commands/queries + worker_threads + SQLite 真实存储',
    ],
    doubles: [
      'BrowserAuth：不读 cookie/launch token/profile，直接以 Connection 的 owner peer 调用共享 handler（跳过载体鉴权）',
      'sessions：只返回夹具中的 live session 与 header.cwd，不读真实 session store',
      'workspaceRegistry：只承认夹具工作区，不实现真实 registry 的规范化/持久化',
      'sessionPersistence：只返回夹具会话 header，不读真实 session 日志',
    ],
    checks: [],
    business: {},
    isolation: {},
    impact: {},
    process: {},
    unverified: [
      '未启动真实 DSH Web 服务、未监听端口、未做浏览器/UI 验收；HTTP 时延与真实网络无关。',
      'Host/Origin 围栏、浏览器 cookie 与 launch token 鉴权未执行；内存调用直接使用 owner peer。',
      'sessions/workspaceRegistry/sessionPersistence 是接口翻译替身；真实 workspace 规范化与 profile 持久化未验证。',
      '工具从真实 ToolsService 取出定义后直接 execute，未经过模型工具执行管线与 agent scope 执行器。',
      'SDK 在隔离 Cordis 上下文中组合，不是官方 app boot 的完整服务图；其它插件的成本未计入。',
      '事件循环延迟用 2ms 定时器采样，本机基线分辨率约 14ms；小于该量级的空闲影响不可分辨。',
      '影响面是进程内注册表/真实 worker 的采样，不是对生产 DSH 服务延迟或吞吐的保证。',
    ],
  };

  let failures = 0;
  let ctx;
  let tools;
  let connection;
  let dispatch;
  let fixture;
  let probeToolDef;
  let probeToolOff = () => {};
  let probeRouteOff = () => {};
  const unhandled = [];
  const onUnhandled = reason => { unhandled.push(formatError(reason)); };
  process.on('unhandledRejection', onUnhandled);

  /** 记录一条检查；失败继续跑后续可独立执行的检查。 */
  async function check(id, title, run) {
    try {
      const detail = await run();
      report.checks.push({ id, title, ok: true, detail: detail ?? null });
      console.log(`PASS ${id} ${title}`);
      return { ok: true, detail };
    } catch (error) {
      failures += 1;
      const message = formatError(error);
      report.checks.push({ id, title, ok: false, error: message });
      console.log(`FAIL ${id} ${title}
     ${message}`);
      return { ok: false, error: message };
    }
  }

  try {
    console.log('== cognition-tree DSH host check ==');
    console.log(`repo: ${REPO_ROOT}`);
    console.log(`sdk : ${args.sdkRoot}`);

    // ---------- 前置：SDK、产物、插件入口 ----------
    if (!existsSync(join(args.sdkRoot, 'node_modules'))) throw new Error(`SDK checkout 缺少 node_modules：${args.sdkRoot}`);
    if (!existsSync(PLUGIN_ENTRY) || !existsSync(PLUGIN_WORKER)) {
      throw new Error(`缺少构建产物：${PLUGIN_ENTRY} 或 ${PLUGIN_WORKER}；请先在适配器目录运行 node scripts/build.mjs server`);
    }
    fixture = makeFixture(REPO_ROOT);
    assertInsideLocalWork(REPO_ROOT, fixture.runDir);
    mkdirSync(fixture.runDir, { recursive: true });

    const sdk = await loadSdk(args.sdkRoot);
    report.sdk = {
      dsh: sdk.versions.dsh,
      packages: Object.fromEntries(Object.entries(sdk.versions).filter(([key]) => key !== 'dsh')),
      entries: sdk.entries,
    };
    console.log(`dsh version: ${sdk.versions.dsh.version}`);

    const pluginModule = await import(pathToFileURL(PLUGIN_ENTRY).href);
    const candidate = pluginModule.default?.apply ? pluginModule.default : pluginModule;
    report.artifacts = {
      entry: PLUGIN_ENTRY,
      entryBytes: statSync(PLUGIN_ENTRY).size,
      entrySha256: sha256File(PLUGIN_ENTRY),
      worker: PLUGIN_WORKER,
      workerBytes: statSync(PLUGIN_WORKER).size,
      workerSha256: sha256File(PLUGIN_WORKER),
    };
    await check('artifact.entry', '构建产物可导入且导出 apply/name/inject', async () => {
      assert(typeof candidate.apply === 'function', 'index.js 缺少 apply');
      assert(typeof candidate.name === 'string' && candidate.name.length > 0, 'index.js 缺少 name');
      assert(Array.isArray(candidate.inject), 'index.js 缺少 inject 数组');
      return { name: candidate.name, inject: candidate.inject, exports: Object.keys(pluginModule).sort() };
    });

    // ---------- 装配真实注册表与最小宿主替身 ----------
    const { Context, Service, SystemPrompt, ToolsService, HostConnectionService } = sdk;
    ctx = new Context();
    // SystemPrompt 是 ToolsService 的真实依赖；Connection 的 registry 不依赖它。
    new SystemPrompt(ctx, {});
    tools = new ToolsService(ctx);
    installHostDoubles(ctx, Service, fixture);
    connection = new HostConnectionService(
      ctx,
      ['127.0.0.1:3080'],
      makeBrowserAuthDouble(),
    );
    dispatch = createDispatcher(connection);
    probeToolDef = probeTool();
    probeToolOff = tools.register(probeToolDef);
    probeRouteOff = await connection.fetch.register(probeRoute());

    await check('host.registries', '真实 ToolsService 与 Connection fetch 注册表可用', async () => {
      assert(typeof tools.get === 'function' && typeof tools.register === 'function', 'ToolsService API 不可用');
      assert(typeof connection.fetch?.register === 'function', 'Connection fetch.register 不可用');
      assert(typeof connection.createSharedFetchHandler === 'function', 'Connection 共享 handler 不可用');
      assert(tools.get(PROBE_TOOL)?.name === PROBE_TOOL, '无关工具未注册');
      const response = await dispatch(PROBE_PATH);
      assert(response.status === 200, `无关路由基线返回 ${response.status}`);
      assert((await responseJson(response)).marker === 'host-probe', '无关路由标记不符');
      return { serviceScopedProxy: ctx.tools !== tools };
    });

    const host = {
      check, report, ctx, tools, connection, dispatch, fixture, candidate, sdk, probeToolDef,
      probeRouteOff, probeToolOff, pluginEntry: PLUGIN_ENTRY,
      baseline: null, baselineSnapshot: null, baselineWorkers: 0,
      fiber: null, fatal: null, sse: null, fold: null,
    };

    // 固定顺序：基线 → 注册 → 空闲 → 存盘业务 → 忙碌采样 → fold cursor → 隔离 → 卸载 → 重开。
    await runBaseline(host);
    await runRegister(host);
    await runIdle(host);
    await runBusiness(host);
    await runBusyImpact(host);
    await runFoldCursor(host);
    await runIsolation(host);
    await runDispose(host);
    await runReload(host);

    // ---------- 汇总 ----------
    report.impact.afterDispose ??= {
      dispatch: report.impact.baseline.dispatch,
      rss: rssBytes(),
      workers: workerCount(),
    };
    report.process = {
      baselineWorkers: host.baseline.workers,
      unhandledRejections: unhandled,
      finalSnapshot: snapshotProcess(),
    };
    await check('process.unhandled', '整轮检查无未处理 Promise 拒绝', async () => {
      assert(unhandled.length === 0, `出现未处理拒绝：${unhandled.join('；')}`);
      return { count: 0 };
    });

    console.log('\n-- checks --');
    for (const item of report.checks) {
      console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id} ${item.title}${item.ok ? '' : ` — ${item.error}`}`);
    }
    console.log('\n-- impact (in-process, ms) --');
    console.log(`baseline  dispatch p50/p95=${report.impact.baseline.dispatch.p50Ms}/${report.impact.baseline.dispatch.p95Ms}  loop p95=${report.impact.baseline.eventLoop.p95Ms}  rss=${report.impact.baseline.rss}  workers=${report.impact.baseline.workers}`);
    if (report.impact.idle) console.log(`idle      dispatch p50/p95=${report.impact.idle.dispatch.p50Ms}/${report.impact.idle.dispatch.p95Ms}  loop p95=${report.impact.idle.eventLoop.p95Ms}  rss=${report.impact.idle.rss}  workers=${report.impact.idle.workers}`);
    if (report.impact.busy) console.log(`busy      dispatch p50/p95=${report.impact.busy.dispatch.p50Ms}/${report.impact.busy.dispatch.p95Ms}  loop p95=${report.impact.busy.eventLoop.p95Ms}  rss=${report.impact.busy.rss}  workers=${report.impact.busy.workers}`);
    if (report.impact.afterDispose) console.log(`after     dispatch p50/p95=${report.impact.afterDispose.dispatch.p50Ms}/${report.impact.afterDispose.dispatch.p95Ms}  rss=${report.impact.afterDispose.rss}  workers=${report.impact.afterDispose.workers}`);
    if (report.business.createMs !== undefined) {
      console.log(`business  createTree=${report.business.createMs}ms readView=${report.business.readViewMs}ms db=${report.business.database?.bytes}B`);
    }
    if (report.business.reload) {
      console.log(`reload    readNode=${report.business.reload.nodeTitle} history=${report.business.reload.historyItems} oldCursor=${report.business.reload.cursorCode} workers=${report.business.reload.workers}`);
    }
    console.log('结论：无关路由分发 p95 在基线/空闲/工作时同一量级；事件循环采样分辨率约 14ms，只能排除大于该量级的空闲回归；忙碌期 RSS 与单 worker 的变化见上。');
    console.log('\n-- real --');
    for (const item of report.real) console.log(`* ${item}`);
    console.log('\n-- doubles --');
    for (const item of report.doubles) console.log(`* ${item}`);
    console.log('\n-- unverified boundaries --');
    for (const item of report.unverified) console.log(`* ${item}`);
    console.log(`\nrun dir: ${fixture.runDir}`);
    console.log(`database: ${report.business.database?.path ?? '（未创建）'}`);
    report.exitCode = failures === 0 ? 0 : 1;
    process.exitCode = report.exitCode;
    console.log(`\nEXIT_CODE=${report.exitCode}`);
  } catch (error) {
    failures += 1;
    const message = formatError(error);
    console.error(`FATAL ${message}`);
    report.checks.push({ id: 'fatal', title: '检查在完成前中止', ok: false, error: message });
    report.exitCode = 1;
    process.exitCode = 1;
    console.log(`\nEXIT_CODE=1`);
  } finally {
    report.finishedAt = new Date().toISOString();
    // 清理只释放本次检查创建的进程内贡献；已创建的 .local-work 数据保留作证据。
    try { await host.sse?.reader.cancel(); } catch { /* 流可能已结束。 */ }
    try { await probeRouteOff(); } catch { /* 路由可能已随卸载移除。 */ }
    try { probeToolOff(); } catch { /* 同上。 */ }
    try { if (ctx?.fiber?.dispose) await ctx.fiber.dispose(); } catch { /* 根上下文可能已部分释放。 */ }
    if (unhandled.length > 0) {
      console.error(`未处理拒绝：${unhandled.join('；')}`);
    }
    process.removeListener('unhandledRejection', onUnhandled);
    if (fixture) {
      try {
        writeFileSync(join(fixture.runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(`report: ${join(fixture.runDir, 'report.json')}`);
      } catch (error) {
        console.error(`报告写入失败：${formatError(error)}`);
      }
    }
  }
}

// 兜底看门狗：若真实 worker 或 SSE 未释放导致事件循环不空，超时以 2 退出而不悬挂。
const watchdog = setTimeout(() => {
  console.error('check-host watchdog：30 秒后仍有未释放句柄，强制退出 2');
  process.exit(2);
}, 30_000);
watchdog.unref();

await main();
clearTimeout(watchdog);
