import * as lark from '@larksuiteoapi/node-sdk';
import { AgentStore } from '../infra/store.js';
import { parseFeishuMessage } from './messages.js';
import { LarkCliTransport } from './lark-cli.js';

export class FeishuGateway {
  private readonly client?: lark.Client;
  private readonly socket?: lark.WSClient;
  private readonly cli?: LarkCliTransport;
  constructor(private readonly store: AgentStore) {
    if (process.env.FEISHU_CLI_PROFILE) { this.cli = new LarkCliTransport(process.env.FEISHU_CLI_PROFILE, process.env.FEISHU_BOT_OPEN_ID); return; }
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
    this.client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error });
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
