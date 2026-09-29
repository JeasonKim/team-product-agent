import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type { IncomingMessage, Notification } from '../domain/model.js';
import { minimalEnvironment } from '../infra/process.js';
import { parseFeishuMessage } from './messages.js';

const cliEvent = z.object({
  type: z.literal('im.message.receive_v1'), message_id: z.string().min(1),
  sender_id: z.string().min(1), sender_type: z.literal('user'), chat_id: z.string().min(1),
  chat_type: z.enum(['group', 'p2p']), message_type: z.literal('text'), content: z.string(),
  create_time: z.union([z.string(), z.number()]).transform(String).optional(),
  mentions: z.array(z.object({ key: z.string(), id: z.string(), name: z.string().optional() })).optional(), reply_to: z.string().optional(),
});
export function parseLarkCliMessage(raw: unknown, botId?: string): IncomingMessage | null {
  const result = cliEvent.safeParse(raw);
  if (!result.success) return null;
  const event = result.data;
  let content = event.content;
  for (const mention of event.mentions ?? []) {
    if (mention.id === botId && mention.name) content = content.replaceAll(`@${mention.name}`, '');
  }
  return parseFeishuMessage({
    sender: { sender_type: event.sender_type, sender_id: { open_id: event.sender_id } },
    message: { ...event, content: JSON.stringify({ text: content }), parent_id: event.reply_to, mentions: event.mentions?.map(mention => ({ key: mention.key, id: { open_id: mention.id } })) },
  }, botId);
}

export class LarkCliTransport {
  private consumer?: ChildProcessWithoutNullStreams;
  private closing = false;
  private closed = false;
  constructor(private readonly profile: string, private readonly botId?: string, private readonly executable = process.env.FEISHU_CLI_PATH || 'lark-cli') {}
  private launch(args: string[]): ChildProcessWithoutNullStreams {
    const env = minimalEnvironment({ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' });
    // 凭证仍由 CLI 的系统密钥链管理，不读取或复制应用密钥。
    if (process.env.HOME) env.HOME = process.env.HOME;
    return spawn(this.executable, ['--profile', this.profile, ...args], { shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  async connect(receive: (message: IncomingMessage) => void, onFailure: (error: Error) => void): Promise<void> {
    const child = this.launch(['event', 'consume', 'im.message.receive_v1', '--as', 'bot']);
    this.consumer = child;
    return new Promise((resolve, reject) => {
      let ready = false; let failed = false; let pending = ''; let diagnostics = '';
      const fail = (error: Error) => {
        if (failed || this.closing) return;
        failed = true; clearTimeout(timer);
        if (ready) onFailure(error); else reject(error);
        child.stdin.end();
      };
      const timer = setTimeout(() => { fail(new Error('飞书 CLI 订阅未在 30 秒内就绪')); child.kill('SIGTERM'); }, 30_000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        diagnostics = (diagnostics + chunk).slice(-4096);
        if (!ready && !failed && diagnostics.includes('[event] ready event_key=im.message.receive_v1')) { ready = true; clearTimeout(timer); resolve(); }
      });
      child.stdout.on('data', (chunk: string) => {
        pending += chunk;
        if (pending.length > 1_000_000) { fail(new Error('飞书 CLI 事件超过大小限制')); return; }
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
          if (!line || failed || this.closing) continue;
          try {
            const raw = JSON.parse(line);
            const message = parseLarkCliMessage(raw, this.botId);
            if (message) receive(message);
            else if (raw.message_type === 'text' && !raw.sender_type) fail(new Error('lark-cli 缺少 sender_type，请使用 1.0.80 或以上版本并设置 FEISHU_CLI_PATH'));
          }
          catch (error) { fail(new Error(`飞书 CLI 事件接收失败：${String(error)}`)); }
        }
      });
      child.once('error', fail);
      child.once('close', (code, signal) => { this.closed = true; clearTimeout(timer); fail(new Error(`飞书 CLI 订阅退出：${code ?? signal} ${diagnostics}`)); });
    });
  }
  async send(notification: Notification): Promise<string> {
    const child = this.launch(['im', '+messages-send', '--as', 'bot', notification.recipientType === 'chat_id' ? '--chat-id' : '--user-id', notification.recipientId, '--text', notification.text.slice(0, 12_000), '--idempotency-key', notification.id]);
    child.stdin.end();
    return new Promise<string>((resolve, reject) => {
      let output = ''; let diagnostic = ''; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); reject(new Error('飞书 CLI 发送超时，保留通知 UUID 重试')); }, 30_000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output = (output + chunk).slice(-64_000); });
      child.stderr.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-4096); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output);
          if (timedOut || code !== 0 || result.ok !== true || !result.data?.message_id) throw new Error(`${output} ${diagnostic}`);
          resolve(String(result.data.message_id));
        } catch (error) { reject(new Error(`飞书消息发送失败：${String(error)}`)); }
      });
    });
  }
  async disconnect(): Promise<void> {
    this.closing = true;
    const child = this.consumer;
    if (!child || this.closed) return;
    await new Promise<void>((resolve, reject) => {
      const terminate = setTimeout(() => child.kill('SIGTERM'), 5000);
      const timeout = setTimeout(() => { clearTimeout(terminate); reject(new Error('飞书 CLI 订阅未正常退出，请检查 event status')); }, 10_000);
      child.once('close', () => { clearTimeout(terminate); clearTimeout(timeout); resolve(); });
      child.stdin.end();
    });
  }
}
