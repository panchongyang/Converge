/** Worker 边界用真实 node:worker_threads、极小的消息夹具；SQLite 实库与真实 DSH SDK 的验证另做。 */
import { describe, expect, it } from 'vitest';
import { createBackend } from '../src/server/backend';

/** 生成无文件 I/O 的线程入口，夹具只处理本测试关心的协议。@param body 线程中执行的可信测试代码 */
function fixture(body: string): URL {
  return new URL('data:text/javascript,' + encodeURIComponent(`import {parentPort} from 'node:worker_threads';\n${body}`));
}
const input = { treeId: 'T1', nodeId: 'n' };

describe('宿主与插件工作线程的边界', () => {
  it('未发生业务调用时不启动线程，重复卸载无副作用', async () => {
    const backend = createBackend(fixture(`throw Error('没有业务调用就不应运行');`));
    const off = backend.watch(() => { throw Error('不应通知'); });
    off(); await backend.close(); await backend.close();
    await expect(backend.call('unused', 'ai', 'readNode', input)).rejects.toMatchObject({ code: 'storage' });
    await expect(backend.listTrees('unused')).rejects.toMatchObject({ code: 'storage' });
  });

  it('目录和意图共用编号与pending，并行乱序回复仍按工作区和调用隔离且不产生commit', async () => {
    const backend = createBackend(fixture(`const pending = [];
      parentPort.on('message', m => {
        if (m.kind === 'close') { parentPort.close(); return; }
        if (m.kind === 'listTrees' && ['op','input','actor'].some(key => key in m)) throw Error('目录不是catalog操作');
        const value = m.kind === 'listTrees'
          ? {trees:[{treeId:'SharedTree',rootId:'LegacyRoot',rootQuestion:'root:'+m.root}],unavailable:['DamagedTree']}
          : m.root + ':' + m.input.nodeId;
        pending.push({kind:'ok',id:m.id,value});
        if (pending.length === 4) for (const reply of pending.reverse()) parentPort.postMessage(reply);
      });`));
    const changes: unknown[] = [];
    backend.watch((...args) => changes.push(args));
    try {
      const results = await Promise.all([
        backend.listTrees('workspace-A'), backend.call('workspace-A', 'human', 'readNode', input),
        backend.listTrees('workspace-B'), backend.call('workspace-B', 'ai', 'readNode', { ...input, nodeId: 'other' }),
      ]);
      expect(results).toEqual([
        { trees: [{ treeId: 'SharedTree', rootId: 'LegacyRoot', rootQuestion: 'root:workspace-A' }], unavailable: ['DamagedTree'] },
        'workspace-A:n',
        { trees: [{ treeId: 'SharedTree', rootId: 'LegacyRoot', rootQuestion: 'root:workspace-B' }], unavailable: ['DamagedTree'] },
        'workspace-B:other',
      ]);
      expect(changes).toEqual([]);
    } finally { await backend.close(); }
  });

  it('目录和意图共享64个pending上限及close，关闭先前接收的两类请求均排空', async () => {
    const backend = createBackend(fixture(`parentPort.on('message', m => {
      if (m.kind === 'close') { parentPort.close(); return; }
      parentPort.postMessage({kind:'ok',id:m.id,value:m.kind === 'listTrees' ? {trees:[],unavailable:[]} : 'read'});
    });`));
    const accepted = Array.from({ length: 64 }, (_, index) => index % 2 ? backend.call('A', 'ai', 'readNode', input) : backend.listTrees('A'));
    const directoryOverflow = expect(backend.listTrees('B')).rejects.toMatchObject({ code: 'storage' });
    const callOverflow = expect(backend.call('B', 'human', 'readNode', input)).rejects.toMatchObject({ code: 'storage' });
    await directoryOverflow; await callOverflow;
    const closing = backend.close();
    await expect(Promise.all(accepted)).resolves.toHaveLength(64);
    await closing;
    await expect(backend.listTrees('A')).rejects.toMatchObject({ code: 'storage' });
    await backend.close();
  });

  it('目录错误和其它并行调用按各自ID返回，错误后仍可使用同一后台', async () => {
    const backend = createBackend(fixture(`parentPort.on('message', m => {
      if (m.kind === 'close') { parentPort.close(); return; }
      parentPort.postMessage(m.root === 'broken'
        ? {kind:'error',id:m.id,code:'storage',message:'目录暂不可用'}
        : {kind:'ok',id:m.id,value:m.kind === 'listTrees' ? {trees:[],unavailable:[]} : 'read'});
    });`));
    try {
      const failed = expect(backend.listTrees('broken')).rejects.toMatchObject({ code: 'storage', message: '目录暂不可用' });
      await expect(backend.call('good', 'ai', 'readNode', input)).resolves.toBe('read');
      await failed;
      await expect(backend.listTrees('good')).resolves.toEqual({ trees: [], unavailable: [] });
    } finally { await backend.close(); }
  });

  it('线程故障不终止宿主、不自动重试或报告写成功', async () => {
    const backend = createBackend(fixture(`parentPort.on('message', () => { throw Error('模拟插件内部失败'); });`));
    const intent = expect(backend.call('unused', 'ai', 'readNode', input)).rejects.toMatchObject({ code: 'storage' });
    const directory = expect(backend.listTrees('unused')).rejects.toMatchObject({ code: 'storage' });
    await Promise.all([intent, directory]);
    await backend.close();
  });

  it('卸载按顺序排空；订阅者异常不改变一个请求的返回值', async () => {
    const backend = createBackend(fixture(`parentPort.on('message', m => {
      if(m.kind === 'close') { parentPort.close(); return; }
      parentPort.postMessage({kind:'commit',root:m.root,change:{treeId:'T1',stamp:1,revisions:[]}});
      parentPort.postMessage({kind:'ok',id:m.id,value:'T1'});
    });`));
    const seen: string[] = [];
    backend.watch(() => { throw Error('模拟 UI 监听失败'); });
    backend.watch((root, change) => seen.push(root + ':' + change.treeId));
    const seed = { treeId: 'T1', rootId: 'n', nodes: [], refs: [], history: [] };
    expect(await backend.call('isolated', 'human', 'bootstrapTree', { seed })).toBe('T1');
    expect(seen).toEqual(['isolated:T1']);
    const accepted = backend.call('isolated', 'human', 'bootstrapTree', { seed });
    const closing = backend.close();
    await expect(accepted).resolves.toBe('T1'); await closing;
  });
});
