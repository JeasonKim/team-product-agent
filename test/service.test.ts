import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEngine, AgentResponse, Engine, EngineRequest } from '../src/domain/model.js';
import type { Config } from '../src/config.js';
import { AgentStore } from '../src/infra/store.js';
import { executeCommand } from '../src/infra/process.js';
import { TaskService } from '../src/service.js';

const answer = (patch: Partial<AgentResponse> = {}): AgentResponse => ({ decision: 'ready', summary: '修复计算', rationale: '保持原接口', question: null, affectedPaths: ['math.mjs'], acceptance: ['两数相加正确'], edits: [], learning: null, ...patch });
async function fixture(engine: Engine, answers: AgentResponse[], beforeResponse?: (request: EngineRequest) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'team-agent-service-'));
  const repository = join(root, 'repo');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(repository);
  await writeFile(join(repository, 'math.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(join(repository, 'check.mjs'), "import {sum} from './math.mjs'; if(sum(3,2)!==5) process.exit(1);\n");
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']]) {
    const result = await executeCommand({ name: 'git', argv: ['git', ...args], timeoutMs: 10_000 }, repository);
    expect(result.exitCode).toBe(0);
  }
  const config: Config = { dataDirectory: join(root, 'data'), localActorId: 'owner', maxIterations: 3, runTimeoutMs: 30_000, projects: [{ id: 'demo', name: '测试产品', repository, engine, models: {}, requesterIds: ['requester'], ownerIds: ['owner'], chatIds: ['chat'], setup: [], checks: [{ name: '业务检查', argv: [process.execPath, 'check.mjs'], timeoutMs: 5000 }], sensitivePaths: ['schema.sql'] }] };
  let calls = 0;
  const adapter: AgentEngine = { id: engine, async execute(request) { request.signal.throwIfAborted(); const response = answers[calls++]; await beforeResponse?.(request); request.signal.throwIfAborted(); if (!response) throw new Error('试验回复已用完'); return { response, sessionId: `${engine}-session`, usage: { inputTokens: null, outputTokens: null, costUsd: null } }; } };
  const store = new AgentStore(join(root, 'state.sqlite'));
  const service = new TaskService(config, store, { [engine]: adapter }, { role: '测试角色', skill: '测试闭环' });
  return { service, store, config, repository, calls: () => calls };
}

