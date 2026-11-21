/**
 * 影响面采样：插件工作时并发真实读，同时测无关路由分发、事件循环与 RSS/worker。
 * 只观察进程内真实注册表与 worker；不启动端口，也不代表生产服务端到端时延。
 */
import { readViewInput } from './sdk.mjs';
import { measureDispatch, measureEventLoop, rssBytes, workerCount } from './measure.mjs';
import { assert } from './util.mjs';

export async function runBusyImpact(host) {
  const { check, report, tools, fixture, dispatch, baseline } = host;

      // ---------- 影响面：工作时的同进程采样 ----------
      await check('impact.busy', '工作时采样宿主响应与资源占用', async () => {
        const definition = tools.get('cognition_tree_read_view');
        assert(definition, 'readView 工具缺失');
        const execution = { agent: { id: fixture.session.id, session: fixture.session }, signal: new AbortController().signal };
        const busy = Promise.all(Array.from({ length: 48 }, () => definition.execute(readViewInput(fixture.treeId), execution)));
        const duringDispatch = await measureDispatch(dispatch, 150);
        const duringLoop = await measureEventLoop(300);
        await busy;
        const workers = workerCount();
        assert(workers === baseline.workers + 1, `工作时 worker 数应为一个，实际 ${workers}`);
        report.impact.busy = {
          dispatch: duringDispatch,
          eventLoop: duringLoop,
          rss: rssBytes(),
          workers,
        };
        return report.impact.busy;
      });
}
