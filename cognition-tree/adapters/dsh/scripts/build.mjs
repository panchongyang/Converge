/**
 * 构建独立可加载的 DSH 包到仓库根 .local-work/dsh-plugin，不安装、不接触 profile。
 * 服务端/工作线程只依赖 Node；客户端以宿主的 ModuleLoader 惰性工厂提供，共享 UI 的 CSS 仅在面板内生效。
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { rolldown } from 'rolldown';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = resolve(root, '../../../.local-work/dsh-plugin');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const hostModules = ['react', 'react/jsx-runtime', 'react-dom'];
const part = process.argv[2] ?? 'all';
if (!['all', 'server', 'client'].includes(part)) throw new Error('构建目标应为 all / server / client');
await mkdir(join(target, 'lib'), { recursive: true });

/** 构建真实 Node ESM 入口；worker.js 与 index.js 同目录，宿主加载时不解析 SQLite。 */
async function server() {
  for (const [name, file] of [['index', 'server/host/index.ts'], ['worker', 'server/backend/worker.ts']]) {
    const bundle = await rolldown({ input: join(root, 'src', file), platform: 'node', external: [/^node:/] });
    try { await bundle.write({ format: 'esm', file: join(target, 'lib', name + '.js'), codeSplitting: false }); }
    finally { await bundle.close(); }
  }
}

/** 把共享样式表的文档级选择器映射到面板内，而不改独立网页原来的 document 语义。@param css 原 CSS */
function insidePanel(css) {
  return css.replace(/:root(\[[^\]]+\])?/g, (_, attr) => attr ? `:host(${attr})` : ':host')
    .replace(/^(?:html|body|#root)(?=\s*[,\{])/gm, '.ct-app');
}

/** 编译 TSX 和样式，不执行模块工厂。DSH 加载器在需要渲染时才给它真实的 React。 */
async function client() {
  const result = await build({ root, configFile: false, logLevel: 'warn', mode: 'production',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'cognition-shadow-roots', enforce: 'pre', transform(code, id) {
      if (id.endsWith('.css')) return { code: insidePanel(code), map: null };
    } }],
    build: { write: false, emptyOutDir: false, minify: false, cssMinify: false,
      lib: { entry: join(root, 'src/client/index.ts'), formats: ['cjs'], fileName: 'client' },
      rolldownOptions: { external: hostModules, output: { exports: 'named', codeSplitting: false } } },
  });
  const files = (Array.isArray(result) ? result : [result]).flatMap(output => output.output);
  const js = files.filter(file => file.type === 'chunk');
  const css = files.filter(file => file.type === 'asset' && file.fileName.endsWith('.css')).map(file => String(file.source)).join('\n');
  if (js.length !== 1 || !css.includes('--ct-ground')) throw new Error('客户端应产出单个 JS 与共享界面令牌。');
  if (js[0].imports.some(id => !hostModules.includes(id))) throw new Error('意外的未打包客户端依赖：' + js[0].imports.join(', '));
  const factory = `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)}, factory:function(require){\n` +
    `const module={exports:{}}; const exports=module.exports;\nconst __COGNITION_PANEL_CSS__=${JSON.stringify(css)};\n` +
    js[0].code + '\nreturn module.exports;\n}});\n';
  await writeFile(join(target, 'lib/client.js'), factory);
}

if (part !== 'client') await server();
if (part !== 'server') await client();
const { name, version, description, license, type, engines, main, exports, dsh } = manifest;
await writeFile(join(target, 'package.json'), JSON.stringify({ name, version, description, license, type, engines, main, exports, dsh }, null, 2) + '\n');
await copyFile(join(root, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'));
await copyFile(new URL('../../../../LICENSE', import.meta.url), join(target, 'LICENSE'));
console.log(`已构建 ${part}：${target}；未安装至 DSH。`);
