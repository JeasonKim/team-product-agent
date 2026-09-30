import * as lark from '@larksuiteoapi/node-sdk';
import { AgentStore } from '../infra/store.js';
import { parseFeishuMessage } from './messages.js';
import { LarkCliTransport } from './lark-cli.js';
import { z } from 'zod';
import { open } from 'node:fs/promises';
import { addAbortSignal } from 'node:stream';
import { feishuContent } from './feishu-content.js';
import type { IncomingMessage } from '../domain/model.js';
import { MAX_ATTACHMENT_BYTES, type Attachment } from '../domain/attachments.js';
import type { AttachmentLibrary } from '../infra/attachments.js';

export function hydrateMessage(message: IncomingMessage, raw: unknown): IncomingMessage {
  const envelope = z.object({ code: z.number().optional(), data: z.unknown().optional(), items: z.unknown().optional() }).passthrough().parse(raw);
  if (envelope.code !== undefined && envelope.code !== 0) throw new Error('飞书原始消息读取失败');
  const result = z.object({ items: z.array(z.object({ message_id: z.string(), chat_id: z.string(), msg_type: z.string(), deleted: z.boolean().optional(), sender: z.object({ id: z.string(), sender_type: z.literal('user') }), body: z.object({ content: z.string() }) })) }).parse(envelope.data ?? envelope);
  const source = message.source ?? { messageId: message.id, chatId: message.chatId };
  const item = result.items.find(item => item.message_id === source.messageId);
  if (!item || item.deleted || item.chat_id !== source.chatId || item.sender.id !== message.actorId) throw new Error('原消息已不可用或发送者、聊天归属不一致，请重新发送');
  return { ...message, ...feishuContent(item.msg_type, item.body.content, source.messageId, process.env.FEISHU_BOT_OPEN_ID), needsHydration: false };
}

export class FeishuGateway {
  private readonly client?: lark.Client;
  private readonly socket?: lark.WSClient;
  private readonly cli?: LarkCliTransport;
  constructor(private readonly store: AgentStore) {
    if (process.env.FEISHU_CLI_PROFILE) { this.cli = new LarkCliTransport(process.env.FEISHU_CLI_PROFILE, process.env.FEISHU_BOT_OPEN_ID); return; }
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
    const httpInstance = Object.create(lark.defaultHttpInstance) as lark.HttpInstance;
    httpInstance.request = <T = unknown, R = T, D = unknown>(options: lark.HttpRequestOptions<D>) => lark.defaultHttpInstance.request({ ...options, timeout: 60_000 }) as Promise<R>;
    this.client = new lark.Client({ appId, appSecret, httpInstance, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error });
    this.socket = new lark.WSClient({ appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error });
  }
  async connect(onFailure: (error: Error) => void): Promise<void> {
    if (this.cli) return this.cli.connect(message => { this.store.enqueueMessage(message); }, onFailure);
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        const message = parseFeishuMessage(data, process.env.FEISHU_BOT_OPEN_ID);
        if (message) this.store.enqueueMessage(message);
        // 只做本地持久化并返回，长任务由队列执行，满足飞书回调时限。
      },
    });
    await this.socket!.start({ eventDispatcher });
  }
  async prepareMessage(original: IncomingMessage, library: AttachmentLibrary, signal: AbortSignal): Promise<IncomingMessage> {
    let message = original;
    if (message.needsHydration) {
      if (!['image', 'file', 'post'].includes(message.messageType ?? '')) return { ...message, needsHydration: false, problem: '暂不支持这类消息，请改发文字、截图或参考文档。' };
      message = hydrateMessage(message, await this.cli!.messageContent(message.source?.messageId ?? message.id, signal));
    }
    if (message.problem || !message.attachments?.length) return message;
    return { ...message, attachments: await library.receive(message.attachments, (item, path, signal) => this.download(item, path, signal), signal) };
  }
  private async download(item: Attachment, destination: string, signal: AbortSignal): Promise<void> {
    if (this.cli) return this.cli.download(item, destination, signal);
    signal.throwIfAborted();
    const result = await this.client!.im.messageResource.get({ path: { message_id: item.messageId, file_key: item.key }, params: { type: item.kind } });
    const stream = addAbortSignal(AbortSignal.any([signal, AbortSignal.timeout(60_000)]), result.getReadableStream());
    const output = await open(destination, 'wx', 0o600); let size = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 20 MB，请压缩后发送');
        await output.write(bytes);
      }
    } finally { stream.destroy(); await output.close(); }
  }
  async deliverPending(): Promise<void> {
    for (const notification of this.store.pendingNotifications()) {
      try {
        let messageId: string;
        if (this.cli) messageId = await this.cli.send(notification);
        else {
          const result = await this.client!.im.message.create({ params: { receive_id_type: notification.recipientType }, data: { receive_id: notification.recipientId, msg_type: 'text', content: JSON.stringify({ text: notification.text.slice(0,12_000) }), uuid: notification.id } });
          if (result.code !== 0 || !result.data?.message_id) throw new Error(`飞书消息发送失败：${result.code} ${result.msg}`);
          messageId = result.data.message_id;
        }
        this.store.delivered(notification.id, messageId);
      } catch (error) {
        console.warn('消息投递失败，按原 UUID 重试', { notificationId: notification.id, error: String(error) });
        this.store.deliveryFailed(notification.id, String(error));
      }
    }
  }
  async disconnect(): Promise<void> { if (this.cli) await this.cli.disconnect(); else this.socket?.close({ force: true }); }
}
