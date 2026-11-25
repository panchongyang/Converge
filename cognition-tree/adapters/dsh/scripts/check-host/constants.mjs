/** check-host 的固定契约：插件路径、AI 工具面及人侧 exact 路由。 */
export const TREES_PATH = '/api/cognition-tree/trees';
export const CALL_PATH = '/api/cognition-tree/call';
export const WATCH_PATH = '/api/cognition-tree/watch';
export const WORKER_WAIT_MS = 8000;
/** 公开 AI 工具包含空白建树；确认、批量导入与单点 read_node 都不暴露。 */
export const AI_TOOLS = [
  'cognition_tree_create_tree',
  'cognition_tree_add_branch',
  'cognition_tree_decide_node',
  'cognition_tree_read_view',
  'cognition_tree_read_history',
  'cognition_tree_read_unconfirmed',
];
