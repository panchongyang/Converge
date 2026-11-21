/** 在隔离工作区通过真实注册表走通空白建树、继续维护、订阅和旧入口拒绝；不触及正式项目数据。 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CALL_PATH, TREES_PATH, WATCH_PATH, WORKER_WAIT_MS } from './constants.mjs';
import { readViewInput, responseJson, seedTree, waitFor } from './sdk.mjs';
import { assert } from './util.mjs';
import { SseReader, workerCount } from './measure.mjs';

/** 只传受信会话的定位符，不传 cwd 或身份。@param host 隔离宿主 @param op 人侧意图 @param input 具名参数 */
async function uiCall(host, op, input) {
  const response = await host.dispatch(CALL_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ sessionId: host.fixture.session.id, op, input }),
  });
  return { status: response.status, body: await responseJson(response) };
}

/** 用真实注册的 AI 工具和对应会话分派；不走人的路由。@param host 隔离宿主 @param name 工具名 @param input 工具参数 */
function aiCall(host, name, input) {
  const tool = host.tools.get(`cognition_tree_${name}`);
  assert(tool, `${name} 未注册`);
  const session = host.fixture.session;
  return tool.execute(input, { agent: { id: session.id, session }, signal: new AbortController().signal });
}

/** 校验单根树的来源与确认语义，创建者的身份不能由请求参数指定。@param detail readNode 结果 @param id 根 ID @param by 执行者 */
function assertNewRoot(detail, id, by) {
  const { node, currentChange } = detail;
  assert(node.id === id && node.parentId === null && node.state === 'open', '根节点位置或状态不符');
  assert(node.confirmation === 'unconfirmed' && currentChange.by === by && currentChange.detail.action === 'createTree', '建树不是此执行者的未确认形成记录');
}

