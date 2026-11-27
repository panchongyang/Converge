/**
 * 节点详情：readNode 的结果，也可随 readView 的节点行返回。
 *
 * 职责：把已保存节点与 currentChange 所指的形成记录全文放在一起，供人在确认前审阅。
 * 边界：只含指定节点本身，不夹带邻居或历史；currentChange 只能填新写的形成记录，
 * 确认记录或导入记录不能冒充。
 * 协作：依赖 node 与 revision 两个主题文件，是数据形状里唯一同时需要两者的读结果；
 * 本文件不反向被这两者引用，index 统一转出。
 */
import type { CognitionNode } from './node';
import type { FormationRevision } from './revision';

/**
 * readNode 的结果。
 * 没有日常变更的导入判断省略 currentChange；其余历史用 readHistory。
 */
export interface NodeDetail {
  node: CognitionNode;
  /**
   * node.currentChange 指针指向的那条形成记录全文，供人在确认前看清这次变更做了什么。
   * 类型限定为新写形成记录，不让确认记录或导入记录填进来。
   */
  currentChange?: FormationRevision;
}
