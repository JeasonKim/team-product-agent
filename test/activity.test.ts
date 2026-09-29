import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { AgentStore } from '../src/infra/store.js';
import { TaskService } from '../src/service.js';
import { MessageRouter } from '../src/adapters/messages.js';
import type { ConversationDecision, ConversationInterpreter } from '../src/domain/conversation.js';
import { Management } from '../src/management.js';

const stores: AgentStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); });
function fixture() {
  const store = new AgentStore(':memory:'); stores.push(store);
  const config: Config = { dataDirectory: '/tmp/agent-activity', localActorId: 'owner', maxIterations: 3, runTimeoutMs: 1000, projects: [{ id: 'shop', name: '小店', repository: '/tmp/unused', engine: 'codex', models: { codex: 'model-original' }, efforts: { codex: 'medium' }, ownerIds: ['owner'], requesterIds: ['alice','bob'], chatIds: ['group'], setup: [], checks: [{ name: 'check', argv: ['true'], timeoutMs: 1000 }], sensitivePaths: [] }] };
  const service = new TaskService(config, store, {}, { role: 'role', skill: 'skill' });
  const interpret = vi.fn<ConversationInterpreter['interpret']>().mockResolvedValue({ decision: { intent: 'new', taskId: null, title: '产品改动', confidence: 'high', candidates: [], explanation: '', response: '' }, usage: null, sessionId: null });
  let serial = 0;
  const send = async (text: string, actorId = 'alice', chatId = 'dm', chatType: 'p2p'|'group' = 'p2p') => {
    for (const n of store.pendingNotifications()) store.delivered(n.id);
    store.enqueueMessage({ id: `message-${++serial}`, text, actorId, chatId, chatType, replyTo: null });
    await new MessageRouter(service, { interpret }).dispatchPending();
    return store.pendingNotifications();
  };
  return { store, config, service, interpret, send };
}

