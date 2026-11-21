/** 日常新建树的领域规则：只接收树 ID 和根问题、组装唯一的根；身份、时钟与事务由上层负责。 */
import { insertNode } from '../operations';
import type { TreeId } from '../types';
import type { FormationPlan } from './formation';
import { onlyFields, record, requiredText } from './validation';

/**
 * 校验并固定本次写入内容，不接受种子、已有历史、确认或自报身份。
 * @param input 新建树请求；树 ID 为目标和根节点 ID，根问题作为根标题原样保存
 * @returns 目标树 ID 及待同笔提交的唯一根与形成动作；不分配修订 ID、不读写存储
 */
export function prepareCreateTree(input: unknown): { treeId: TreeId; plan: FormationPlan } {
  const data = record(input, '新建树参数');
  onlyFields(data, ['treeId', 'rootQuestion'], '新建树参数');
  const treeId = requiredText(data.treeId, '目标树 ID');
  const title = requiredText(data.rootQuestion, '根问题');
  const root = insertNode(
    { id: treeId, parentId: null, body: { title }, origin: { kind: 'branch' } },
    { state: 'open' },
  );
  return {
    treeId,
    plan: { changes: [root], action: { action: 'createTree' }, summary: `新建树 ${treeId}「${title}」` },
  };
}
