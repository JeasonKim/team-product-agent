import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAdmin } from '../src/admin/open.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'agent-admin-open-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function endpoint(status = 200) {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request); response.writeHead(status); response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败');
  return { origin: `http://127.0.0.1:${address.port}`, requests, server };
}

describe('从本机配置打开管理后台', () => {
  const token = 'a'.repeat(64);
  it('未启动过时说明启动方式，不打开浏览器', async () => {
    const launch = vi.fn();
    await expect(openAdmin(await directory(), launch)).rejects.toThrow('pnpm serve');
    expect(launch).not.toHaveBeenCalled();
  });
  it('只向本机地址验证令牌，然后打开完整链接', async () => {
    const dir = await directory(); const { origin, requests } = await endpoint();
    const url = `${origin}/#token=${token}`; const launch = vi.fn().mockResolvedValue(undefined);
    await writeFile(join(dir, 'admin.url'), `${url}\n`);
    await expect(openAdmin(dir, launch)).resolves.toBe(origin);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/api/state');
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(launch).toHaveBeenCalledWith(url);
  });
  it.each([
    `https://example.com/#token=${token}`,
    `http://127.0.0.1:4318@evil.example/#token=${token}`,
    'http://127.0.0.1:4318/#token=invalid',
    `http://127.0.0.1:4318/?redirect=external#token=${token}`,
  ])('拒绝错误的管理链接 %s', async url => {
    const dir = await directory(); const launch = vi.fn();
    await writeFile(join(dir, 'admin.url'), url);
    await expect(openAdmin(dir, launch)).rejects.toThrow('管理链接格式无效');
    expect(launch).not.toHaveBeenCalled();
  });
  it('服务重启使旧令牌失效时，给出可操作的错误', async () => {
    const dir = await directory(); const { origin } = await endpoint(401); const launch = vi.fn();
    await writeFile(join(dir, 'admin.url'), `${origin}/#token=${token}`);
    await expect(openAdmin(dir, launch)).rejects.toThrow('管理链接已失效');
    expect(launch).not.toHaveBeenCalled();
  });
  it('服务停止时要求先启动，不打开空白后台', async () => {
    const dir = await directory(); const { origin, server } = await endpoint();
    await new Promise<void>(resolve => server.close(() => resolve())); cleanup.pop();
    await writeFile(join(dir, 'admin.url'), `${origin}/#token=${token}`);
    const launch = vi.fn();
    await expect(openAdmin(dir, launch)).rejects.toThrow('pnpm serve');
    expect(launch).not.toHaveBeenCalled();
  });
  it('系统打开失败时错误不泄漏令牌', async () => {
    const dir = await directory(); const { origin } = await endpoint();
    await writeFile(join(dir, 'admin.url'), `${origin}/#token=${token}`);
    const launch = vi.fn().mockRejectedValue(new Error(`open failed: ${token}`));
    await expect(openAdmin(dir, launch)).rejects.toThrow(/^无法打开浏览器/);
    await expect(openAdmin(dir, launch)).rejects.not.toThrow(token);
  });
});
