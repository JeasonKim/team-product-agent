import { spawn } from 'node:child_process';
import type { CheckCommand } from '../config.js';
import type { CheckResult } from '../domain/model.js';

export function minimalEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot', 'JAVA_HOME']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}
export async function executeCommand(command: CheckCommand, cwd: string, signal?: AbortSignal, outputLimit = 80_000): Promise<CheckResult> {
  signal?.throwIfAborted();
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command.argv[0]!, command.argv.slice(1), { cwd, env: minimalEnvironment(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let truncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => { output += chunk.toString(); if (output.length > outputLimit) { truncated = true; output = output.slice(-outputLimit); } };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const terminate = () => {
      const kill = (sig: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, sig); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.warn('终止命令失败', { command: command.name, error: String(error) }); }
      };
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, command.timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', terminate); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (exitCode, exitSignal) => {
      cleanup();
      resolve({ name: command.name, exitCode, signal: exitSignal, timedOut, durationMs: Date.now() - started, output, truncated });
    });
  });
}
