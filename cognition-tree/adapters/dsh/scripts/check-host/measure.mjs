/**
 * check-host 的进程级采样：Worker/RSS、钩子快照、分位数、路由与事件循环延迟、SSE。
 * 只读进程事实，不改宿主或插件状态；样本是进程内真实注册表与 worker 的观察。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PROBE_PATH } from './sdk.mjs';


/** 当前 Node 报告里的 Worker 数量；用于证明空闲未启动线程。 */
export function workerCount() {
  return process.report.getReport().workers?.length ?? 0;
}

/** 当前进程的 RSS 字节数。 */
export function rssBytes() {
  return process.memoryUsage().rss;
}

/**
 * 结构化快照进程级钩子与资源，用于注册/卸载前后的差分。
 * @returns 事件监听、globalThis 键、活动资源与 Worker 数
 */
export function snapshotProcess() {
  const events = Object.fromEntries(
    process.eventNames().map(name => [String(name), process.listenerCount(name)]),
  );
  const resources = {};
  for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
  return {
    events,
    globals: Object.keys(globalThis).sort(),
    resources,
    workers: workerCount(),
    rss: rssBytes(),
  };
}

/**
 * 比较两个进程快照，只报告实际差异。
 * @param before 注册前快照
 * @param after 卸载后快照
 * @returns 事件、全局键、活动资源与 Worker 差异
 */
export function diffSnapshot(before, after) {
  const eventNames = new Set([...Object.keys(before.events), ...Object.keys(after.events)]);
  const eventDiffs = [];
  for (const name of eventNames) {
    const left = before.events[name] ?? 0;
    const right = after.events[name] ?? 0;
    if (left !== right) eventDiffs.push({ name, before: left, after: right });
  }
  const beforeGlobals = new Set(before.globals);
  const afterGlobals = new Set(after.globals);
  const resourceNames = new Set([...Object.keys(before.resources), ...Object.keys(after.resources)]);
  const resourceDiffs = [];
  for (const name of resourceNames) {
    const left = before.resources[name] ?? 0;
    const right = after.resources[name] ?? 0;
    if (left !== right) resourceDiffs.push({ name, before: left, after: right });
  }
  return {
    eventDiffs,
    globalsAdded: after.globals.filter(name => !beforeGlobals.has(name)),
    globalsRemoved: before.globals.filter(name => !afterGlobals.has(name)),
    resourceDiffs,
    workerDelta: after.workers - before.workers,
  };
}

/**
 * 计算样本分位数；样本为空时返回 0。
 * @param samples 数值样本
 * @param ratio 0..1 分位
 * @returns 分位值
 */
export function percentile(samples, ratio) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

/**
 * 汇总一组毫秒样本。
 * @param samples 毫秒样本
 * @returns 计数、均值、p50、p95、最大值
 */
export function summarize(samples) {
  const mean = samples.length === 0 ? 0 : samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    n: samples.length,
    meanMs: round(mean),
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    maxMs: round(samples.length === 0 ? 0 : Math.max(...samples)),
  };
}

/** 保留三位小数，便于报告比对。 */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 顺序测量无关路由在内存中的分发耗时。
 * @param dispatch createDispatcher 的返回值
 * @param count 样本数
 * @returns 毫秒摘要
 */
export async function measureDispatch(dispatch, count = 200) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const response = await dispatch(PROBE_PATH);
    if (response.status !== 200) throw new Error(`无关路由在采样中返回 ${response.status}`);
    await response.arrayBuffer();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

/**
 * 采样事件循环相对 2ms 定时器的额外延迟。
 * @param durationMs 采样窗口
 * @returns 毫秒摘要
 */
export async function measureEventLoop(durationMs = 250) {
  const samples = [];
  const started = performance.now();
  let previous = started;
  while (performance.now() - started < durationMs) {
    await new Promise(resolveWait => setTimeout(resolveWait, 2));
    const now = performance.now();
    samples.push(Math.max(0, now - previous - 2));
    previous = now;
  }
  return summarize(samples);
}

/**
 * 读取固定路径文件的 SHA-256，用于把报告钉在具体构建产物上。
 * @param file 绝对路径
 * @returns 十六进制摘要
 */
export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 断言路径位于仓库 .local-work 之下，防止夹具写错位置。
 * @param repoRoot 仓库根
 * @param target 待检查绝对路径
 * @returns 规范化路径
 */
export function assertInsideLocalWork(repoRoot, target) {
  const base = resolve(repoRoot, '.local-work') + sep;
  const normalized = resolve(target);
  if (!normalized.toLowerCase().startsWith(base.toLowerCase())) {
    throw new Error(`拒绝在 .local-work 之外创建数据：${normalized}`);
  }
  return normalized;
}

/**
 * SSE 帧读取器：按空行拆帧，跳过注释心跳；带单帧超时。
 */
export class SseReader {
  /** @param reader ReadableStreamDefaultReader<Uint8Array> */
  constructor(reader) {
    this.reader = reader;
    this.decoder = new TextDecoder();
    this.buffer = '';
  }

  /**
   * 读取下一个事件帧。
   * @param timeoutMs 单帧最长等待
   * @returns 解析后的 {event, data}
   */
  async next(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        if (frame.startsWith(':') || frame.trim() === '') continue;
        return parseFrame(frame);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('等待 SSE 帧超时');
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待 SSE 帧超时')), remaining);
        timer.unref?.();
      });
      let read;
      try {
        read = await Promise.race([this.reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (read.done) throw new Error('SSE 流在收到预期帧前结束');
      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }
}

/**
 * 把一帧 SSE 文本解析为事件名与数据。
 * @param frame 不含结束空行的帧
 * @returns {event, data}
 */
function parseFrame(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}
