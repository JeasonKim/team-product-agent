import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CheckCommand, Project } from '../config.js';
import type { CheckResult, Edit } from '../domain/model.js';
import { validateRelativePath } from '../domain/policy.js';
import { executeCommand } from './process.js';

interface PreparedEdit { absolutePath: string; before: string | null; after: string | null; mode: number }
export async function assertSafePath(root: string, path: string): Promise<string> {
  validateRelativePath(path);
  let current = resolve(root);
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error(`禁止沿符号链接访问：${path}`);
  }
  return current;
}
export async function applyEdits(root: string, edits: Edit[], allowedPaths: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const prepared: PreparedEdit[] = [];
  const seen = new Set<string>();
  // 先验证整个变更批次，避免后续编辑冲突导致部分落盘。
  for (const edit of edits) {
    signal?.throwIfAborted();
    if (!allowedPaths.includes(edit.path)) throw new Error(`编辑超出已审定范围：${edit.path}`);
    if (seen.has(edit.path)) throw new Error(`一个批次每个文件只能出现一次：${edit.path}`);
    seen.add(edit.path);
    const absolutePath = await assertSafePath(root, edit.path);
    const before = await readFile(absolutePath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    let after: string | null;
    if (edit.before === null) {
      if (before !== null || edit.after === null) throw new Error(`新文件已存在或内容为空：${edit.path}`);
      after = edit.after;
    } else {
      if (before === null || !edit.before || before.split(edit.before).length !== 2) throw new Error(`before 必须在文件中唯一匹配：${edit.path}`);
      if (edit.after === null && edit.before !== before) throw new Error('删除必须匹配整个文件');
      after = edit.after === null ? null : before.replace(edit.before, () => edit.after!);
    }
    if (after !== null && Buffer.byteLength(after) > 2_000_000) throw new Error('单文件超过 2 MB 限制');
    const mode = before === null ? 0o644 : (await lstat(absolutePath)).mode & 0o777;
    prepared.push({ absolutePath, before, after, mode });
  }
  const applied: PreparedEdit[] = [];
  try {
    for (const edit of prepared) {
      signal?.throwIfAborted();
      if (edit.after === null) await unlink(edit.absolutePath);
      else {
        await mkdir(dirname(edit.absolutePath), { recursive: true });
        const temporary = `${edit.absolutePath}.agent-${randomUUID()}`;
        await writeFile(temporary, edit.after, { mode: edit.mode });
        await rename(temporary, edit.absolutePath);
      }
      applied.push(edit);
      signal?.throwIfAborted();
    }
  } catch (error) {
    console.warn('编辑批次落盘失败，恢复本批次已改文件', { applied: applied.map(edit => edit.absolutePath), reason: String(error) });
    for (const edit of applied.reverse()) {
      if (edit.before === null) await unlink(edit.absolutePath);
      else await writeFile(edit.absolutePath, edit.before);
    }
    throw error;
  }
}
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await executeCommand({ name: 'git', argv: ['git', ...args], timeoutMs: 60_000 }, cwd, signal, 32_000_000);
  if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error(`Git 操作失败或输出超过限制：${result.output.slice(-2000)}`);
  return result.output;
}
export interface PreparedWorkspace { path: string; baseCommit: string }
export async function prepareWorkspace(project: Project, taskDirectory: string, signal: AbortSignal): Promise<PreparedWorkspace> {
  const path = join(taskDirectory, 'workspace');
  await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  const baseCommit = (await git(project.repository, ['rev-parse', 'HEAD'], signal)).trim();
  await git(taskDirectory, ['clone', '--no-hardlinks', '--no-checkout', '--', project.repository, path], signal);
  await git(path, ['checkout', '--detach', baseCommit], signal);
  await git(path, ['remote', 'remove', 'origin'], signal);
  for (const command of project.setup) {
    const result = await executeCommand(command, path, signal);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`环境准备失败 ${command.name}：${result.output}`);
  }
  return { path, baseCommit };
}
export async function runChecks(commands: CheckCommand[], cwd: string, signal: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    signal.throwIfAborted();
    results.push(await executeCommand(command, cwd, signal));
  }
  return results;
}
export function allChecksPassed(checks: CheckResult[]): boolean { return checks.length > 0 && checks.every(check => check.exitCode === 0 && !check.timedOut && !check.signal); }
export async function capturePatch(cwd: string, signal?: AbortSignal): Promise<string> {
  await git(cwd, ['add', '--intent-to-add', '--all'], signal);
  return git(cwd, ['diff', '--binary', 'HEAD', '--'], signal);
}
