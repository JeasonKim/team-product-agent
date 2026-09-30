import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationDirectory } from '../src/infra/paths.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(browserFails = false) {
  const root = await mkdtemp(join(tmpdir(), 'agent-startup-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  const opened = join(root, 'opened.json');
  await writeFile(join(bin, 'open'), `#!${process.execPath}
const fs = require('node:fs');
const url = new URL(process.argv[2]);
fetch(new URL('/api/state', url), { headers: { authorization: 'Bearer ' + url.hash.slice(7) } })
  .then(r => r.json()).then(state => {
    fs.writeFileSync(${JSON.stringify(opened)}, JSON.stringify({ origin: url.origin, health: state.health }));
    process.exit(${browserFails ? 1 : 0});
  }).catch(error => { console.error(error.message); process.exit(1); });
`, { mode: 0o755 });
  const lark = join(bin, 'test-lark');
  await writeFile(lark, `#!${process.execPath}
process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');
process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
  await writeFile(join(root, 'agent.config.json'), JSON.stringify({ dataDirectory: './data', projects: [{ id: 'demo', name: '启动验证', repository: root, ownerIds: ['local-owner'], checks: [{ name: 'unused', argv: ['true'] }] }] }));
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address(); if (!address || typeof address === 'string') throw new Error('无法分配测试端口');
  const port = address.port; await new Promise<void>(resolve => socket.close(() => resolve()));
  function start(args: string[] = [], credentials = true) {
    let log = '';
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(applicationDirectory, 'src/cli.ts'), ...args, '--port', String(port)], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FEISHU_CLI_PROFILE: credentials ? 'startup-test' : '', FEISHU_CLI_PATH: lark, FEISHU_APP_ID: '', FEISHU_APP_SECRET: '', FEISHU_BOT_OPEN_ID: 'test-bot' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    async function stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      try { await expect.poll(() => child.exitCode ?? child.signalCode, { timeout: 5000 }).not.toBeNull(); }
      finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    }
    cleanups.push(stop);
    async function ready() {
      await expect.poll(() => {
        if (child.exitCode !== null) throw new Error(`服务提前退出：${log}`);
        return log.includes('服务已启动') || log.includes('本地执行队列已启动');
      }, { timeout: 8000 }).toBe(true);
      const url = new URL((await readFile(join(root, 'data/admin.url'), 'utf8')).trim());
      return (await fetch(new URL('/api/state', url), { headers: { authorization: `Bearer ${url.hash.slice(7)}` } })).json();
    }
    return { child, ready, stop, log: () => log };
  }
  return { root, opened, start };
}

// 飞书订阅与系统浏览器使用进程替身，真实启动 CLI、HTTP 后台和 SQLite；不调用模型。
describe.skipIf(process.platform !== 'darwin')('一键启动与终端调试', () => {
  it('默认启动飞书和后台，服务就绪后打开浏览器；Ctrl+C 清理服务和锁', async () => {
    const f = await fixture(); const run = f.start();
    expect((await run.ready()).health.feishu).toBe('connected');
    await expect.poll(() => existsSync(f.opened)).toBe(true);
    const opened = JSON.parse(await readFile(f.opened, 'utf8'));
    expect(opened.health.worker).toBe('running'); expect(opened.health.feishu).toBe('connected');
    expect(run.log()).not.toContain('#token=');
    await run.stop('SIGINT');
    expect(run.child.exitCode).toBe(0); expect(existsSync(join(f.root, 'data/worker.lock'))).toBe(false);
    await expect(fetch(opened.origin)).rejects.toThrow();
  }, 15_000);
  it('显式 serve 保持原行为，不自动连接飞书或打开浏览器', async () => {
    const f = await fixture(); const run = f.start(['serve']);
    expect((await run.ready()).health.feishu).toBe('disabled');
    expect(existsSync(f.opened)).toBe(false);
  }, 15_000);
  it('默认入口可关闭飞书与自动打开，用于本地调试', async () => {
    const f = await fixture(); const run = f.start(['--no-feishu', '--no-open']);
    expect((await run.ready()).health.worker).toBe('running');
    expect((await run.ready()).health.feishu).toBe('disabled'); expect(existsSync(f.opened)).toBe(false);
  }, 15_000);
  it('浏览器打开失败时保留服务并说明重新打开方式', async () => {
    const f = await fixture(true); const run = f.start();
    await run.ready();
    await expect.poll(() => run.log()).toContain('pnpm admin');
    expect((await run.ready()).health.worker).toBe('running'); expect(run.child.exitCode).toBeNull();
  }, 15_000);
  it('连接启动失败时不打开浏览器，并释放工作进程锁', async () => {
    const f = await fixture(); const run = f.start([], false);
    await expect.poll(() => run.child.exitCode, { timeout: 8000 }).toBe(1);
    expect(run.log()).toContain('FEISHU_APP_ID'); expect(existsSync(f.opened)).toBe(false);
    expect(existsSync(join(f.root, 'data/worker.lock'))).toBe(false);
  }, 15_000);
  it('重复启动明确报错，已有服务继续运行', async () => {
    const f = await fixture(); const first = f.start(['--no-feishu', '--no-open']); await first.ready();
    const second = f.start();
    await expect.poll(() => second.child.exitCode, { timeout: 8000 }).toBe(1);
    expect(second.log()).toContain('已有服务运行'); expect((await first.ready()).health.worker).toBe('running');
  }, 15_000);
});
