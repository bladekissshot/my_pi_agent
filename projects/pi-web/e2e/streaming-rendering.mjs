// Production-browser regression/measurement with synthetic SSE and mocked APIs.
// Never prompts a model or reads the server's real sessions.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:30141';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use a local Pi Web server');
const measureOnly = process.argv.includes('--measure-only');
const artifacts = new URL('../test-results/streaming-rendering/', import.meta.url);
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = 'rendering-fixture';
  const cwd = 'C:/rendering-fixture';
  const timestamp = '2026-01-01T00:00:00.000Z';
  const row = { id, path: cwd + '/fixture.jsonl', cwd, projectRoot: cwd, projectKey: cwd, name: 'Rendering fixture', created: timestamp, modified: timestamp, messageCount: 1, firstMessage: 'Render a streaming response' };
  const messages = [{ role: 'user', content: 'Render a streaming response', timestamp: 1767225600000 }];
  let active = false;
  const api = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    api.push(p);
    let json = {};
    if (p === '/api/sessions') json = { sessions: [row], version: 1 };
    else if (p === '/api/sessions/ui-state') json = { version: 1, revision: 1, sessions: {}, projects: {}, projectOrder: [cwd] };
    else if (p === '/api/agent/running') json = { runningSessionIds: active ? [id] : [], awaitingInputSessionIds: [], completionNotificationSuppressedSessionIds: [], subagentsActiveSessionIds: [], sessionListVersion: 1, sessionUiStateRevision: 1, serverNow: Date.now() };
    else if (p === `/api/sessions/${id}`) json = { session: row, header: { ...row, type: 'session', version: 3 }, tree: [], leafId: 'user1', context: { messages, entryIds: messages.map((_, i) => `entry${i}`), oldestEntryId: 'entry0', hasMore: false, turnsBefore: 0, thinkingLevel: 'off', model: null }, stats: { userMessages: 1, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }, totalActiveMs: 0 };
    else if (p === `/api/sessions/${id}/state` || p === `/api/agent/${id}`) json = { running: active, state: { isStreaming: active, isPromptRunning: active, messages: [], model: null, thinkingLevel: 'off' } };
    else if (p.endsWith('/lease')) json = { running: active, awaitingInput: false, subagentsActive: false };
    else if (p === '/api/models') json = { models: {}, modelList: [], defaultModel: null };
    else if (p === '/api/home') json = { home: 'C:/' };
    else if (p === '/api/cwd/validate') json = { valid: true, cwd, projectRoot: cwd, projectKey: cwd };
    else if (p === '/api/worktrees') json = { worktrees: [] };
    else if (p.startsWith('/api/files/')) json = { entries: [] };
    else if (p === '/api/git/status') json = { files: [], isGitRepo: false };
    else if (p === '/api/web-auth') json = { enabled: false, authenticated: true };
    await route.fulfill({ json });
  });
  await page.addInitScript(() => {
    window.__streams = [];
    class MockEventSource extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      constructor(url) {
        super(); this.url = String(url); this.readyState = 1;
        window.__streams.push(this);
        setTimeout(() => { this.dispatchEvent(new Event('open')); this.emit({ type: 'connected', isStreaming: false }); }, 30);
      }
      emit(data) { if (this.readyState !== 1) return; const event = new MessageEvent('message', { data: JSON.stringify(data) }); this.onmessage?.(event); this.dispatchEvent(event); }
      close() { this.readyState = 2; }
    }
    window.EventSource = MockEventSource;
  });
  await page.goto(`${base}/?session=${id}`);
  await page.waitForFunction(() => window.__streams?.some(s => s.url.includes('/api/agent/') && s.readyState === 1));
  await page.getByText('Render a streaming response', { exact: true }).last().waitFor();
  await page.waitForTimeout(1500);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const getMetrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  active = true;
  const before = await getMetrics();
  if (process.env.E2E_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  const workload = await page.evaluate(async () => {
    const stream = window.__streams.find(s => s.url.includes('/api/agent/') && s.readyState === 1);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const message = { role: 'assistant', provider: 'test', model: 'test-model', timestamp: Date.now(), content: [] };
    stream.emit({ type: 'agent_start' });
    stream.emit({ type: 'message_start', message });
    const delta = event => stream.emit({ type: 'message_update', assistantMessageEvent: event });
    delta({ type: 'text_start', contentIndex: 0 });
    let text = '# Streaming rendering test\n\n| Key | Value |\n| --- | --- |\n' + Array.from({ length: 80 }, (_, i) => `| Initial ${i} | 一段包含中文与 **Markdown** 的测试内容，用于测量更新开销。 |\n`).join('');
    delta({ type: 'text_delta', contentIndex: 0, delta: text });
    await pause(1000);
    let mutations = 0;
    let longTasks = [];
    const observer = new MutationObserver(() => mutations++);
    observer.observe(document.querySelector('[data-message-role="assistant"]').parentElement, { childList: true, characterData: true, subtree: true });
    const tasks = new PerformanceObserver(list => { longTasks.push(...list.getEntries().map(e => e.duration)); });
    tasks.observe({ type: 'longtask' });
    const started = performance.now();
    for (let i = 0; i < 240; i++) {
      const chunk = `| Row ${i} | 持续输出中文数据以及 \`code_${i}\`，更新当前消息。 |\n`;
      text += chunk;
      delta({ type: 'text_delta', contentIndex: 0, delta: chunk });
      await pause(10);
    }
    delta({ type: 'text_end', contentIndex: 0, content: text });
    await pause(200);
    observer.disconnect(); tasks.disconnect();
    return { durationMs: performance.now() - started, mutations, longTasks: longTasks.length, longTaskMs: longTasks.reduce((a,b)=>a+b,0), longestTaskMs: Math.max(0,...longTasks), rows: document.querySelectorAll('.markdown-body tr').length, chars: text.length, text };
  });
  const after = await getMetrics();
  if (process.env.E2E_PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    await fs.writeFile(new URL('rendering.cpuprofile', artifacts), JSON.stringify(profile));
  }
  const { text, ...measurement } = workload;
  const result = { base, workload: measurement, metrics: Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].map(key => [key, after[key] - before[key]])), errors, api: [...new Set(api)] };
  await fs.writeFile(new URL('metrics.json', artifacts), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(workload.rows, 321, 'all streamed rows must be present exactly once');
  assert.deepEqual(errors, []);
  if (!measureOnly) assert.ok(workload.mutations < 150, `too many DOM updates for 240 chunks: ${workload.mutations}`);

  // A lone chunk must still follow the tail even when no next SSE event arrives.
  // Scrolling upward must detach follow mode and leave the reader in place.
  const scrolling = await page.evaluate(async () => {
    const stream = window.__streams.find(s => s.url.includes('/api/agent/') && s.readyState === 1);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const scroller = document.querySelector('[data-message-role="assistant"]').closest('.overflow-y-auto');
    scroller.scrollTop = scroller.scrollHeight;
    await pause(100);
    const first = '\n\n' + 'A lone delayed chunk must follow the tail.\n\n'.repeat(12);
    stream.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: first } });
    await pause(250);
    const tailGap = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 700);
    await pause(100);
    const readingTop = scroller.scrollTop;
    const second = '\n\n' + 'Keep the reading position while output continues.\n\n'.repeat(12);
    stream.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: second } });
    await pause(250);
    return { tailGap, readingShift: Math.abs(scroller.scrollTop - readingTop), suffix: first + second };
  });
  assert.ok(scrolling.tailGap <= 2, `paused output left a ${scrolling.tailGap}px tail gap`);
  assert.ok(scrolling.readingShift <= 2, 'streaming must not move a reader who scrolled up');

  // End with a delta still queued: the final authoritative message wins, with
  // no ghost reply or missing text after the notification window has passed.
  const completed = { role: 'assistant', provider: 'test', model: 'test-model', timestamp: Date.now(), content: [{ type: 'text', text: text + scrolling.suffix + '\n\nFinal authoritative marker.' }] };
  messages.push(completed);
  active = false;
  await page.evaluate(completed => {
    const stream = window.__streams.find(s => s.url.includes('/api/agent/') && s.readyState === 1);
    stream.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '\n\nStale queued marker.' } });
    stream.emit({ type: 'message_end', message: completed });
    stream.emit({ type: 'agent_end' });
    stream.emit({ type: 'agent_settled' });
  }, completed);
  await page.getByText('Final authoritative marker.', { exact: true }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('[data-message-role="assistant"]').count(), 1);
  assert.equal(await page.getByText('Stale queued marker.', { exact: true }).count(), 0);
  assert.equal(await page.locator('.markdown-body tr').count(), 321);
  assert.deepEqual(errors, []);
  console.log('PASS: complete output, bounded renders, paused-stream tail following, reading position and immediate completion');
} finally { await browser.close(); }
