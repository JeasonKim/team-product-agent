import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexReadOnlyFilesystem } from '../src/adapters/codex.js';
import { executeCommand } from '../src/infra/process.js';
import { applicationDirectory } from '../src/infra/paths.js';

describe.skipIf(process.platform !== 'darwin')('Mac 原生 Codex 运行时权限（不调用模型）', () => {
  it('能读工作副本，不能写文件、读取副本外文件或 .env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sandbox-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'allowed.txt'), 'allowed');
    await writeFile(join(workspace, '.env'), 'test secret');
    await writeFile(join(root, 'outside.txt'), 'outside');
    const check = await executeCommand({
      name: '实际只读沙箱', timeoutMs: 20_000,
      argv: [process.execPath, join(applicationDirectory, 'resources/codex-launcher.mjs'), 'sandbox', '-P', 'team_agent_read', '-C', workspace, '-c', codexReadOnlyFilesystem(workspace), '-c', 'permissions.team_agent_read.network.enabled=false', '--', '/bin/sh', '-c', 'cat allowed.txt; if cat ../outside.txt 2>/dev/null; then exit 31; fi; if touch forbidden 2>/dev/null; then exit 32; fi; if cat .env 2>/dev/null; then exit 33; fi'],
    }, applicationDirectory);
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toBe('allowed');
  }, 30_000);
});
