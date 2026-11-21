#!/usr/bin/env node
/**
 * 渲染 cognition-tree/docs/diagrams/*.mmd 为同名 .svg。
 *
 * 一次性重生成四张图：pnpm run diagrams
 *
 * 约束：
 * - 只使用本地已安装的 Chrome，不下载 Chromium；
 * - pnpm store、npm 缓存、浏览器临时 profile、TEMP 等全部落在仓库根 .local-work/；
 * - 可通过环境变量覆盖：CHROME_PATH / PUPPETEER_EXECUTABLE_PATH。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArchitecture } from './render-architecture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..'); // cognition-tree
const repoRoot = resolve(projectRoot, '..'); // Converge 仓库根
const localWork = join(repoRoot, '.local-work');
const diagramDir = join(projectRoot, 'docs', 'diagrams');

const DIRS = {
  temp: join(localWork, 'temp'),
  profile: join(localWork, 'chrome-profile'),
  crash: join(localWork, 'chrome-crash'),
  diskCache: join(localWork, 'chrome-cache'),
  puppeteer: join(localWork, 'puppeteer'),
  xdgCache: join(localWork, 'xdg-cache'),
  xdgConfig: join(localWork, 'xdg-config'),
  xdgData: join(localWork, 'xdg-data'),
};
for (const dir of Object.values(DIRS)) mkdirSync(dir, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : undefined,
  process.env.PROGRAMFILES
    ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : undefined,
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('[diagrams] 未找到 Chrome。请安装 Chrome，或设置 CHROME_PATH 指向 chrome.exe。');
  console.error('[diagrams] 已尝试：');
  for (const p of CHROME_CANDIDATES) console.error('  - ' + p);
  process.exit(1);
}

const cli = join(projectRoot, 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js');
if (!existsSync(cli)) {
  console.error('[diagrams] 未找到 mermaid-cli，请先在 cognition-tree 下运行 pnpm install。');
  process.exit(1);
}

const puppeteerConfigPath = join(localWork, 'puppeteer-config.json');
writeFileSync(
  puppeteerConfigPath,
  JSON.stringify(
    {
      executablePath: chrome,
      headless: true,
      userDataDir: DIRS.profile,
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-breakpad',
        '--font-render-hinting=none',
        '--crash-dumps-dir=' + DIRS.crash,
        '--disk-cache-dir=' + DIRS.diskCache,
      ],
    },
    null,
    2,
  ),
  'utf8',
);

const env = {
  ...process.env,
  TEMP: DIRS.temp,
  TMP: DIRS.temp,
  TMPDIR: DIRS.temp,
  XDG_CACHE_HOME: DIRS.xdgCache,
  XDG_CONFIG_HOME: DIRS.xdgConfig,
  XDG_DATA_HOME: DIRS.xdgData,
  PUPPETEER_CACHE_DIR: DIRS.puppeteer,
  PUPPETEER_EXECUTABLE_PATH: chrome,
  PUPPETEER_SKIP_DOWNLOAD: 'true',
};

const NAMES = ['overall', 'backend', 'frontend', 'structure'];
const failures = [];

console.log('[diagrams] Chrome:', chrome);
console.log('[diagrams] 临时目录:', localWork);

for (const name of NAMES) {
  const input = join(diagramDir, name + '.mmd');
  const output = join(diagramDir, name + '.svg');
  if (!existsSync(input)) {
    failures.push(name + ': 缺少图源 ' + input);
    continue;
  }
  process.stdout.write('[diagrams] 渲染 ' + name + '.mmd -> ' + name + '.svg ... ');
  const source = readFileSync(input, 'utf8');
  if (/^%% layout\s*$/m.test(source)) {
    try {
      writeFileSync(output, renderArchitecture(source), 'utf8');
      console.log('ok（固定布局）');
    } catch (error) {
      console.error('失败：' + error.message);
      failures.push(name);
    }
    continue;
  }

  const result = spawnSync(
    process.execPath,
    [cli, '-i', input, '-o', output, '-p', puppeteerConfigPath, '-b', 'white', '--quiet'],
    { cwd: projectRoot, env, encoding: 'utf8' },
  );
  const ok = result.status === 0 && existsSync(output) && statSync(output).size > 1000;
  if (ok) {
    console.log('ok (' + Math.round(statSync(output).size / 1024) + ' KB)');
  } else {
    console.log('失败');
    if (result.stdout) console.error(result.stdout.trim());
    if (result.stderr) console.error(result.stderr.trim());
    failures.push(name);
  }
}

if (failures.length > 0) {
  console.error('[diagrams] 有 ' + failures.length + ' 张图失败：' + failures.join(', '));
  process.exit(1);
}

// 渲染后自检：SVG 必须含 <svg、viewBox 和至少一段中文文本。
for (const name of NAMES) {
  const svg = readFileSync(join(diagramDir, name + '.svg'), 'utf8');
  const checks = {
    '根元素 <svg': svg.trimStart().startsWith('<svg') || svg.includes('<svg'),
    'viewBox 有效': /viewBox="\s*-?[\d.]+\s+-?[\d.]+\s+([1-9][\d.]*)\s+([1-9][\d.]*)\s*"/.test(svg),
    '中文文本': /[\u4e00-\u9fff]/.test(svg),
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length > 0) {
    console.error('[diagrams] ' + name + '.svg 自检未通过：' + bad.join(', '));
    failures.push(name);
  }
}
if (failures.length > 0) process.exit(1);

console.log('[diagrams] 完成：' + NAMES.map((n) => n + '.svg').join('、'));
