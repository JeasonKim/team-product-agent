import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdits } from '../src/infra/workspace.js';

describe('受控代码落盘', () => {
  it('先校验整批编辑，冲突时不留下半批改动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-edits-'));
    await writeFile(join(root, 'one.ts'), 'const value = 1;');
    await writeFile(join(root, 'two.ts'), 'same same');
    await expect(applyEdits(root, [
      { path: 'one.ts', before: '1', after: '2' },
      { path: 'two.ts', before: 'same', after: 'new' },
    ], ['one.ts', 'two.ts'])).rejects.toThrow(/唯一/);
    expect(await readFile(join(root, 'one.ts'), 'utf8')).toBe('const value = 1;');
  });
  it('支持精确替换和新文件，不允许超出已审定范围', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-edits-'));
    await writeFile(join(root, 'one.ts'), 'const value = 1;');
    await applyEdits(root, [{ path: 'one.ts', before: '1', after: '2' }, { path: 'new.ts', before: null, after: 'export {};' }], ['one.ts', 'new.ts']);
    expect(await readFile(join(root, 'one.ts'), 'utf8')).toContain('2');
    await expect(applyEdits(root, [{ path: 'secret.ts', before: null, after: 'bad' }], ['one.ts'])).rejects.toThrow(/范围/);
  });
  it('不沿符号链接逃逸工作副本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-edits-'));
    const outside = await mkdtemp(join(tmpdir(), 'agent-outside-'));
    await writeFile(join(outside, 'victim.ts'), 'original');
    await mkdir(join(root, 'src'));
    await symlink(outside, join(root, 'src', 'escape'));
    await expect(applyEdits(root, [{ path: 'src/escape/victim.ts', before: 'original', after: 'bad' }], ['src/escape/victim.ts'])).rejects.toThrow(/符号链接/);
    expect(await readFile(join(outside, 'victim.ts'), 'utf8')).toBe('original');
  });
  it('修改脚本时保留执行位', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-edits-'));
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho before\n', { mode: 0o755 });
    await applyEdits(root, [{ path: 'run.sh', before: 'before', after: 'after' }], ['run.sh']);
    expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755);
  });
});
