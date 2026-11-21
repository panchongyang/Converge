// 不下载 Chromium：渲染使用本机已安装的 Chrome（见 scripts/render-diagrams.mjs）。
// 任何 puppeteer 自身的缓存也限定在仓库根 .local-work/ 下。
const { join } = require('node:path');

module.exports = {
  skipDownload: true,
  cacheDirectory: join(__dirname, '..', '.local-work', 'puppeteer'),
};
