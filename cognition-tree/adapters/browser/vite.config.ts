/**
 * 认知树独立浏览器入口的开发、构建与测试配置。
 *
 * - 开发服务只监听本机 127.0.0.1:5317；端口被占用时直接报错，不悄悄换端口。
 * - 构建产物属于试运行产物，写到仓库根 .local-work/browser-dist/，不进 Git。
 * - server.fs.allow 放行 Converge 仓库根，只为开发模式下“打开出处”读取研究材料原文。
 * - React 去重：UI 包与浏览器包互相链接，避免两个 React 实例。
 * - Vitest 只跑 src 下的纯逻辑用例（测试存储、样例与视图投影），不开浏览器。
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: { __REPO_ROOT__: JSON.stringify(repoRoot.replace(/\\/g, '/')) },
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 5317, strictPort: true, fs: { allow: [repoRoot] } },
  preview: { host: '127.0.0.1', port: 5318, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../../../.local-work/browser-dist/', import.meta.url)),
    emptyOutDir: true,
  },
  test: {
    // 浏览器包只跑适配层与样例的纯逻辑用例；不开浏览器，也不做 UI 探针。
    include: ['src/adapter/**/*.test.ts', 'src/fixtures/**/*.test.ts'],
    environment: 'node',
  },
});
