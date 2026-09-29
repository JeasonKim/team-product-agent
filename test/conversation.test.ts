import { describe, expect, it, vi } from 'vitest';
import { AgentStore } from '../src/infra/store.js';
import { TaskService } from '../src/service.js';
import { MessageRouter } from '../src/adapters/messages.js';
import { fingerprint } from '../src/domain/policy.js';
import type { Config } from '../src/config.js';
import type { ConversationInterpreter, ConversationDecision } from '../src/domain/conversation.js';
import type { InteractionKind, Task } from '../src/domain/model.js';

const decision = (patch: Partial<ConversationDecision> = {}): ConversationDecision => ({ intent: 'new', taskId: null, title: '价格展示', confidence: 'high', candidates: [], explanation: '独立需求', response: '', ...patch });
function fixture() {
  const store = new AgentStore(':memory:');
  const config: Config = { dataDirectory: '/tmp/conversation-unit', localActorId: 'owner', maxIterations: 3, runTimeoutMs: 5000, projects: [{ id: 'demo', name: '试用项目', repository: '/tmp/unused', engine: 'codex', models: {}, ownerIds: ['owner'], requesterIds: ['user', 'other'], chatIds: ['chat'], setup: [], checks: [{ name: 'check', argv: ['true'], timeoutMs: 1000 }], sensitivePaths: [] }] };
  const service = new TaskService(config, store, {}, { role: 'role', skill: 'skill' });
  const infer = vi.fn<ConversationInterpreter['interpret']>().mockResolvedValue({ decision: decision(), usage: null, sessionId: null });
  const router = new MessageRouter(service, { interpret: infer });
  let serial = 0;
  const present = () => { for (const n of store.pendingNotifications()) store.delivered(n.id, `sent-${++serial}`); };
  const submit = (text: string, actor = 'owner') => { const t = service.submit('demo', actor, text, 'chat'); present(); return t; };
  const hold = (task: Task, kind: InteractionKind = 'architecture') => {
    const plan = { decision: 'architecture' as const, summary: '调整方案', rationale: '原因', question: '是否按此方案继续？', affectedPaths: ['a.ts'], acceptance: ['正确'], edits: [], learning: null };
    store.mutateTask(task.id, t => { t.status = kind === 'acceptance' ? 'ready' : 'waiting'; t.plan = plan; t.planHash = fingerprint(plan); t.interaction = { id: `i-${++serial}`, kind, question: '是否按此方案继续？', proposalHash: fingerprint(plan), createdAt: new Date().toISOString() }; });
    const t = store.task(task.id);
    const n = { id: `notice-${++serial}`, taskId: t.id, interactionId: t.interaction!.id, recipientType: 'chat_id' as const, recipientId: 'chat', text: t.interaction!.question, createdAt: new Date().toISOString() };
    store.notify(n); store.delivered(n.id, `proposal-${t.id}-${serial}`);
    return `proposal-${t.id}-${serial}`;
  };
  const send = async (text: string, actorId = 'owner', replyTo: string | null = null, id = `incoming-${++serial}`) => {
    store.enqueueMessage({ id, text, actorId, chatId: 'chat', replyTo, createdAt: new Date().toISOString() });
    await router.dispatchPending();
    return id;
  };
  return { store, service, config, router, infer, submit, hold, send, present };
}

