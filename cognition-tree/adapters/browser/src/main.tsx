/**
 * 认知树独立浏览器入口。
 *
 * 装配：页内运行正式内核 + localStorage 测试存储（env），把人侧 client 与浏览器宿主桥交给共用
 * 应用壳；开发坞（AI 模拟器、存储与预算）与出处阅读器是浏览器专有部分，DSH 嵌入时不会出现。
 * 样例 T1 由人在空状态里点击导入，导入走正式 bootstrapTree，不覆盖已存在的树。
 */
import { createRoot } from 'react-dom/client';
import { App } from '@cognition-tree/ui/app';
import { createBrowserEnv } from './adapter/env';
import { DevDock } from './adapter/dock/DevDock';
import { SourceReader } from './adapter/source/SourceReader';
import { createT1Seed } from './fixtures/t1-seed';
import { applyTheme, readTheme } from './adapter/dock/theme';

const root = document.getElementById('root');
if (!root) throw new Error('index.html 缺少 #root');

// 先应用保存过的外观（写在 html 与 UI 根两处），避免首帧跳到系统外观之外。
applyTheme(readTheme());

const env = createBrowserEnv({ treeId: 'T1', repoRoot: __REPO_ROOT__ });

createRoot(root).render(
  <>
    <App
      treeId={env.treeId}
      client={env.human}
      bridge={env.bridge}
      bootstrap={{
        label: '导入样例 T1',
        describe:
          '把仓库根《认知树.md》的手工树（15 个判断、7 条引用、10 条形成与确认记录）装进这个浏览器的 localStorage 测试存储。它是浏览器样例导入，不是正式自举，也不写入 DSH 的工作区数据。',
        seed: createT1Seed,
      }}
      renderDock={(ctx) => <DevDock ctx={ctx} env={env} />}
    />
    <SourceReader reader={env.reader} />
  </>,
);
