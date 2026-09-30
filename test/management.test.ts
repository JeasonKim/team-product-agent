import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentStore } from '../src/infra/store.js';
import { TaskService } from '../src/service.js';
import { MessageRouter } from '../src/adapters/messages.js';
import { loadConfig, type Config } from '../src/config.js';
import { Management } from '../src/management.js';
import { startAdmin } from '../src/admin/server.js';
import type { ConversationInterpreter } from '../src/domain/conversation.js';
import { attachment } from '../src/domain/attachments.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(multiple = false) {
  const root = await mkdtemp(join(tmpdir(), 'agent-admin-'));
  const path = join(root, 'config.json');
  const raw = { dataDirectory: join(root, 'data'), localActorId: 'owner', projects: [{ id: 'demo', name: '小店', repository: root, engine: 'codex', authentication: { codex: 'local_login' }, models: { codex: 'old-model' }, ownerIds: ['owner', 'ou_owner'], requesterIds: ['ou_user'], chatIds: ['group'], checks: [{ name: 'check', argv: ['true'] }] }] };
  if (multiple) raw.projects.push({ ...raw.projects[0]!, id: 'second', name: '客服产品', chatIds: [] });
  await writeFile(path, JSON.stringify(raw));
  const config: Config = await loadConfig(path);
  const store = new AgentStore(':memory:'); cleanups.push(() => store.close());
  const service = new TaskService(config, store, {}, { role: '原角色', skill: '验证' });
  const management = new Management(service, path);
  const interpret = vi.fn<ConversationInterpreter['interpret']>().mockResolvedValue({ decision: { intent: 'new', taskId: null, title: '价格格式', confidence: 'high', candidates: [], explanation: '', response: '' }, sessionId: null, usage: null });
  const router = new MessageRouter(service, { interpret });
  let serial = 0;
  async function send(text: string, actorId = 'ou_user', chatId = 'dm', chatType: 'p2p' | 'group' = 'p2p') {
    store.enqueueMessage({ id: `m${++serial}`, text, actorId, chatId, chatType, replyTo: null, createdAt: new Date().toISOString() });
    await router.dispatchPending();
  }
  return { root, path, config, store, service, management, send, interpret };
}

describe('私聊入口与安静的群聊', () => {
  it('单个产品直接私聊提交；所有任务反馈发给需求者', async () => {
    const f = await fixture(); await f.send('价格保留两位小数');
    expect(f.store.tasks()).toHaveLength(1);
    expect(f.store.tasks()[0]?.requesterId).toBe('ou_user');
    expect(f.store.pendingNotifications().every(n => n.recipientType === 'open_id' && n.recipientId === 'ou_user')).toBe(true);
  });
  it('多产品先列名称，选择后保留原需求且记住选择，另一个用户不能借用选择', async () => {
    const f = await fixture(true); await f.send('价格保留两位小数');
    expect(f.store.tasks()).toHaveLength(0);
    expect(f.store.pendingNotifications().some(n => n.text.includes('1. 小店') && n.text.includes('2. 客服产品'))).toBe(true);
    await f.send('第二个');
    expect(f.store.tasks()[0]).toMatchObject({ projectId: 'second', request: '价格保留两位小数' });
    await f.send('新增一个清空按钮'); expect(f.store.tasks().find(t => t.request === '新增一个清空按钮')?.projectId).toBe('second');
    await f.send('切换产品'); expect(f.store.tasks()).toHaveLength(2);
    await f.send('1'); await f.send('调整列表文案'); expect(f.store.tasks().find(t => t.request === '调整列表文案')?.projectId).toBe('demo');
  });
  it('群里只发收件提示，后续补充在单聊发送', async () => {
    const f = await fixture(); await f.send('价格保留两位小数', 'ou_user', 'group', 'group');
    const task = f.store.tasks()[0]!;
    f.service.followUp(task.id, 'ou_user', '加上人民币符号');
    const notices = f.store.pendingNotifications();
    expect(notices.filter(n => n.recipientType === 'chat_id')).toHaveLength(1);
    expect(notices.find(n => n.recipientType === 'chat_id')?.text).toContain('单聊');
    expect(notices.some(n => n.recipientType === 'open_id' && n.recipientId === 'ou_user')).toBe(true);
  });
  it('未接入同事产生一次接入申请，负责人授权后恢复原请求', async () => {
    const f = await fixture(); await f.send('调整购物车', 'ou_new'); await f.send('我想改购物车', 'ou_new');
    expect(f.store.tasks()).toHaveLength(0); expect(f.store.accessRequests()).toHaveLength(1);
    const access = f.store.accessRequests()[0]!;
    await f.management.resolveAccess(access.id, 'demo', true);
    await new MessageRouter(f.service, { interpret: f.interpret }).dispatchPending();
    expect(f.config.projects[0]?.requesterIds).toContain('ou_new'); expect(f.store.tasks()).toHaveLength(1);
    await expect(f.management.resolveAccess(access.id, 'second', true)).rejects.toThrow(/已处理/);
  });
});