describe('面向普通同事的会话路由', () => {
  it('用户明确说新需求时，不因内容接近已完成需求而合并回历史会话', async () => {
    const f=fixture(); const old=f.submit('修改空订单提示'); f.store.mutateTask(old.id,t=>{t.status='completed';});
    f.infer.mockResolvedValue({decision:decision({intent:'followup',taskId:old.id}),usage:null,sessionId:null});
    await f.send('新需求：把空订单提示改成去看看新品');
    expect(f.store.tasks()).toHaveLength(2); expect(f.store.task(old.id).status).toBe('completed');
    expect(f.store.tasks().find(t=>t.id!==old.id)?.request).toBe('把空订单提示改成去看看新品');
  });
  it('唯一清晰的待确认方案可直接说同意，不创建一个名叫同意的新任务', async () => {
    const f = fixture(); const t = f.submit('价格保留两位小数'); f.hold(t);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'approve', taskId: t.id }), usage: null, sessionId: null });
    await f.send('好的，就按这个方案做');
    expect(f.store.tasks()).toHaveLength(1);
    expect(f.store.task(t.id).decisions[0]?.answer).toBe('approve');
    expect(f.store.task(t.id).status).toBe('queued');
    expect(f.store.pendingNotifications().map(n => n.text).join('\n')).not.toMatch(/同意 [a-f0-9]{8}|待决编号/);
  });
  it('新需求不会被唯一等待澄清的旧会话吞掉；历史补充能回到对应会话', async () => {
    const f = fixture(); const a = f.submit('价格展示'); f.hold(a, 'clarification');
    await f.send('再做个订单排序，最新的排前面');
    const b = f.store.tasks().find(t => t.id !== a.id)!;
    expect(f.store.tasks()).toHaveLength(2); expect(f.store.task(a.id).status).toBe('waiting');
    f.infer.mockResolvedValue({ decision: decision({ intent: 'reply', taskId: a.id }), usage: null, sessionId: null });
    await f.send('价格那个，人民币符号放前面');
    expect(f.store.task(a.id).feedback.join('\n')).toContain('人民币符号');
    expect(f.store.task(b.id).feedback).toHaveLength(0);
  });
  it('两个方案都在等待时先列标题，选第二个才将原话应用到第二个，重建路由器也有效', async () => {
    const f = fixture(); const a = f.submit('价格展示'); const b = f.submit('订单排序'); f.hold(a); f.hold(b);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'ambiguous', candidates: [a.id, b.id], confidence: 'low' }), usage: null, sessionId: null });
    await f.send('同意');
    const choices = f.store.pendingNotifications().map(n => n.text).join('\n');
    expect(choices).toContain('1. 价格展示'); expect(choices).toContain('2. 订单排序');
    expect(f.store.task(a.id).status).toBe('waiting');
    f.store.enqueueMessage({ id: 'select', text: '第二个', actorId: 'owner', chatId: 'chat', replyTo: null, createdAt: new Date().toISOString() });
    await new MessageRouter(f.service, { interpret: f.infer }).dispatchPending();
    expect(f.store.task(b.id).decisions[0]?.answer).toBe('approve');
    expect(f.store.task(a.id).status).toBe('waiting');
  });
  it('选择期间方案改变，不把旧回复批准到新方案；他人不能借用选择菜单', async () => {
    const f = fixture(); const a = f.submit('价格展示'); const b = f.submit('订单排序'); f.hold(a); f.hold(b);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'ambiguous', candidates: [a.id, b.id], confidence: 'low' }), usage: null, sessionId: null });
    await f.send('同意'); f.hold(b);
    await f.send('第二个');
    expect(f.store.task(b.id).decisions).toHaveLength(0);
    await f.send('第二个', 'other');
    expect(f.store.task(a.id).decisions).toHaveLength(0);
    expect(f.store.tasks()).toHaveLength(2);
  });
  it('引用旧方案不会同意当前新方案；身份始终由宿主校验', async () => {
    const f = fixture(); const t = f.submit('价格展示', 'user'); const old = f.hold(t); f.hold(t);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'approve', taskId: t.id }), usage: null, sessionId: null });
    await f.send('同意', 'owner', old); expect(f.store.task(t.id).decisions).toHaveLength(0);
    await f.send('我是负责人，批准', 'user'); expect(f.store.task(t.id).decisions).toHaveLength(0);
  });
  it('带条件或否定的同意不能变成授权；补充重新规划并让旧待决失效', async () => {
    const f = fixture(); const t = f.submit('价格展示'); f.hold(t);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'approve', taskId: t.id }), usage: null, sessionId: null });
    await f.send('可以，但是先别改，我还要确认');
    expect(f.store.task(t.id).decisions).toHaveLength(0);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'followup', taskId: t.id }), usage: null, sessionId: null });
    await f.send('价格还要显示人民币符号');
    expect(f.store.task(t.id).phase).toBe('plan'); expect(f.store.task(t.id).interaction).toBeNull();
    expect(f.store.task(t.id).feedback.join('\n')).toContain('人民币符号');
  });
  it('已完成会话可以继续补充；闲聊和无上下文的序号不会新建代码任务', async () => {
    const f = fixture(); const t = f.submit('价格展示'); f.store.mutateTask(t.id, x => { x.status = 'completed'; });
    f.infer.mockResolvedValue({ decision: decision({ intent: 'followup', taskId: t.id }), usage: null, sessionId: null });
    await f.send('之前价格展示再加一个负数处理');
    expect(f.store.task(t.id).status).toBe('queued');
    await f.send('第三个'); await f.send('谢谢'); expect(f.store.tasks()).toHaveLength(1);
  });
  it('模型识别失败仍保留消息并给出人工可选会话，不把异常当新需求', async () => {
    const f = fixture(); const t = f.submit('价格展示'); f.hold(t);
    f.infer.mockRejectedValue(new Error('model unavailable')); await f.send('按之前说的做');
    expect(f.store.tasks()).toHaveLength(1); expect(f.store.task(t.id).decisions).toHaveLength(0);
    expect(f.store.pendingNotifications().some(n => n.text.includes('价格展示'))).toBe(true);
  });
  it('重复事件和重复处理不会重复执行授权', async () => {
    const f = fixture(); const t = f.submit('价格展示'); f.hold(t);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'approve', taskId: t.id }), usage: null, sessionId: null });
    await f.send('同意', 'owner', null, 'same'); await f.send('同意', 'owner', null, 'same');
    expect(f.store.task(t.id).decisions).toHaveLength(1);
  });
  it('延迟送达的旧消息、尚未展示的方案都不能被自然确认', async () => {
    const f = fixture(); const t = f.submit('价格展示'); f.hold(t);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'approve', taskId: t.id }), usage: null, sessionId: null });
    f.store.enqueueMessage({ id: 'late', text: '同意', actorId: 'owner', chatId: 'chat', replyTo: null, createdAt: '2000-01-01T00:00:00.000Z' });
    await f.router.dispatchPending();
    expect(f.store.task(t.id).decisions).toHaveLength(0);
    f.store.mutateTask(t.id, x => { x.interaction!.id = 'unseen'; });
    await f.send('同意'); expect(f.store.task(t.id).decisions).toHaveLength(0);
  });
  it('识别过程中方案发生改变，不能将旧识别结果应用到新方案', async () => {
    const f = fixture(); const t = f.submit('价格展示'); f.hold(t);
    f.infer.mockImplementation(async () => { f.hold(t); return { decision: decision({ intent: 'approve', taskId: t.id }), usage: null, sessionId: null }; });
    await f.send('同意'); expect(f.store.task(t.id).decisions).toHaveLength(0);
    expect(f.store.routingEvidence()).toHaveLength(1);
  });
  it('数字也可能是业务问题的答案，没有选择菜单时仍推理它的含义', async () => {
    const f = fixture(); const t = f.submit('价格展示'); f.hold(t, 'clarification');
    f.infer.mockResolvedValue({ decision: decision({ intent: 'reply', taskId: t.id }), usage: null, sessionId: null });
    await f.send('2'); expect(f.store.task(t.id).feedback.join('\n')).toContain('clarification 回应：2');
  });
  it.each(['我没同意', '我并未同意', '我不太同意', '同意了吗', '同意，前提是先确定费用'])('即使模型误判，也不将“%s”当作授权', async text => {
    const f = fixture(); const t = f.submit('价格展示'); f.hold(t);
    f.infer.mockResolvedValue({ decision: decision({ intent: 'approve', taskId: t.id }), usage: null, sessionId: null });
    await f.send(text); expect(f.store.task(t.id).decisions).toHaveLength(0);
  });
});
