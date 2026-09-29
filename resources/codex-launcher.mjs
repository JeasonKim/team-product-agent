#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

// SDK 当前没有 ignore-user-config 选项，通过固定启动器补齐，仍由官方 SDK 管理协议。
const requireSdk = createRequire(import.meta.resolve('@openai/codex-sdk'));
const packagePath = requireSdk.resolve('@openai/codex/package.json');
const args = process.argv.slice(2);
if (args[0] === 'exec') args.splice(1, 0, '--ignore-user-config', '--ignore-rules');
const child = spawn(process.execPath, [join(dirname(packagePath), 'bin', 'codex.js'), ...args], { stdio: 'inherit', detached: true });
const stop = signal => {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') console.error('无法停止 Codex 执行组', error.message); }
};
process.on('SIGTERM', () => { stop('SIGTERM'); const timer = setTimeout(() => stop('SIGKILL'), 1000); timer.unref(); });
process.on('SIGINT', () => stop('SIGINT'));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