describe('Agent 的实际状态与任务元数据', () => {
  it('用真实心跳判断在线，区分新任务默认模型和旧任务实际快照', () => {
    const f = fixture(); const old = f.service.submit('shop','alice','订单排序');
    f.store.mutateTask(old.id,t=>{t.status='running';});
    f.config.projects[0]!.models.codex = 'model-next'; f.config.projects[0]!.efforts = {codex:'high'};
    f.service.submit('shop','alice','价格显示');
    Object.assign(f.service.health,{worker:'running',feishu:'connected',heartbeatAt:new Date().toISOString()});
    const activity = f.service.activity('alice');
    expect(activity.online).toBe(true);
    expect(activity.projects[0]).toMatchObject({engine:'codex',model:'model-next',effort:'high'});
    expect(activity.tasks.find(t=>t.id===old.id)).toMatchObject({engine:'codex',model:'model-original',effort:'medium'});
    expect(activity.counts).toMatchObject({running:1,queued:1,waiting:0,ready:0,failed:0});
    f.service.health.heartbeatAt = new Date(Date.now()-60_000).toISOString();
    expect(f.service.activity('alice').online).toBe(false);
    const state = new Management(f.service,'/tmp/unused-config.json').state();
    expect(state.activity.online).toBe(false);
    expect(state.tasks.find(t=>t.id===old.id)?.model).toBe('model-original');
  });
  it('普通成员只看到自己的任务；负责人可以看到所负责产品的全部任务', () => {
    const f = fixture(); f.service.submit('shop','alice','自己的待办'); f.service.submit('shop','bob','另一个人的需求');
    expect(f.service.activity('alice').tasks.map(t=>t.title)).toEqual(['自己的待办']);
    expect(f.service.activity('alice').counts.queued).toBe(1);
    expect(f.service.activity('owner').counts.queued).toBe(2);
    expect(()=>f.service.activity('outsider')).toThrow(/权限/);
    expect(JSON.stringify(f.service.activity('alice'))).not.toContain('/tmp/unused');
  });
  it('查询状态无需调用模型或创建任务；多产品选择中的原需求不丢失', async () => {
    const f = fixture(); f.config.projects.push({...f.config.projects[0]!,id:'support',name:'客服',chatIds:[]});
    await f.send('修复页面提示');
    const selection = f.store.channel(JSON.stringify(['dm','alice'])).selection;
    const notices = await f.send('你在线吗？使用什么模型和推理级别？有哪些进行中的任务和待办？');
    expect(f.interpret).not.toHaveBeenCalled(); expect(f.store.tasks()).toHaveLength(0);
    expect(notices.map(n=>n.text).join('\n')).toContain('model-original');
    expect(notices.map(n=>n.text).join('\n')).toContain('medium');
    expect(f.store.channel(JSON.stringify(['dm','alice'])).selection).toEqual(selection);
    await f.send('第二个'); expect(f.store.tasks()[0]).toMatchObject({projectId:'support',request:'修复页面提示'});
  });
  it('群聊查询只涉及绑定产品，元数据以私聊返回，不泄露其他成员与产品的任务', async () => {
    const f = fixture(); f.config.notifications={groupMode:'group'};
    f.config.projects.push({...f.config.projects[0]!,id:'support',name:'客服',chatIds:[]});
    f.service.submit('shop','alice','可见任务'); f.service.submit('shop','bob','其他成员的私聊'); f.service.submit('support','alice','其他产品的需求');
    const notices=await f.send('查看Agent状态','alice','group','group');
    const text=notices.map(n=>n.text).join('\n');
    expect(notices.every(n=>n.recipientType==='open_id'&&n.recipientId==='alice')).toBe(true);
    expect(text).toContain('可见任务'); expect(text).not.toContain('其他成员'); expect(text).not.toContain('其他产品');
    expect(f.store.tasks()).toHaveLength(3);
  });
  it('语义识别只建议概览意图，回复里的元数据仍由宿主产生', async () => {
    const f=fixture(); f.service.submit('shop','alice','价格改进');
    const decision: ConversationDecision={intent:'overview',taskId:null,title:'',confidence:'high',candidates:[],explanation:'询问分身运行情况',response:'使用编造的模型 fake-model'};
    f.interpret.mockResolvedValue({decision,usage:null,sessionId:null});
    const notices=await f.send('介绍下你的执行环境和手头的工作');
    expect(f.interpret).toHaveBeenCalledOnce();
    expect(notices.map(n=>n.text).join('\n')).toContain('model-original');
    expect(notices.map(n=>n.text).join('\n')).not.toContain('fake-model'); expect(f.store.tasks()).toHaveLength(1);
  });
  it('产品需求中的在线、模型与待办字样不会被当作机器人状态查询', async () => {
    const f=fixture(); await f.send('给产品增加在线状态和模型配置页面，展示待办任务');
    expect(f.store.tasks()).toHaveLength(1); expect(f.interpret).toHaveBeenCalledOnce();
    await f.send('新需求：增加 Agent 在线状态'); expect(f.store.tasks()).toHaveLength(2);
  });
  it('指定需求的状态询问仍走任务会话，不误判为全局概览', async () => {
    const f=fixture();const task=f.service.submit('shop','alice','订单排序');
    f.interpret.mockResolvedValue({decision:{intent:'status',taskId:task.id,title:'',confidence:'high',candidates:[],explanation:'指定订单排序',response:''},usage:null,sessionId:null});
    await f.send('查看订单排序任务状态');
    expect(f.interpret).toHaveBeenCalledOnce(); expect(f.store.pendingNotifications()[0]?.taskId).toBe(task.id);
  });
  it('询问元数据不会吞掉待确认会话的选择记录，也不会批准待决事项', async () => {
    const f=fixture(); const task=f.service.submit('shop','alice','等待确认');
    const key=JSON.stringify(['shop','dm','alice']); const context=f.store.conversation(key);
    context.selection={original:{id:'previous',actorId:'alice',chatId:'dm',replyTo:null,text:'同意'},choices:[{taskId:task.id,title:'等待确认',revision:task.revision,interactionId:null}],createdAt:new Date().toISOString()};
    f.store.saveConversation(key,context);
    await f.send('目前有什么待办任务？');
    expect(f.store.conversation(key).selection).toEqual(context.selection);
    expect(f.store.task(task.id).revision).toBe(task.revision); expect(f.interpret).not.toHaveBeenCalled();
  });
});
