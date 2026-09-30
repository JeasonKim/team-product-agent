import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Task } from '../domain/model.js';
import type { TaskService } from '../service.js';
import { choiceNumber, isActivityQuery, isApproval, isBareApproval, reference, statusLabels, taskTitle, type ConversationContext, type ConversationDecision, type ConversationInput, type ConversationInterpreter, type MessageLink, type TaskReference } from '../domain/conversation.js';
import { activityReply } from '../domain/activity.js';
import { feishuContent } from './feishu-content.js';
import { mergeAttachments } from '../domain/attachments.js';

export type PrepareMessage = (message: IncomingMessage, signal: AbortSignal) => Promise<IncomingMessage>;

const eventSchema = z.object({
  sender: z.object({ sender_type: z.literal('user'), sender_id: z.object({ open_id: z.string().min(1) }) }),
  message: z.object({ message_id: z.string().min(1), chat_id: z.string().min(1), chat_type: z.string(), message_type: z.string(), content: z.string(), create_time: z.string().optional(), parent_id: z.string().optional(), mentions: z.array(z.object({ key: z.string(), id: z.object({ open_id: z.string().optional() }) })).optional() }),
});
export function parseFeishuMessage(raw: unknown, botId?: string): IncomingMessage | null {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { sender, message } = parsed.data;
  const addressed = !!botId && !!message.mentions?.some(mention => mention.id.open_id === botId);
  if (message.chat_type === 'group' && !addressed && !message.parent_id) return null;
  const content = feishuContent(message.message_type, message.content, message.message_id, botId);
  let text = content.text;
  for (const mention of message.mentions ?? []) if (mention.id.open_id === botId) text = text.replaceAll(mention.key, '');
  return { ...content, id: message.message_id, actorId: sender.sender_id.open_id, chatId: message.chat_id, chatType: message.chat_type === 'group' ? 'group' : 'p2p', text: text.trim(), replyTo: message.parent_id ?? null, createdAt: messageTime(message.create_time), ...(message.chat_type === 'group' && !addressed ? { addressedToBot: false } : {}) };
}
export function messageTime(value: string | number | undefined): string | undefined {
  const milliseconds = Number(value);
  return value !== undefined && Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 8.64e15 ? new Date(milliseconds).toISOString() : undefined;
}
type Action = { type: 'reply'; taskId: string; interactionId: string; answer: string } | { type: 'status' | 'cancel' | 'retry'; taskId: string } | { type: 'request'; text: string };
export function parseAction(text: string): Action {
  const normalized = text.trim();
  const reply = /^(同意|拒绝|回答)\s+([a-f0-9]{8})\s+([a-f0-9]{8})(?:\s+([\s\S]+))?$/.exec(normalized);
  if (reply) return { type: 'reply', taskId: reply[2]!, interactionId: reply[3]!, answer: reply[1] === '同意' ? 'approve' : reply[1] === '拒绝' ? `reject:${reply[4] ?? '未提供原因'}` : reply[4] ?? '' };
  const task = /^(状态|取消|重试)\s+([a-f0-9]{8})$/.exec(normalized);
  if (task) return { type: task[1] === '状态' ? 'status' : task[1] === '取消' ? 'cancel' : 'retry', taskId: task[2]! };
  return { type: 'request', text: normalized.replace(/^新需求\s*/, '') };
}
export class MessageRouter {
  private dispatching?: Promise<void>;
  constructor(private readonly service: TaskService, private readonly interpreter: ConversationInterpreter = service, private readonly signal = new AbortController().signal, private readonly prepareMessage?: PrepareMessage) {}
  dispatchPending(): Promise<void> {
    this.dispatching ??= this.drain().finally(() => { this.dispatching = undefined; });
    return this.dispatching;
  }
  private async drain(): Promise<void> {
    for (const message of this.service.store.pendingMessages()) {
      this.signal.throwIfAborted();
      try {
        // SDK 网络调用不能放在 SQLite 事务内；结果应用与收件确认必须在同一事务中。
        const apply = await this.prepare(message);
        this.signal.throwIfAborted();
        this.service.store.transaction(() => { apply(); this.service.store.acknowledgeMessage(message.id); });
      } catch (error) {
        this.signal.throwIfAborted();
        console.warn('消息未执行', { messageId: message.id, reason: String(error) });
        this.service.store.transaction(() => {
          if (this.service.config.projects.some(project => this.service.canAccess(project, message.actorId))) this.respond(message, `这次没有执行：${error instanceof Error ? error.message : '请求无法处理'}`);
          this.service.store.acknowledgeMessage(message.id);
        });
      }
    }
  }
  private async prepare(message: IncomingMessage): Promise<() => void> {
    // 群聊的附件引用必须指向本机器人已经记录且该成员可见的消息。
    const quoted = message.replyTo ? this.service.store.messageLink(message.replyTo) : null;
    if (message.chatType === 'group' && message.addressedToBot === false && (!quoted?.taskId || !this.visibleLink(quoted, message))) return () => {};
    const accessible = this.service.config.projects.filter(project => this.service.canAccess(project, message.actorId));
    if (!accessible.length) return () => this.service.requestAccess(message);
    const bound = this.service.config.projects.find(project => project.chatIds.includes(message.chatId));
    if (bound && !this.service.canAccess(bound, message.actorId)) return () => this.service.requestAccess(message);
    if (this.prepareMessage && (message.needsHydration || message.attachments?.some(item => item.status === 'pending'))) {
      message = await this.prepareMessage(message, this.signal);
      this.service.store.preserveMessage(message);
    }
    if (message.needsHydration) throw new Error('附件读取通道未就绪，请稍后重新发送');
    if (message.problem) return () => { this.service.store.audit('message.unsupported', message.actorId, null, { messageId: message.id, problem: message.problem }); this.respond(message, message.problem!); };
    if ((!message.text.trim() && !message.attachments?.length) || message.text.length > 20_000) throw new Error('请用一段不超过 20000 字的文字说明想做的事');
    const action = message.attachments?.length ? { type: 'request' as const, text: message.text } : parseAction(message.text);
    if (action.type !== 'request') return () => this.legacy(message, action);
    if (!message.attachments?.length && isActivityQuery(message.text)) return () => this.reportActivity(message, bound?.id);
    const link = message.replyTo ? this.service.store.messageLink(message.replyTo) : null;
    const scopedLink = link && this.visibleLink(link, message) ? link : null;
    const channelKey = JSON.stringify([message.chatId, message.actorId]);
    const channel = this.service.store.channel(channelKey);
    const selecting = /^(切换|选择)(项目|产品)[。！!\s]*$/.test(message.text);
    const chooseProject = (original: IncomingMessage | null): (() => void) => () => {
      channel.selection = { projectIds: accessible.map(p => p.id), original, createdAt: new Date().toISOString() };
      this.service.store.saveChannel(channelKey, channel);
      this.respond(message, `这次要改哪个产品？\n\n${accessible.map((p, index) => `${index + 1}. ${p.name}`).join('\n')}\n\n回复序号即可，我会记住选择。之后说“切换产品”可以更换。`);
    };
    if (!bound && selecting) return chooseProject(null);
    if (!bound && channel.selection) {
      const selection = channel.selection;
      const ordinal = choiceNumber(message.text);
      if (Date.now() - Date.parse(selection.createdAt) > 30 * 60_000) return chooseProject(ordinal === null ? message : selection.original);
      const selectedId = ordinal !== null ? selection.projectIds[ordinal - 1] : accessible.find(p => p.name === message.text.trim())?.id;
      const selected = accessible.find(p => p.id === selectedId);
      if (selected) {
        channel.projectId = selected.id; channel.selection = null;
        if (!selection.original) return () => { this.service.store.saveChannel(channelKey, channel); this.respond(message, `已切换到「${selected.name}」。直接告诉我想改什么即可。`); };
        message = { ...selection.original, id: message.id };
      } else return chooseProject(ordinal === null ? message : selection.original);
    }
    const linkedProject = scopedLink?.taskId ? this.service.store.task(scopedLink.taskId).projectId : null;
    const project = bound ?? (linkedProject ? accessible.find(project => project.id === linkedProject) : accessible.find(p => p.id === channel.projectId) ?? (accessible.length === 1 ? accessible[0] : undefined));
    if (project && !this.service.canAccess(project, message.actorId)) return () => this.service.requestAccess(message);
    if (!project) return chooseProject(message);
    channel.projectId = project.id;
    // 私聊只呈现自己提出的会话或负责人有权处理的会话，群聊不混入其他群的历史。
    const tasks = this.service.store.tasks().filter(task => task.projectId === project.id && (task.requesterId === message.actorId || project.ownerIds.includes(message.actorId)) && (!bound || task.chatId === message.chatId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const key = JSON.stringify([project.id, message.chatId, message.actorId]);
    const context = this.service.store.conversation(key);
    // 先发资料后描述需求时，材料暂存在同一产品、聊天和成员的上下文中。
    const pending = context.pendingMaterials;
    if (pending && Date.now() - Date.parse(pending.createdAt ?? '') > 30 * 60_000) {
      this.service.store.audit('attachments.expired', message.actorId, null, { messageId: pending.id, attachmentIds: pending.attachments?.map(item => item.id) });
      delete context.pendingMaterials;
      this.respond(message, '之前暂存的附件已超过 30 分钟，没有自动带入这次需求；如仍需参考，请重新发送。', context);
    } else if (pending && !context.selection) {
      message = { ...message, attachments: mergeAttachments(pending.attachments, message.attachments) };
    }
    let original = message;
    const finish = (apply: () => string | null): (() => void) => () => {
      const userTurn = { role: 'user' as const, text: message.text.slice(0, 2000), taskId: null as string | null, at: message.createdAt ?? new Date().toISOString() };
      context.turns.push(userTurn);
      const taskId = apply();
      userTurn.taskId = taskId;
      context.turns = context.turns.slice(-12);
      if (taskId) {
        context.focusTaskId = taskId; delete context.pendingMaterials; this.service.store.linkIncoming(message, taskId);
        for (const item of this.service.store.task(taskId).attachments ?? []) if (original.attachments?.some(incoming => incoming.id === item.id)) this.service.store.linkIncoming({ ...original, id: item.messageId }, taskId);
      } else if (original.attachments?.length && !context.selection) {
        context.pendingMaterials = { ...original, createdAt: new Date().toISOString() };
      }
      this.service.store.audit('conversation.message', message.actorId, taskId, { messageId: message.id, text: message.text, chatId: message.chatId, attachments: original.attachments });
      this.service.store.saveConversation(key, context);
      this.service.store.saveChannel(channelKey, channel);
    };
    if (!message.text.trim() && message.attachments?.length && !tasks.length) return finish(() => {
      context.pendingMaterials = { ...message, createdAt: new Date().toISOString() };
      this.respond(message, `已保存 ${message.attachments!.length} 个参考附件。接着说一下希望改什么、达到什么效果，我会一起处理。${message.attachments!.filter(item => item.error).map(item => `\n${item.name}：${item.error}`).join('')}`, context); return null;
    });
    if (!message.attachments?.length && /^(谢谢[你啦]?|多谢|辛苦了|你好|嗨|收到)[。！!\s]*$/.test(message.text.trim())) return finish(() => { this.respond(message, `我在。你可以直接描述想改的功能，我会先了解现状，再实现并检查。当前产品是「${project.name}」。`, context); return null; });
    const possibleChoice = choiceNumber(message.text);
    const ordinal = !context.selection && !/第|个|项|条|选/.test(message.text) && tasks.some(task => task.interaction?.kind === 'clarification') ? null : possibleChoice;
    let selected: TaskReference | undefined;
    let boundTaskId = scopedLink?.taskId ?? null;
    if (ordinal !== null) {
      const selection = context.selection;
      selected = selection?.choices[ordinal - 1];
      if (!selection || !selected || Date.now() - Date.parse(selection.createdAt) > 30 * 60_000) return finish(() => { context.selection = null; this.respond(message, '这条回复没有对应的选择列表。可以说一下需求标题，例如“价格那个再改一下”，或直接说明新需求。', context); return null; });
      const current = tasks.find(task => task.id === selected!.taskId);
      if (!current || (!selection.original.attachments?.length && !this.sameReference(current, selected))) return finish(() => { context.selection = null; this.respond(message, '刚才那个会话已经有了新的进展，原来的选择已失效。请根据最新消息再说一次你的想法。', context, current); return null; });
      original = selection.original; boundTaskId = selected.taskId;
    }
    const lastTurn = context.turns.filter(turn => turn.role === 'user').at(-1);
    const nearby = lastTurn?.taskId && Date.now() - Date.parse(lastTurn.at) <= 2 * 60_000 ? tasks.find(task => task.id === lastTurn.taskId && task.status !== 'cancelled') : undefined;
    if (original.attachments?.length && !original.text.trim()) boundTaskId ??= nearby?.id ?? null;
    const boundTask = tasks.find(task => task.id === boundTaskId);
    const input: ConversationInput = { project, message: original, tasks: boundTask ? [boundTask, ...tasks.filter(task => task.id !== boundTaskId)] : tasks, context, boundTaskId, signal: this.signal };
    // 已由用户选定目标后，明确的同意无需让模型再猜一次。仍在下方校验方案和送达时间。
    let decision: ConversationDecision | null = selected && isApproval(original.text) ? { intent: 'approve', taskId: selected.taskId, title: '', confidence: 'high', candidates: [], explanation: '用户已选择会话', response: '' } : null;
    if (original.attachments?.length && (selected || !original.text.trim() && boundTask)) decision = { intent: 'followup', taskId: boundTaskId, title: '', confidence: 'high', candidates: [], explanation: '将参考附件补充到明确的会话', response: '' };
    if (original.attachments?.length && !original.text.trim() && !boundTask) return finish(() => { this.choose(message, original, tasks.filter(task => task.status !== 'cancelled'), context, '这些参考资料属于哪个需求？'); return null; });
    if (/^新需求(?:[：:\s]|$)/.test(original.text.trim())) decision = { intent: 'new', taskId: null, title: original.text.replace(/^新需求[：:\s]*/, '').slice(0,40), confidence: 'high', candidates: [], explanation: '用户明确提出独立新需求', response: '' };
    if (!decision) {
      const started = Date.now();
      try {
        const result = await this.interpreter.interpret(input);
        decision = result.decision;
        this.service.store.recordRouting({ messageId: message.id, engine: project.engine, model: project.models[project.engine] ?? null, candidates: input.tasks.map(reference), result, error: null, durationMs: Date.now() - started, createdAt: new Date().toISOString() });
      } catch (error) {
        this.service.store.recordRouting({ messageId: message.id, engine: project.engine, model: project.models[project.engine] ?? null, candidates: input.tasks.map(reference), result: null, error: String(error), durationMs: Date.now() - started, createdAt: new Date().toISOString() });
        this.signal.throwIfAborted();
        return finish(() => { this.choose(message, original, tasks.filter(task => task.status !== 'cancelled'), context, '这次没有识别清楚。'); return null; });
      }
    }
    const proposal = original.attachments?.length && ['approve','reject'].includes(decision.intent) ? { ...decision, intent: 'followup' as const } : decision;
    const target = input.tasks.find(task => task.id === proposal.taskId);
    const snapshot = selected ?? (target ? reference(target) : null);
    if (proposal.intent === 'overview' && proposal.confidence === 'high') return finish(() => { this.reportActivity(message, project.id); return null; });
    return finish(() => {
      context.selection = null;
      const pending = tasks.filter(task => task.interaction && task.interaction.kind !== 'clarification' && this.service.store.wasPresented(task.id, task.interaction.id, original));
      if (!boundTaskId && isBareApproval(original.text) && pending.length > 1) {
        const preferred = proposal.candidates.map(id => pending.find(task => task.id === id)).filter((task): task is Task => Boolean(task));
        this.choose(message, original, [...preferred, ...pending], context); return null;
      }
      if (proposal.intent === 'ambiguous' || proposal.confidence !== 'high') {
        const candidates = proposal.candidates.map(id => tasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task));
        this.choose(message, original, candidates.length ? candidates : tasks.filter(task => task.status !== 'cancelled'), context); return null;
      }
      if (proposal.intent === 'chat') { this.respond(message, proposal.response || '可以直接描述要改的功能；补充旧需求时也可以提一下它的标题。', context); return null; }
      if (proposal.intent === 'new') {
        if (isBareApproval(original.text) || ordinal !== null) { this.choose(message, original, pending, context); return null; }
        return this.service.submit(project.id, message.actorId, original.text.replace(/^新需求[：:\s]*/, ''), message.chatId, proposal.title, message.chatType, original.attachments).id;
      }
      if (!target || !snapshot || (boundTaskId && target.id !== boundTaskId)) { this.choose(message, original, tasks, context); return null; }
      const current = this.service.store.task(target.id);
      if (['approve', 'reject', 'reply'].includes(proposal.intent) && !this.sameReference(current, snapshot)) { this.respond(message, '这个会话刚有了新的进展，这条回复暂时没有执行。请根据最新消息再确认一下。', context, current); return current.id; }
      if (['approve', 'reject', 'reply'].includes(proposal.intent)) {
        const interaction = current.interaction;
        if (!interaction || (scopedLink?.interactionId && scopedLink.interactionId !== interaction.id) || !this.service.store.wasPresented(current.id, interaction.id, original)) {
          this.respond(message, '你回复的方案或问题已过期，或在你发消息时尚未送达。请看当前进展后再回复。', context, current); return current.id;
        }
        if (proposal.intent === 'approve') {
          if (!isApproval(original.text)) { this.respond(message, '这句话还包含条件或保留意见，我先不按同意处理。你可以直接说明要补充的内容，确认当前方案时说“同意”即可。', context, current); return current.id; }
          if (interaction.kind === 'clarification') { this.respond(message, '这里还需要你的具体想法，单说同意暂时无法继续。', context, current); return current.id; }
          this.service.reply(current.id, interaction.id, message.actorId, 'approve');
        } else if (proposal.intent === 'reject') this.service.reply(current.id, interaction.id, message.actorId, `reject:${original.text}`);
        else if (interaction.kind === 'clarification') this.service.reply(current.id, interaction.id, message.actorId, original.text, original.attachments);
        else this.service.followUp(current.id, message.actorId, original.text, original.attachments);
      } else if (proposal.intent === 'followup') this.service.followUp(current.id, message.actorId, original.text.trim() || '补充参考资料，请结合原需求检查', original.attachments);
      else if (proposal.intent === 'cancel') this.service.cancel(current.id, message.actorId);
      else if (proposal.intent === 'retry') this.service.retry(current.id, message.actorId);
      else this.respond(message, `「${taskTitle(current)}」${statusLabels[current.status]}\n${current.summary}${current.interaction ? `\n\n${current.interaction.question}` : ''}`, context, current);
      const attached = original.attachments?.filter(item => this.service.store.task(current.id).attachments?.some(saved => saved.id === item.id)) ?? [];
      if (attached.length) this.respond(message, `已将 ${attached.length} 个附件加入「${taskTitle(current)}」。${attached.filter(item => item.error || item.warning).map(item => `\n${item.name}：${item.error ?? item.warning}`).join('')}`, context, this.service.store.task(current.id));
      return current.id;
    });
  }
  private reportActivity(message: IncomingMessage, projectId?: string): void {
    const activity = this.service.activity(message.actorId, projectId);
    // 即使项目设置为群内沟通，成员的任务清单也只回给查询者本人。
    this.service.store.notify({ id: randomUUID(), taskId: null, recipientType: 'open_id', recipientId: message.actorId, text: activityReply(activity), createdAt: new Date().toISOString() });
    this.service.store.audit('agent.activity_viewed', message.actorId, null, { messageId: message.id, projectIds: activity.projects.map(project => project.id) });
  }
  private sameReference(task: Task, snapshot: TaskReference): boolean { return task.revision === snapshot.revision && (task.interaction?.id ?? null) === snapshot.interactionId; }
  private visibleLink(link: MessageLink, message: IncomingMessage): boolean { return link.recipientType === 'chat_id' ? link.recipientId === message.chatId : link.recipientId === message.actorId; }
  private choose(message: IncomingMessage, original: IncomingMessage, tasks: Task[], context: ConversationContext, prefix = '这句话是接着哪件事说的？'): void {
    const choices = [...new Map(tasks.map(task => [task.id, this.service.store.task(task.id)])).values()].slice(0, 8);
    context.selection = choices.length ? { original, choices: choices.map(reference), createdAt: new Date().toISOString() } : null;
    const text = choices.length ? `${prefix}\n\n${choices.map((task, index) => `${index + 1}. ${taskTitle(task)}（${statusLabels[task.status]}）`).join('\n')}\n\n回复“第几个”即可。若是另一件新需求，直接说“新需求：…”并描述想改的内容。` : '还没有找到对应的会话。请简单说一下你想改哪个功能、希望变成什么样。';
    this.respond(message, text, context);
  }
  private legacy(message: IncomingMessage, action: Exclude<Action, { type: 'request' }>): void {
    const task = this.service.store.task(action.taskId);
    if (!this.service.canAccess(this.service.project(task.projectId), message.actorId)) throw new Error('没有此项目的访问权限');
    // 跨项目群中的命令不回显任务详情；负责人私聊可处理系统推送的决定。
    const bound = this.service.config.projects.find(project => project.chatIds.includes(message.chatId));
    if (bound && bound.id !== task.projectId) throw new Error('请在任务所属项目的聊天中操作');
    if (action.type === 'reply') this.service.reply(task.id, action.interactionId, message.actorId, action.answer);
    if (action.type === 'cancel') this.service.cancel(task.id, message.actorId);
    if (action.type === 'retry') this.service.retry(task.id, message.actorId);
    if (action.type === 'status') this.respond(message, `「${taskTitle(task)}」${statusLabels[task.status]}\n${task.summary}${task.interaction ? `\n${task.interaction.question}` : ''}`, undefined, task);
  }
  private respond(message: IncomingMessage, text: string, context?: ConversationContext, task?: Task): void {
    const inGroup = this.service.config.notifications?.groupMode === 'group' && this.service.config.projects.some(project => project.chatIds.includes(message.chatId) && this.service.canAccess(project, message.actorId));
    const createdAt = new Date().toISOString();
    if (task?.interaction && !text.includes(task.interaction.question)) text += `\n\n「${taskTitle(task)}」当前需要回复：\n${task.interaction.question}`;
    this.service.store.notify({ id: randomUUID(), taskId: task?.id ?? null, interactionId: task?.interaction?.id, recipientType: inGroup ? 'chat_id' : 'open_id', recipientId: inGroup ? message.chatId : message.actorId, text, createdAt });
    context?.turns.push({ role: 'assistant', text: text.slice(0, 2000), taskId: task?.id ?? null, at: createdAt });
  }
}
