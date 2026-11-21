import { defineConfig } from 'vitest/config';

/** 内核包的测试入口：在 Node 测试运行器内执行真实命令、查询与事务；不启动浏览器、磁盘数据库或 DSH。 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