describe.each<Engine>(['claude', 'codex'])('%s 任务业务契约', engine => {
  it('新默认模型与身份不打断旧需求，执行实际使用创建时的模型与推理级别', async () => {
    const requests: EngineRequest[] = [];
    const f = await fixture(engine, [answer(), answer({ edits: [{ path: 'math.mjs', before: 'a - b', after: 'a + b' }] })], async request => { requests.push(request); });
    f.config.projects[0]!.models[engine] = 'original-model'; f.config.projects[0]!.efforts = { [engine]: 'high' };
    const task = f.service.submit('demo', 'requester', '修一下加法', 'chat');
    f.config.projects[0]!.models[engine] = 'next-model'; f.config.projects[0]!.efforts = { [engine]: 'low' };
    f.config.profile = { name: '新名字', role: '新职责', style: '新风格', preferences: '后续任务的偏好' };
    f.config.projects[0]!.requesterIds.push('new-colleague'); // 接入新同事不使无关任务停下来。
    await f.service.drain();
    expect(f.store.task(task.id).status).toBe('ready'); expect(requests).toHaveLength(2);
    expect(requests.every(r => r.model === 'original-model' && r.effort === 'high' && !r.instructions.includes('后续任务的偏好'))).toBe(true);
    expect(f.store.runs(task.id).every(r => r.requestedEffort === 'high')).toBe(true); f.store.close();
  });
  it('收回旧成员权限或改变执行边界后仍需负责人恢复确认', async () => {
    const f = await fixture(engine, [answer()]); const task = f.service.submit('demo', 'requester', '修一下加法', 'chat');
    f.config.projects[0]!.requesterIds = [];
    await f.service.drain(); expect(f.store.task(task.id).interaction?.kind).toBe('recovery'); expect(f.calls()).toBe(0); f.store.close();
  });
  it('执行失败通知真实飞书负责人，本机管理身份恰为负责人也不会漏通知', async () => {
    const f = await fixture(engine, []);
    f.config.localActorId = 'ou_owner'; f.config.projects[0]!.ownerIds = ['ou_owner'];
    const task = f.service.submit('demo', 'requester', '修一下加法', 'chat');
    for (const n of f.store.pendingNotifications()) f.store.delivered(n.id);
    await f.service.drain();
    expect(f.store.task(task.id).status).toBe('failed');
    const notices = f.store.pendingNotifications();
    expect(notices.some(n => n.recipientId === 'ou_owner' && n.text.includes('试验回复已用完'))).toBe(true);
    expect(notices.some(n => n.recipientId === 'requester' && n.text.includes('我已通知他'))).toBe(true);
    expect(notices.some(n => n.recipientType === 'chat_id')).toBe(false); f.store.close();
  });
  it('普通修复不请求负责人，先失败基线，再真实检查后交付；主仓库不变', async () => {
    const f = await fixture(engine, [answer(), answer({ edits: [{ path: 'math.mjs', before: 'a - b', after: 'a + b' }] })]);
    const task = f.service.submit('demo', 'requester', '修一下加法', 'chat');
    await f.service.drain();
    expect(f.store.task(task.id).status).toBe('ready');
    expect(f.store.evidence(task.id).map(item => item.passed)).toEqual([false, true, true]);
    expect(await readFile(join(f.repository, 'math.mjs'), 'utf8')).toContain('a - b');
    const ready = f.store.task(task.id);
    expect(await readFile(join(ready.workspace!, 'math.mjs'), 'utf8')).toContain('a + b');
    const patch = f.store.evidence(task.id).find(item => item.kind === 'delivery')!.artifact!;
    const applicable = await executeCommand({ name: '补丁可应用性', argv: ['git', 'apply', '--check', patch], timeoutMs: 5000 }, f.repository);
    expect(applicable.exitCode, applicable.output).toBe(0);
    f.service.reply(task.id, ready.interaction!.id, 'requester', 'approve');
    expect(f.store.task(task.id).status).toBe('completed');
    f.store.close();
  });
  it('架构决定在代码落盘前等待，只有负责人可批准，陈旧回复不能复用', async () => {
    const f = await fixture(engine, [answer({ decision: 'architecture', question: '需要调整模型，是否采用该方案？' }), answer({ edits: [{ path: 'math.mjs', before: 'a - b', after: 'a + b' }] })]);
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    await f.service.drain();
    const waiting = f.store.task(task.id);
    expect(waiting.status).toBe('waiting');
    expect(f.calls()).toBe(1);
    expect(() => f.service.reply(task.id, waiting.interaction!.id, 'requester', 'approve')).toThrow(/权限/);
    f.service.reply(task.id, waiting.interaction!.id, 'owner', 'approve');
    expect(() => f.service.reply(task.id, waiting.interaction!.id, 'owner', 'approve')).toThrow(/过期|已处理/);
    await f.service.drain();
    expect(f.store.task(task.id).status).toBe('ready');
    f.store.close();
  });
  it('验证失败后带着实际失败反馈修复，达到轮数上限仍不宣称完成', async () => {
    const bad = answer({ edits: [] });
    const f = await fixture(engine, [answer(), bad, bad, bad]);
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    await f.service.drain();
    expect(f.store.task(task.id).status).toBe('failed');
    expect(f.store.evidence(task.id).filter(item => item.kind === 'verification')).toHaveLength(3);
    expect(f.calls()).toBe(4);
    f.store.close();
  });
  it('服务重启将执行中的任务交技术负责人恢复，不盲目重跑', async () => {
    const f = await fixture(engine, [answer()]);
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    f.store.mutateTask(task.id, task => { task.status = 'running'; });
    f.service.recoverInterrupted();
    expect(f.store.task(task.id).status).toBe('waiting');
    expect(f.store.task(task.id).interaction?.kind).toBe('recovery');
    await f.service.drain();
    expect(f.calls()).toBe(0);
    f.store.close();
  });
  it('需求方可以补充中断的任务，但不能借此绕过负责人恢复确认', async () => {
    const f = await fixture(engine, [answer()]);
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    f.store.mutateTask(task.id, t => { t.status = 'running'; });
    f.service.recoverInterrupted();
    const old = f.store.task(task.id).interaction!.id;
    f.service.followUp(task.id, 'requester', '也要支持小数');
    const current = f.store.task(task.id);
    expect(current.status).toBe('waiting'); expect(current.interaction?.kind).toBe('recovery');
    expect(current.interaction?.id).not.toBe(old);
    expect(current.feedback).toContain('需求补充：也要支持小数');
    expect(() => f.service.reply(task.id, old, 'owner', 'approve')).toThrow(/过期/);
    await f.service.drain(); expect(f.calls()).toBe(0);
    f.store.close();
  });
  it('失败任务的补充不能绕过仅负责人可重试的规则', async () => {
    const f = await fixture(engine, [answer()]);
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    f.store.mutateTask(task.id, t => { t.status = 'failed'; });
    f.service.followUp(task.id, 'requester', '也要支持小数');
    expect(f.store.task(task.id).status).toBe('failed');
    expect(f.store.task(task.id).feedback).toContain('需求补充：也要支持小数');
    f.service.followUp(task.id, 'owner', '结合新要求继续处理');
    expect(f.store.task(task.id).status).toBe('queued');
    f.store.close();
  });
  it('执行中取消会停止引擎，迟到的完成结果不能覆盖已取消状态', async () => {
    const f = await fixture(engine, [answer()], async request => new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })));
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    const running = f.service.runNext();
    await vi.waitFor(() => expect(f.calls()).toBe(1));
    f.service.cancel(task.id, 'requester');
    await running;
    expect(f.store.task(task.id).status).toBe('cancelled');
    expect(f.store.runs(task.id)[0]?.status).toBe('cancelled');
    f.store.close();
  });
  it('执行中收到补充会中止旧运行，保留新需求并重新规划', async () => {
    const f = await fixture(engine, [answer()], async request => new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })));
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    const running = f.service.runNext();
    await vi.waitFor(() => expect(f.calls()).toBe(1));
    f.service.followUp(task.id, 'requester', '还要支持小数');
    await running;
    const updated = f.store.task(task.id);
    expect(updated.status).toBe('queued'); expect(updated.phase).toBe('plan'); expect(updated.plan).toBeNull();
    expect(updated.feedback).toContain('需求补充：还要支持小数');
    expect(f.store.runs(task.id)[0]?.status).toBe('cancelled');
    f.store.close();
  });
  it('模型试图修改未审定文件时不会落盘', async () => {
    const bad = answer({ edits: [{ path: 'check.mjs', before: 'process.exit(1)', after: 'process.exit(0)' }] });
    const f = await fixture(engine, [answer(), bad, bad, bad]);
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    await f.service.drain();
    expect(f.store.task(task.id).status).toBe('failed');
    expect(await readFile(join(f.store.task(task.id).workspace!, 'check.mjs'), 'utf8')).toContain('process.exit(1)');
    f.store.close();
  });
  it('另一个进程写入取消状态时，即使取消信号尚未轮询也不能被结果覆盖', async () => {
    const f = await fixture(engine, [answer({ decision: 'architecture' })], async request => {
      f.store.mutateTask(request.taskId, task => { task.status = 'cancelled'; });
    });
    const task = f.service.submit('demo', 'requester', '修复计算', 'chat');
    await f.service.drain();
    expect(f.store.task(task.id).status).toBe('cancelled');
    expect(f.store.task(task.id).interaction).toBe(null);
    f.store.close();
  });
});