describe('负责人管理与配置追溯', () => {
  it('附件下载需要管理权限且限定在所属任务，原始文件不会作为网页执行', async () => {
    const f = await fixture();
    const assets = await f.service.attachments.receive([attachment('om_file', 'file_demo', 'file', '说明.html')], async (_a, path) => { await writeFile(path, '<script>alert(1)</script>'); }, new AbortController().signal);
    const task = f.service.submit('demo', 'ou_user', '参考文档调整', null, undefined, undefined, assets);
    const other = f.service.submit('demo', 'ou_user', '另一个任务');
    const admin = await startAdmin(f.management, { port: 0 }); cleanups.push(admin.close);
    const path = `/api/tasks/${task.id}/attachments/${assets[0]!.id}`;
    expect((await fetch(admin.origin + path)).status).toBe(401);
    const headers = { authorization: `Bearer ${admin.token}` };
    const response = await fetch(admin.origin + path, { headers });
    expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-type')).toBe('application/octet-stream'); expect(await response.text()).toContain('<script>');
    expect((await fetch(`${admin.origin}/api/tasks/${other.id}/attachments/${assets[0]!.id}`, { headers })).status).not.toBe(200);
  });
  it('自动评估只在验收后发起，每个候选仅一次；失败不会无限重试', async () => {
    const f = await fixture(); f.config.projects[0]!.autoEvaluate = true; f.config.projects[0]!.evaluationManifest = join(f.root,'missing-cases.json');
    const task=f.service.submit('demo','ou_user','来源');
    f.store.recordImprovement({id:'f1234567',taskId:task.id,status:'candidate',content:'经验',createdAt:new Date().toISOString(),promotedAt:null,evaluatedHash:null});
    await f.management.runNextEvaluation(new AbortController().signal); expect(f.store.evaluationJobs()).toHaveLength(0);
    f.store.mutateTask(task.id,t=>{t.status='completed';});
    await f.management.runNextEvaluation(new AbortController().signal); expect(f.store.evaluationJobs()).toHaveLength(1); expect(f.store.evaluationJobs()[0]?.status).toBe('failed');
    await f.management.runNextEvaluation(new AbortController().signal); expect(f.store.evaluationJobs()).toHaveLength(1);
  });
  it('评估队列可取消，重启将执行中评估标为中断并保留记录', async () => {
    const f=await fixture(); f.config.projects[0]!.evaluationManifest=join(f.root,'cases.json'); const t=f.service.submit('demo','ou_user','来源');
    f.store.recordImprovement({id:'f2345678',taskId:t.id,status:'candidate',content:'经验',createdAt:new Date().toISOString(),promotedAt:null,evaluatedHash:null});
    const queued=f.management.queueEvaluation('f2345678'); f.management.cancelEvaluation(queued.id);
    expect(f.store.evaluationJobs()[0]?.status).toBe('interrupted');
    const running=f.management.queueEvaluation('f2345678'); f.store.saveEvaluationJob({...running,status:'running'}); f.management.recoverEvaluations();
    expect(f.store.evaluationJobs().every(j=>j.status==='interrupted')).toBe(true);
  });
  it('设置原子保存且有审计；旧任务保留模型与身份快照；陈旧页面不能覆盖新设置', async () => {
    const f = await fixture(); const old = f.service.submit('demo', 'ou_user', '旧需求');
    const settings = f.management.settings();
    settings.config.projects[0]!.models.codex = 'new-model';
    settings.config.projects[0]!.efforts = { codex: 'high' };
    settings.config.profile = { name: '研发搭档', role: '团队研发同事', style: '简洁直接', preferences: '优先复用现有模型' };
    await f.management.saveSettings(settings.config, settings.revision);
    const next = f.service.submit('demo', 'ou_user', '新需求');
    expect(old.projectSnapshot.models.codex).toBe('old-model');
    expect(next.projectSnapshot.models.codex).toBe('new-model'); expect(next.role).toContain('优先复用现有模型');
    expect(JSON.parse(await readFile(f.path, 'utf8')).profile.name).toBe('研发搭档');
    expect(f.store.auditEvents().some(e => e.action === 'settings.updated')).toBe(true);
    await expect(f.management.saveSettings(settings.config, settings.revision)).rejects.toThrow(/设置已更新/);
    const fresh = f.management.settings(); fresh.config.projects[0]!.evaluationManifest = join(f.root, 'cases.json');
    await expect(f.management.saveSettings(fresh.config, fresh.revision)).resolves.toMatchObject({ config: { profile: { name: '研发搭档' } } });
    expect(() => f.service.retry(old.id, 'ou_user')).toThrow(/负责人/);
  });
  it('引擎未验证的经验不会串到另一套 SDK；停用后新任务不再使用', async () => {
    const f = await fixture(); const task = f.service.submit('demo', 'ou_user', '来源');
    f.store.recordImprovement({ id: 'learn', taskId: task.id, content: '只对 Claude 验证的经验', status: 'promoted', createdAt: new Date().toISOString(), promotedAt: new Date().toISOString(), evaluatedHash: 'hash', validatedEngines: ['claude'] });
    expect(f.service.submit('demo', 'ou_user', 'Codex 需求').experience).toBe('');
    f.config.projects[0]!.engine = 'claude'; expect(f.service.submit('demo', 'ou_user', 'Claude 需求').experience).toContain('只对 Claude');
    f.management.archiveImprovement('learn'); expect(f.service.submit('demo', 'ou_user', '后续需求').experience).toBe('');
  });
  it('后台拒绝无凭证和跨站请求，过期决定返回冲突，原始日志按文本处理', async () => {
    const f = await fixture(); const admin = await startAdmin(f.management, { port: 0 }); cleanups.push(admin.close);
    expect((await fetch(`${admin.origin}/api/state`)).status).toBe(401);
    const headers = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' };
    expect((await fetch(`${admin.origin}/api/state`, { headers: { ...headers, origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await fetch(`${admin.origin}/api/state`, { headers })).status).toBe(200);
    const task = f.service.submit('demo', 'ou_user', '<script>not code</script>');
    const response = await fetch(`${admin.origin}/api/tasks/${task.id}/action`, { method: 'POST', headers, body: JSON.stringify({ action: 'cancel', revision: task.revision + 1 }) });
    expect(response.status).toBe(409); expect(f.store.task(task.id).status).toBe('queued');
    expect((await fetch(`${admin.origin}/api/tasks/${task.id}/action`, { method: 'POST', headers, body: JSON.stringify({ action: 'cancel', revision: task.revision }) })).status).toBe(200);
    expect(f.store.auditEvents(task.id).some(e => e.actorId === 'owner' && e.action === 'task.cancel')).toBe(true);
  });
});
