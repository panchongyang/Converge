import { defineConfig } from 'vitest/config';

/** 只运行适配和协议测试；不连接正在使用的 DSH、不运行 UI 探针。 */
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