/** 验证订阅与两种入口的新建意图，以及原有六种维护/读取意图。@param host 真实注册表、夹具和报告 */
export async function runBusiness(host) {
  const { check, report, fixture, baseline } = host;
  const { treeId, session } = fixture;
  const disk = id => join(fixture.workspace, '.converge', `${id}.sqlite`);

  await check('business.watch', 'SSE 订阅返回 ready，订阅本身不启动 worker', async () => {
    const response = await host.dispatch(`${WATCH_PATH}?sessionId=${encodeURIComponent(session.id)}`, { headers: { 'sec-fetch-site': 'same-origin' } });
    assert(response.status === 200 && response.headers.get('content-type')?.startsWith('text/event-stream'), 'watch 未建立 SSE');
    host.sse = new SseReader(response.body.getReader());
    const ready = await host.sse.next(5000);
    assert(ready.event === 'ready' && JSON.parse(ready.data).sessionId === session.id, 'ready 会话不符');
    assert(workerCount() === baseline.workers, '仅订阅就启动了 worker');
  });

  await check('business.reject-import', '有效的旧手稿载荷也不能经 DSH 人侧路由导入', async () => {
    const forbiddenId = `${treeId}-import`;
    const { status, body } = await uiCall(host, 'bootstrapTree', { seed: seedTree(forbiddenId) });
    assert(status === 400 && body?.error?.code === 'invalid' && !existsSync(disk(forbiddenId)), '旧导入入口未彻底关闭');
    assert(workerCount() === baseline.workers, '拒绝手稿仍启动了工作线程');
  });

  /** 目录消费方只知道自己的宿主会话，不预置树 ID，也不传路径。@param id 会话定位符 */
  async function directory(id) {
    const response = await host.dispatch(`${TREES_PATH}?sessionId=${encodeURIComponent(id)}`);
    const result = await responseJson(response);
    assert(response.status === 200 && result.ok && !result.value.unavailable.length, '根目录读取失败');
    return result.value.trees;
  }
  await check('directory.empty', '查看空工作区不会创建数据库或目录', async () => {
    assert((await directory(session.id)).length === 0, '空工作区目录应为空');
    assert(!existsSync(join(fixture.workspace, '.converge')), '打开列表不应初始化数据目录');
  });

  await check('business.create-tree', '人侧经真实工作线程创建单根 SQLite 树，同名创建不覆盖', async () => {
    const rootQuestion = '这个工作区要记录哪些决定？';
    const start = performance.now();
    const created = await uiCall(host, 'createTree', { treeId, rootQuestion });
    assert(created.status === 200 && created.body.value === treeId, `建树失败：${JSON.stringify(created)}`);
    await waitFor(() => workerCount() === baseline.workers + 1, WORKER_WAIT_MS, '后台 worker 启动');
    report.business.createMs = Math.round((performance.now() - start) * 1000) / 1000;
    report.business.database = { path: disk(treeId), bytes: statSync(disk(treeId)).size };
    const duplicate = await uiCall(host, 'createTree', { treeId, rootQuestion: '不可覆盖原问题' });
    assert(duplicate.status === 400 && duplicate.body.error.code === 'invalid', '同 ID 未被拒绝');
    const read = await aiCall(host, 'read_node', { treeId, nodeId: treeId });
    assertNewRoot(read, treeId, 'human');
    assert(read.node.body.title === rootQuestion, '同名创建覆盖了根问题');
    return report.business.database;
  });

  await check('business.ai-create', 'AI 在同一工作区另建空白树，不复制手稿、不确认', async () => {
    const other = `${treeId}-ai`;
    const result = await aiCall(host, 'create_tree', { treeId: other, rootQuestion: '另一棵树的问题' });
    assert(result === other && existsSync(disk(other)), '第二棵树没有独立落盘');
    assertNewRoot(await aiCall(host, 'read_node', { treeId: other, nodeId: other }), other, 'ai');
    const page = await aiCall(host, 'read_view', readViewInput(other));
    assert(page.complete && page.nodes.length === 1 && page.refs.length === 0, '新树夹带额外分支或引用');
  });

  await check('directory.discover', '另一会话可列出两棵树的真实根问题，不混入其它工作区', async () => {
    const rows = await directory(fixture.peerSession.id);
    assert(rows.length === 2 && rows.every(row => Object.keys(row).sort().join(',') === 'rootId,rootQuestion,treeId'), '目录应只返回每棵树的根定位和标题');
    const first = rows.find(row => row.treeId === treeId);
    const second = rows.find(row => row.treeId === `${treeId}-ai`);
    assert(first?.rootQuestion === '这个工作区要记录哪些决定？' && second?.rootQuestion === '另一棵树的问题', '没有发现同工作区的新树');
    const opened = await uiCall(host, 'readNode', { treeId: second.treeId, nodeId: second.rootId });
    assert(opened.body.value.node.body.title === second.rootQuestion, '列表项与打开的根不匹配');
    assert((await directory(fixture.otherSession.id)).length === 0, '目录泄露了其它工作区');
    return { sameWorkspace: rows.length, otherWorkspace: 0 };
  });

  await check('business.tools-read', '七个 AI 工具支持建树、维护与查询', async () => {
    const start = performance.now();
    const view = await aiCall(host, 'read_view', readViewInput(treeId));
    assert(view.rootId === treeId && view.focusId === treeId && view.stamp === 1, '初版根或版本不符');
    report.business.readViewMs = Math.round((performance.now() - start) * 1000) / 1000;
    const id = await aiCall(host, 'add_branch', { treeId, placement: { parentId: treeId, kind: 'branch' },
      draft: { body: { title: 'AI 验证分支' }, state: 'open', refs: [] } });
    report.business.branchId = id;
    const detail = await aiCall(host, 'read_node', { treeId, nodeId: id });
    assert(detail.node.body.title === 'AI 验证分支', '新增判断标题不符');
    const decided = await aiCall(host, 'decide_node', { treeId, nodeId: id,
      decision: { type: 'prune', reason: '隔离检查', reviveWhen: '有新证据' } });
    assert(decided === id, '决定没有返回原 ID');
    const history = await aiCall(host, 'read_history', { treeId, limit: 20 });
    assert(history.items.length === 3, '预期仅有创建、分支与剪除三条历史');
    const pending = await aiCall(host, 'read_unconfirmed', { treeId, by: ['human', 'ai'], limit: 20 });
    assert(pending.items.length === 2, '根和分支均应未经人确认');
  });

  await check('business.ai-wire-budget', '真实 worker 用模型文本而非传输 JSON 决定 AI 字节预算', async () => {
    const input = { ...readViewInput(treeId), onLimit: 'exact' };
    const tool = host.tools.get('cognition_tree_read_view');
    assert(tool, 'read_view 工具未注册');
    const wide = await aiCall(host, 'read_view', input);
    const text = tool.output.render(input, wide)[0].text;
    const compactBytes = Buffer.byteLength(text, 'utf8');
    const jsonBytes = Buffer.byteLength(JSON.stringify(wide), 'utf8');
    assert(text.startsWith('CTV2 ') && compactBytes < jsonBytes, '模型未收到紧凑的视图正文');
    const tight = { ...input, budget: { ...input.budget, maxBytes: compactBytes + 8 } };
    assert(tight.budget.maxBytes < jsonBytes, '测试预算应区分紧凑文本与 JSON');
    const view = await aiCall(host, 'read_view', tight);
    assert(view.complete && tool.output.render(tight, view)[0].text === text, 'AI 字节预算在 worker 和宿主不一致');
    const humanTight = await uiCall(host, 'readView', tight);
    assert(humanTight.body.error?.code === 'rangeTooLarge', '人侧不应套用 AI 字节预算');
    const humanWide = await uiCall(host, 'readView', input);
    assert(humanWide.body.value?.nodes.length === wide.nodes.length, '人侧仍应收到规范 JSON 的节点行');
    return { compactBytes, jsonBytes, aiBudget: tight.budget.maxBytes };
  });

  await check('business.watch-change', '创建提交后订阅收到真实根的形成记录', async () => {
    const frame = await host.sse.next(4000);
    const change = JSON.parse(frame.data);
    assert(frame.event === 'change' && change.treeId === treeId && change.stamp === 1 && change.revisions[0]?.detail?.action === 'createTree', '没有收到根创建提交');
    return { stamp: change.stamp, action: change.revisions[0].detail.action };
  });
}

/** 留下一个可折叠查询，以便验证关停重开后不会把新旧版本拼起来。@param host 隔离宿主 */
export async function runFoldCursor(host) {
  const { treeId } = host.fixture;
  await host.check('business.fold-cursor', '预算先到时返回 fold cursor，供重开后续读', async () => {
    for (let i = 1; i <= 12; i++) await aiCall(host, 'add_branch', {
      treeId, placement: { parentId: treeId, kind: 'branch' }, draft: { body: { title: `预算分支 ${i}` }, state: 'keep', refs: [] },
    });
    const input = { ...readViewInput(treeId), budget: { maxScans: 3, maxNodes: 3, maxBytes: 65536 } };
    const view = await aiCall(host, 'read_view', input);
    assert(!view.complete && view.cursor && view.boundaries.some(b => b.kind === 'budget'), '紧预算没有返回可续页');
    host.fold = { input, cursor: view.cursor };
    return { cursorChars: view.cursor.length };
  });
  return host.fold;
}
