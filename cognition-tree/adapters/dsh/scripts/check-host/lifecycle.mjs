/**
 * 插件生命周期：基线、Cordis 注册/路由、空闲、隔离、卸载与重开。
 * 每个函数只按顺序执行对应检查，共享 host 对象里的真实注册表与夹具，不新建框架。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AI_TOOLS, CALL_PATH, WATCH_PATH, TREES_PATH, WORKER_WAIT_MS } from './constants.mjs';
import { assert, formatError } from './util.mjs';
import { PROBE_PATH, PROBE_TOOL, readViewInput, responseJson, waitFor } from './sdk.mjs';
import { diffSnapshot, measureDispatch, measureEventLoop, rssBytes, snapshotProcess, workerCount } from './measure.mjs';

export async function runBaseline(host) {
  const { check, report, probeToolDef, dispatch, fixture } = host;
  let baselineSnapshot;
    // ---------- 基线：插件加载前 ----------
    const baselineWorkers = workerCount();
    const baseline = {
      dispatch: await measureDispatch(dispatch, 200),
      eventLoop: await measureEventLoop(250),
      rss: rssBytes(),
      workers: baselineWorkers,
      convergeDirAbsent: !existsSync(join(fixture.workspace, '.converge')),
    };
    baselineSnapshot = snapshotProcess();
    report.impact.baseline = baseline;
    console.log(`baseline: dispatch p95=${baseline.dispatch.p95Ms}ms loop p95=${baseline.eventLoop.p95Ms}ms workers=${baseline.workers}`);
    await check('host.baseline', '插件加载前：无关工具/路由可用、无认知树库', async () => {
      assert((await probeToolDef.execute({ value: 'base' })) === 'probe:base', '无关工具执行失败');
      const unknown = await dispatch('/api/cognition-tree/not-registered');
      assert(unknown.status === 404, `未知路由应为 404，实际 ${unknown.status}`);
      assert(baseline.convergeDirAbsent, '夹具工作区在插件加载前已有 .converge');
      return { workers: baseline.workers, unknownRoute: unknown.status };
    });
  host.baseline = baseline;
  host.baselineSnapshot = baselineSnapshot;
  host.baselineWorkers = baselineWorkers;
  return baseline;
}

export async function runRegister(host) {
  const { check, ctx, tools, dispatch, candidate } = host;
  let fiber;
  let fatal = null;
    // ---------- 注册：真实 Cordis 插件激活 ----------
    fiber = ctx.plugin(candidate);
    const registered = await check('plugin.register', 'Cordis 激活后注册七个 AI 工具', async () => {
      await waitFor(() => AI_TOOLS.every(name => tools.get(name)), 5000, '七个认知树工具注册');
      const definitions = AI_TOOLS.map(name => {
        const definition = tools.get(name);
        assert(definition, `${name} 未注册`);
        assert(definition.parameters?.type === 'object', `${name}.parameters 不是对象 schema`);
        assert(typeof definition.output?.render === 'function', `${name}.output.render 不是函数`);
        assert(typeof definition.execute === 'function', `${name}.execute 不是函数`);
        return {
          name,
          required: definition.parameters.required ?? [],
          descriptionChars: String(definition.description ?? '').length,
        };
      });
      const forbidden = ['cognition_tree_read_node', 'cognition_tree_confirm', 'cognition_tree_bootstrap', 'cognition_tree_bootstrap_tree']
        .filter(name => tools.get(name));
      assert(forbidden.length === 0, `不应注册单点/确认/自举工具：${forbidden.join(', ')}`);
      return { count: definitions.length, definitions, forbidden };
    });
    if (!registered.ok) fatal = '工具注册失败，跳过依赖插件的业务检查';

    let routesRegistered = false;
    if (!fatal) {
      const routeCheck = await check('plugin.routes', 'Connection exact Fetch 路由注册且不占 /api fallback', async () => {
        await waitFor(async () => {
          const response = await dispatch(CALL_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
            body: '{}',
          });
          const body = await responseJson(response);
          return response.status === 400 && body?.error?.code === 'invalid';
        }, 5000, 'call 路由注册');
        const watchResponse = await dispatch(WATCH_PATH, { headers: { 'sec-fetch-site': 'same-origin' } });
        const watchBody = await responseJson(watchResponse);
        assert(watchResponse.status === 400 && watchBody?.error?.code === 'invalid', `watch 路由未按预期拒绝空参数（${watchResponse.status}）`);
        const treesResponse = await dispatch(TREES_PATH);
        assert(treesResponse.status === 400 && (await responseJson(treesResponse))?.error?.code === 'invalid', '目录路由必须拒绝无会话读取');
        const unknown = await dispatch('/api/cognition-tree/not-registered');
        assert(unknown.status === 404, `插件不应占用 /api fallback；未知路径返回 ${unknown.status}`);
        return { callPath: CALL_PATH, watchPath: WATCH_PATH, treesPath: TREES_PATH, fallbackStatus: unknown.status };
      });
      routesRegistered = routeCheck.ok;
      if (!routesRegistered) fatal = '人侧路由注册失败，跳过路由业务检查';
    }
  host.fiber = fiber;
  host.fatal = fatal;
  return { fiber, fatal };
}

export async function runIdle(host) {
  const { check, report, dispatch, fixture, baseline, baselineSnapshot, baselineWorkers } = host;
  const fatal = host.fatal;
    // ---------- 空闲：注册不等于工作 ----------
    if (!fatal) {
      await check('idle.no-work', '空闲注册不建库、不启动 worker、不加全局钩子', async () => {
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
        const idleDispatch = await measureDispatch(dispatch, 200);
        const idleLoop = await measureEventLoop(250);
        report.impact.idle = { dispatch: idleDispatch, eventLoop: idleLoop, rss: rssBytes(), workers: workerCount() };
        const workers = workerCount();
        assert(workers === baseline.workers, `空闲 worker 数从 ${baseline.workers} 变为 ${workers}`);
        assert(!existsSync(join(fixture.workspace, '.converge')), '空闲注册创建了 .converge 目录');
        const snapshot = snapshotProcess();
        const diff = diffSnapshot(baselineSnapshot, snapshot);
        assert(diff.eventDiffs.length === 0, `空闲注册改变了进程事件监听：${JSON.stringify(diff.eventDiffs)}`);
        assert(diff.globalsAdded.length === 0 && diff.globalsRemoved.length === 0, `空闲注册改变了 globalThis：+${diff.globalsAdded} -${diff.globalsRemoved}`);
        assert(diff.workerDelta === 0, `空闲注册改变了 worker 数：${diff.workerDelta}`);
        return { workers, convergeAbsent: true, dispatch: idleDispatch, eventLoop: idleLoop, diff };
      });
    }

}

export async function runIsolation(host) {
  const { check, tools, connection, dispatch, fixture, baselineSnapshot } = host;
    // ---------- 隔离：无关能力与插件错误 ----------
    await check('isolation.unrelated', '插件活跃时无关工具/路由仍可用', async () => {
      const response = await dispatch(PROBE_PATH, { method: 'POST' });
      assert(response.status === 200, `无关路由返回 ${response.status}`);
      const body = await responseJson(response);
      assert(body.ok === true && body.marker === 'host-probe' && body.method === 'POST', '无关路由响应被改变');
      const tail = await tools.get(PROBE_TOOL).execute({ value: 'active' }, { signal: new AbortController().signal });
      assert(tail === 'probe:active', `无关工具返回 ${tail}`);
      return { route: body, tool: tail };
    });

    await check('isolation.plugin-errors', '插件参数/会话错误只失败本插件调用', async () => {
      const definition = tools.get('cognition_tree_read_view');
      let toolError;
      try { await definition.execute({ treeId: fixture?.treeId }, { signal: new AbortController().signal }); }
      catch (error) { toolError = error; }
      assert(toolError, '缺参数的工具调用未报错');
      assert(toolError.code === 'invalid', `工具错误 code=${toolError.code}`);
      const badSession = await dispatch(CALL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ sessionId: 'sess-not-bound', op: 'readView', input: readViewInput(fixture.treeId) }),
      });
      const badBody = await responseJson(badSession);
      assert(badSession.status === 404 && badBody?.ok === false, `未绑定会话应 404，实际 ${badSession.status}`);
      const probeAfter = await dispatch(PROBE_PATH);
      assert(probeAfter.status === 200, '插件错误后无关路由不可用');
      const toolAfter = await tools.get(PROBE_TOOL).execute({ value: 'after-error' }, { signal: new AbortController().signal });
      assert(toolAfter === 'probe:after-error', '插件错误后无关工具不可用');
      return { toolCode: toolError.code, routeStatus: badSession.status, routeCode: badBody.error?.code, probe: 'ok' };
    });

    await check('isolation.duplicate-registration', '重复注册只拒绝本次贡献，不拆掉已注册能力', async () => {
      let routeError;
      try {
        await connection.fetch.register({ ...probeRoute(), path: CALL_PATH });
      } catch (error) { routeError = error; }
      assert(routeError, '重复 exact 路由未报错');
      const routeAfter = await dispatch(CALL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      assert(routeAfter.status === 400, `重复注册失败后原路由返回 ${routeAfter.status}`);
      let toolError;
      try { tools.register(probeTool()); } catch (error) { toolError = error; }
      assert(toolError, '同层重复工具未报错');
      const probe = await tools.get(PROBE_TOOL).execute({ value: 'dupe' }, { signal: new AbortController().signal });
      assert(probe === 'probe:dupe', '重复注册失败后无关工具不可用');
      const snapshot = snapshotProcess();
      const diff = diffSnapshot(baselineSnapshot, snapshot);
      assert(diff.eventDiffs.length === 0, `隔离检查后进程监听改变：${JSON.stringify(diff.eventDiffs)}`);
      assert(diff.globalsAdded.length === 0, `隔离检查后 globalThis 增加：${diff.globalsAdded}`);
      return {
        routeError: formatError(routeError),
        toolError: formatError(toolError),
        routeStatus: routeAfter.status,
        probe,
      };
    });
}

export async function runDispose(host) {
  const { check, report, tools, dispatch, fixture, baseline, baselineSnapshot, baselineWorkers, sse } = host;
  let { fiber } = host;
    // ---------- 卸载：只移除本插件贡献 ----------
    if (fiber) {
      await check('dispose.cleanup', '卸载后工具/路由/worker 清理且无全局钩子残留', async () => {
        if (sse) await sse.reader.cancel().catch(() => {});
        await fiber.dispose();
        await waitFor(() => AI_TOOLS.every(name => !tools.get(name)), 5000, '插件工具卸载');
        await waitFor(async () => {
          const response = await dispatch(CALL_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          return response.status === 404;
        }, 5000, '插件路由卸载');
        await waitFor(() => workerCount() === baseline.workers, WORKER_WAIT_MS, 'worker 退出');
        const probe = await dispatch(PROBE_PATH);
        assert(probe.status === 200, '卸载后无关路由不可用');
        const probeValue = await tools.get(PROBE_TOOL).execute({ value: 'after-dispose' }, { signal: new AbortController().signal });
        assert(probeValue === 'probe:after-dispose', '卸载后无关工具不可用');
        const snapshot = snapshotProcess();
        const diff = diffSnapshot(baselineSnapshot, snapshot);
        assert(diff.eventDiffs.length === 0, `卸载后进程监听残留：${JSON.stringify(diff.eventDiffs)}`);
        assert(diff.globalsAdded.length === 0 && diff.globalsRemoved.length === 0, `卸载后 globalThis 差异：+${diff.globalsAdded} -${diff.globalsRemoved}`);
        assert(diff.workerDelta === 0, `卸载后 worker 残留：${diff.workerDelta}`);
        assert(existsSync(join(fixture.workspace, '.converge')), '检查不应删除已创建的数据库');
        const afterDispatch = await measureDispatch(dispatch, 100);
        report.impact.afterDispose = { dispatch: afterDispatch, rss: rssBytes(), workers: workerCount() };
        return { workers: workerCount(), probeStatus: probe.status, dispatch: afterDispatch };
      });
    }
  host.fiber = fiber;
}

export async function runReload(host) {
  const { check, report, ctx, tools, fixture, fold, dispatch, baseline, baselineSnapshot, baselineWorkers } = host;
  let { fiber } = host;
    // ---------- 重开：新插件实例/新 worker 从同一 SQLite 读回，旧游标失效 ----------
    if (fiber && fold && report.business.branchId) {
      await check('reload.persistence', '卸载后重建实例与 worker 读回已有树/修订，旧 fold cursor 报 viewExpired', async () => {
        // 查询串绕过 ESM 缓存，得到一次真实模块重载；worker 仍指向同目录 worker.js。
        const reloaded = await import(`${pathToFileURL(host.pluginEntry).href}?reload=${Date.now()}`);
        const nextPlugin = reloaded.default?.apply ? reloaded.default : reloaded;
        fiber = ctx.plugin(nextPlugin);
        await waitFor(() => AI_TOOLS.every(name => tools.get(name)), 5000, '重载后七个工具注册');
        await waitFor(async () => {
          const response = await dispatch(CALL_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          return response.status === 400;
        }, 5000, '重载后路由注册');
        const execution = { agent: { id: fixture.session.id, session: fixture.session }, signal: new AbortController().signal };
        const directory = await responseJson(await dispatch(`${TREES_PATH}?sessionId=${encodeURIComponent(fixture.peerSession.id)}`));
        assert(directory.ok && directory.value.trees.length === 2 && directory.value.trees.some(row => row.treeId === fixture.treeId), '重载后另一会话未发现已有库');
        const detailPage = await tools.get('cognition_tree_read_view').execute({
          ...readViewInput(fixture.treeId),
          focus: report.business.branchId,
          expand: { subtreeDepth: 0, jumpHops: 0, direction: 'out', jumpFrom: 'anchor', afterJumpDepth: 0 },
          onLimit: 'exact',
          includeDetails: true,
        }, execution);
        const node = detailPage.nodes.find(item => item.id === report.business.branchId);
        assert(node?.detail?.node?.body?.title === 'AI 验证分支', `重开 readView 详情标题=${node?.detail?.node?.body?.title}`);
        const history = await tools.get('cognition_tree_read_history').execute(
          { treeId: fixture.treeId, limit: 50 }, execution,
        );
        assert(history.items.length >= 3, `重开 readHistory 只有 ${history.items.length} 条`);
        let cursorError;
        try {
          await tools.get('cognition_tree_read_view').execute({ ...fold.input, cursor: fold.cursor }, execution);
        } catch (error) { cursorError = error; }
        assert(cursorError?.code === 'viewExpired', `旧 cursor 应报 viewExpired，实际 ${cursorError?.code ?? cursorError}`);
        assert(workerCount() === baseline.workers + 1, `重开后 worker 数=${workerCount()}`);
        const view = await tools.get('cognition_tree_read_view').execute(readViewInput(fixture.treeId), execution);
        assert(view.nodes.some(item => item.id === report.business.branchId), '重开 readView 未包含 AI 分支');
        report.business.reload = {
          nodeTitle: node.detail.node.body.title,
          historyItems: history.items.length,
          cursorCode: cursorError.code,
          workers: workerCount(),
        };
        return report.business.reload;
      });

      await check('dispose.reload', '重开实例卸载后同样只移除自身贡献', async () => {
        await fiber.dispose();
        await waitFor(() => AI_TOOLS.every(name => !tools.get(name)), 5000, '重载实例工具卸载');
        await waitFor(async () => {
          const response = await dispatch(CALL_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          return response.status === 404;
        }, 5000, '重载实例路由卸载');
        await waitFor(() => workerCount() === baseline.workers, WORKER_WAIT_MS, '重载实例 worker 退出');
        const probe = await dispatch(PROBE_PATH);
        assert(probe.status === 200, '重载实例卸载后无关路由不可用');
        const diff = diffSnapshot(baselineSnapshot, snapshotProcess());
        assert(diff.eventDiffs.length === 0, `重载实例卸载后进程监听残留：${JSON.stringify(diff.eventDiffs)}`);
        assert(diff.globalsAdded.length === 0 && diff.globalsRemoved.length === 0, '重载实例卸载后 globalThis 差异');
        assert(diff.workerDelta === 0, `重载实例卸载后 worker 残留：${diff.workerDelta}`);
        return { workers: workerCount(), probeStatus: probe.status };
      });
    }
  host.fiber = fiber;
}
