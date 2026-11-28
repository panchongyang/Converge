/** 离线检查交付包，而非在正在使用的 DSH 中安装。客户端只注册真实工厂和槽位，不渲染 UI。 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';

const stage = new URL('../../../../.local-work/dsh-plugin/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', stage), 'utf8'));
assert.equal(manifest.license, 'BSD-3-Clause');
const source = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.engines.dsh, source.engines.dsh);
assert.ok(manifest.repository?.url && manifest.homepage && manifest.bugs?.url);
assert.deepEqual(manifest.repository, source.repository);
assert.equal(manifest.homepage, source.homepage);
assert.deepEqual(manifest.bugs, source.bugs);
const packagedReadme = await readFile(new URL('README.md', stage), 'utf8');
assert.equal(packagedReadme, await readFile(new URL('../npm-README.md', import.meta.url), 'utf8'));
assert.ok(packagedReadme.includes(`dsh plugin --profile web add ${manifest.name}`));
const packagedLicense = await readFile(new URL('LICENSE', stage), 'utf8');
assert.equal(packagedLicense, await readFile(new URL('../../../../LICENSE', import.meta.url), 'utf8'));
for (const name of ['cognition-tree-autonomy', 'incremental-formalization']) {
  const skillFile = `skills/${name}/SKILL.md`;
  const packagedSkill = await readFile(new URL(skillFile, stage));
  const canonicalSkill = await readFile(new URL(`../${skillFile}`, import.meta.url));
  assert.ok(packagedSkill.equals(canonicalSkill), `随包 skill 与源码不一致：${name}`);
  assert.match(packagedSkill.toString('utf8'), new RegExp(
    `^---\\r?\\nname: ${name}\\r?\\ndescription: [^\\r\\n]+\\r?\\nwhenToUse: [^\\r\\n]+\\r?\\n---\\r?\\n`,
  ));
}
const patch = await readFile(new URL(manifest.dsh.bundle.patch, stage), 'utf8');
assert.ok(patch.includes(`name: ${manifest.name}`));
const host = await import(new URL(manifest.exports['.'], stage));
assert.equal(typeof host.apply, 'function');
assert.ok(Array.isArray(host.inject));
assert.ok((await stat(new URL('lib/worker.js', stage))).size > 0);

// 在无 DOM 的 JS 沙箱中执行客户端产物：执行脚本只应向宿主登记 factory，绝不打开数据库或触碰页面。
let registered;
const sandbox = createContext({ window: { __ModuleLoader__: { load(record) { assert.equal(registered, undefined); registered = record; } } } });
const bundle = await readFile(new URL(manifest.exports['./client'], stage), 'utf8');
// 不是只藏起按钮：交付包不应携带 Converge 手稿或项目专用的导入表单。
assert.ok(!bundle.includes('认知树（实验性自举）') && !bundle.includes('导入 T1 手稿'), '客户端仍携带项目手稿或导入入口');
new Script(bundle, { filename: 'isolated-cognition-client.js' }).runInContext(sandbox);
assert.equal(registered?.id, manifest.name);
const requireHere = createRequire(import.meta.url);
const externals = new Set();
const client = registered.factory(id => {
  // 这些模块是宿主提供的单例。此处复用同版本开发依赖，只验证发布包的加载协议。
  assert.ok(['react', 'react/jsx-runtime', 'react-dom'].includes(id), `客户端依赖了非宿主模块：${id}`);
  externals.add(id); return requireHere(id);
});
assert.deepEqual([...externals].sort(), ['react', 'react-dom', 'react/jsx-runtime']);
const slots = [];
client.apply({ layout: { selectPanel() {} }, slots: {
  inject(_slot, setup) { return setup(); },
  register(descriptor, component) { assert.equal(typeof component, 'function'); slots.push(descriptor); return () => {}; },
} });
assert.ok(slots.some(slot => slot.name === 'main' && slot.key === 'cognition-tree'));
assert.ok(slots.some(slot => slot.name === 'sidebar.panellist' && slot.id === 'cognition-tree'));
assert.deepEqual(slots.filter(slot => slot.name === 'tool.call.toolview').map(slot => slot.key).sort(), ['cognition_tree_add_branch','cognition_tree_decide_node']);
console.log('发布包可加载；服务端注入：', host.inject, '客户端复用：', [...externals], '槽位：', slots.map(s => `${s.name}:${s.key ?? s.id}`));
