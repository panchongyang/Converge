/**
 * 写意图的内核入口（内核接口单 §3.1、§3.4）。依赖现有事实的校验在模型事务内读取；
 * 新建树的纯输入校验可在开事务前完成。使用 operations 组装实际变化；不提交、不采信身份、不访问宿主。
 */
export { planAddBranch, prepareBranch } from './add-branch';
export { prepareBootstrap } from './bootstrap-tree';
export { planConfirmation } from './confirm';
export { prepareCreateTree } from './create-tree';
export { planDecision } from './decide-node';
export type { FormationPlan } from './formation';
