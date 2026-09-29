import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { applicationDirectory } from '../infra/paths.js';
import { Conflict, type Management } from '../management.js';
import { modelCatalog } from '../infra/model-catalog.js';

const actionSchema = z.object({ action: z.enum(['approve', 'reject', 'reply', 'followup', 'cancel', 'retry']), revision: z.number().int().nonnegative(), interactionId: z.string().optional(), text: z.string().max(20000).optional() }).strict();
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('请求需要 JSON 格式');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 1_000_000) throw new Error('请求内容过长'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function startAdmin(management: Management, options: { port: number }) {
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const send = (response: ServerResponse, status: number, data: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    void (async () => {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { send(response, 403, { error: '仅允许本机管理页面访问' }); return; }
      const path = new URL(request.url ?? '/', origin).pathname;
      if (!path.startsWith('/api/')) {
        const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/client.js': ['client.js', 'text/javascript'] };
        const asset = assets[path];
        if (!asset || request.method !== 'GET') { send(response, 404, { error: '页面不存在' }); return; }
        response.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8` }); response.end(await readFile(join(applicationDirectory, 'resources', 'admin', asset[0]))); return;
      }
      const provided = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? ''); const expected = Buffer.from(token);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { send(response, 401, { error: '请使用本机 admin.url 中的管理链接打开；令牌不需要发到聊天中。' }); return; }
      if (request.method === 'GET' && path === '/api/state') { send(response, 200, management.state()); return; }
      if (request.method === 'GET' && path === '/api/models') { send(response, 200, await modelCatalog()); return; }
      if (path === '/api/settings') {
        if (request.method === 'GET') { send(response, 200, management.settings()); return; }
        if (request.method === 'PUT') { const input = z.object({ config: z.unknown(), revision: z.string() }).strict().parse(await body(request)); send(response, 200, await management.saveSettings(input.config, input.revision)); return; }
      }
      const taskRoute = /^\/api\/tasks\/([a-f0-9]{8})(?:\/(action|patch))?$/.exec(path);
      if (taskRoute) {
        const id = taskRoute[1]!;
        if (request.method === 'GET' && !taskRoute[2]) { send(response, 200, management.taskDetail(id)); return; }
        if (request.method === 'POST' && taskRoute[2] === 'action') { send(response, 200, management.taskAction(id, actionSchema.parse(await body(request)))); return; }
        if (request.method === 'GET' && taskRoute[2] === 'patch') {
          const detail = management.taskDetail(id); const artifact = detail.evidence.filter(e => e.kind === 'delivery' && e.artifact).at(-1)?.artifact;
          if (!artifact) throw new Error('当前任务还没有可下载的补丁');
          const root = await realpath(join(management.service.config.dataDirectory, 'tasks', id));
          const file = await realpath(artifact); const local = relative(root, file);
          if (local.startsWith('..') || isAbsolute(local)) throw new Error('产物路径超出任务范围');
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="task-${id}.patch"` }); response.end(await readFile(file)); return;
        }
      }
      if (request.method === 'POST' && path === '/api/access') { const input = z.object({ id: z.string(), projectId: z.string(), grant: z.boolean() }).strict().parse(await body(request)); await management.resolveAccess(input.id, input.projectId, input.grant); send(response, 200, { ok: true }); return; }
      if (request.method === 'POST' && path === '/api/notifications/retry') { const input = z.object({ id: z.string() }).strict().parse(await body(request)); management.service.store.retryNotification(input.id); management.service.store.audit('notification.retry', management.service.config.localActorId, null, input); send(response, 200, { ok: true }); return; }
      if (request.method === 'POST' && path === '/api/improvements') { const input = z.object({ taskId: z.string(), content: z.string() }).strict().parse(await body(request)); management.createImprovement(input.taskId, input.content); send(response, 200, { ok: true }); return; }
      const improvement = /^\/api\/improvements\/([a-f0-9]{8})\/(archive|evaluate|promote)$/.exec(path);
      if (improvement && request.method === 'POST') {
        const id = improvement[1]!;
        if (improvement[2] === 'archive') management.archiveImprovement(id);
        if (improvement[2] === 'evaluate') management.queueEvaluation(id);
        if (improvement[2] === 'promote') { const input = z.object({ jobId: z.string() }).strict().parse(await body(request)); await management.promote(id, input.jobId); }
        send(response, 200, { ok: true }); return;
      }
      const evaluation = /^\/api\/evaluations\/([a-f0-9-]{36})(?:\/(cancel))?$/.exec(path);
      if (evaluation) {
        if (request.method === 'GET' && !evaluation[2]) { send(response, 200, await management.evaluationReport(evaluation[1]!)); return; }
        if (request.method === 'POST' && evaluation[2] === 'cancel') { management.cancelEvaluation(evaluation[1]!); send(response, 200, { ok: true }); return; }
      }
      send(response, 404, { error: '接口不存在' });
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      send(response, error instanceof Conflict ? 409 : 400, { error: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}：${i.message}`).join('\n') : error instanceof Error ? error.message : '操作未完成' });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法启动本机管理后台');
  origin = `http://127.0.0.1:${address.port}`;
  const directory = management.service.config.dataDirectory; await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(join(directory, 'admin.url'), `${origin}/#token=${token}\n`, { mode: 0o600 }); }
  catch (error) { server.close(); throw error; }
  return { origin, token, close: async () => { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
