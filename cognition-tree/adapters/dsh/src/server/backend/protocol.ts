/** 插件私有的线程协议。宿主线程持有请求编号及订阅，数据库和内核实例只存在于工作线程。 */
import type { OpInput, OpName, OpOutput } from '@cognition-tree/kernel/catalog/contracts';
import type { DailyActor, ErrorCode, Revision } from '@cognition-tree/kernel/types';
import type { WorkspaceTreeDirectory } from '../../types/wire';

/** 已提交变更；revisions 的顺序是本次追加顺序，只用来通知界面读回。 */
export interface CommitNotice { treeId: string; stamp: number; revisions: Revision[] }
export type Request = { kind: 'close' } | {
  kind: 'call'; id: number; root: string; actor: DailyActor; op: OpName; input: OpInput[OpName];
} | {
  /** 工作区导航读取，不属于单树 catalog，也不赋予 AI 新能力。 */
  kind: 'listTrees'; id: number; root: string;
};
export type Reply =
  | { kind: 'commit'; root: string; change: CommitNotice }
  | { kind: 'ok'; id: number; value: OpOutput[OpName] | WorkspaceTreeDirectory }
  | { kind: 'error'; id: number; code: ErrorCode; message: string };
