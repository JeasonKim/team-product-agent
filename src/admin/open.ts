import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

type BrowserLauncher = (url: string) => Promise<void>;

const launchBrowser: BrowserLauncher = async url => {
  if (process.platform !== 'darwin') throw new Error('自动打开后台目前支持 macOS');
  await promisify(execFile)('open', [url], { timeout: 5000 });
};

export async function openAdmin(dataDirectory: string, launch: BrowserLauncher = launchBrowser): Promise<string> {
  let saved: string;
  try { saved = (await readFile(join(dataDirectory, 'admin.url'), 'utf8')).trim(); }
  catch (error) { throw new Error('无法读取管理链接，请先在另一个终端运行 pnpm serve。', { cause: error }); }

  // 管理令牌只能发送给本机服务，不跟随重定向，也不输出到终端。
  let url: URL;
  try { url = new URL(saved); }
  catch (error) { throw new Error('管理链接格式无效，请重启服务重新生成。', { cause: error }); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || !/^#token=[a-f0-9]{64}$/.test(url.hash)) {
    throw new Error('管理链接格式无效，请重启服务重新生成。');
  }
  let response: Response;
  try { response = await fetch(new URL('/api/state', url), { headers: { authorization: `Bearer ${url.hash.slice(7)}` }, redirect: 'error', signal: AbortSignal.timeout(3000) }); }
  catch (error) { throw new Error('管理后台未响应，请先在另一个终端运行 pnpm serve。', { cause: error }); }
  await response.body?.cancel();
  if (response.status === 401) throw new Error('管理链接已失效，请确认配置文件与正在运行的服务一致，必要时重启服务。');
  if (!response.ok) throw new Error(`管理后台暂时不可用（HTTP ${response.status}），请检查服务终端。`);
  try { await launch(url.href); }
  catch (error) { throw new Error(`无法打开浏览器，请手动打开 ${join(dataDirectory, 'admin.url')} 中的链接。`, { cause: error }); }
  return url.origin;
}
