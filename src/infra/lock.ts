import { open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function acquireWorkerLock(path: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  try {
    const file = await open(path, 'wx', 0o600);
    await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(path, 'utf8')) as { pid: number; token: string };
    let alive = true;
    try { process.kill(previous.pid, 0); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw probe; }
    if (alive) throw new Error(`已有服务运行，PID ${previous.pid}`, { cause: error });
    console.warn('归档失效的工作进程锁', { previousPid: previous.pid, replacementPid: process.pid });
    await rename(path, `${path}.stale-${randomUUID()}`);
    return acquireWorkerLock(path);
  }
  return async () => {
    const current = JSON.parse(await readFile(path, 'utf8')) as { token: string };
    if (current.token !== token) throw new Error('工作进程锁归属已改变，拒绝释放');
    await unlink(path);
  };
}
