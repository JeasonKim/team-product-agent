import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { LarkCliTransport, parseLarkCliMessage } from '../src/adapters/lark-cli.js';
import { attachment } from '../src/domain/attachments.js';

const raw = { type: 'im.message.receive_v1', message_id: 'm1', sender_id: 'user', sender_type: 'user', chat_id: 'chat', chat_type: 'group', message_type: 'text', content: '@_user_1 删除未下载的项目', mentions: [{ key: '@_user_1', id: 'bot' }] };
function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null, signalCode: null });
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
describe('lark-cli 接入', () => {
  it('原始消息与附件下载使用同一机器人身份，下载路径相对受控目录', async () => {
    const transport = new LarkCliTransport('profile', 'bot', '/selected/lark-cli');
    const getter = child(); mocks.spawn.mockReturnValueOnce(getter);
    const received = transport.messageContent('om_demo', new AbortController().signal);
    getter.stdout.write(JSON.stringify({ ok: true, data: { items: [] } })); getter.emit('close', 0);
    expect(await received).toEqual({ items: [] });
    expect(mocks.spawn.mock.calls[0]![1]).toEqual(['--profile', 'profile', 'api', 'GET', '/open-apis/im/v1/messages/om_demo', '--as', 'bot', '--params', JSON.stringify({ user_id_type: 'open_id' })]);
    const downloader = child(); mocks.spawn.mockReturnValueOnce(downloader);
    const downloaded = transport.download(attachment('om_demo', 'img_demo', 'image'), '/tmp/task-assets/download.bin', new AbortController().signal);
    downloader.stdout.write(JSON.stringify({ ok: true, data: {} })); downloader.emit('close', 0); await downloaded;
    expect(mocks.spawn.mock.calls[1]![1]).toEqual(['--profile', 'profile', 'im', '+messages-resources-download', '--as', 'bot', '--message-id', 'om_demo', '--file-key', 'img_demo', '--type', 'image', '--output', 'download.bin']);
    expect(mocks.spawn.mock.calls[1]![2]).toMatchObject({ cwd: '/tmp/task-assets', shell: false });
  });
  it('附件下载取消会终止进程，权限错误明确失败', async () => {
    const transport = new LarkCliTransport('profile'); const aborted = child(); mocks.spawn.mockReturnValueOnce(aborted);
    const control = new AbortController(); const received = transport.messageContent('om_demo', control.signal);
    const assertion = expect(received).rejects.toThrow(/取消/); control.abort(); expect(aborted.kill).toHaveBeenCalledWith('SIGTERM'); aborted.emit('close', 1); await assertion;
    const denied = child(); mocks.spawn.mockReturnValueOnce(denied);
    const error = expect(transport.messageContent('om_demo', new AbortController().signal)).rejects.toThrow(/消息读取权限/);
    denied.stderr.write(JSON.stringify({ ok: false, error: { message: 'missing scope' } })); denied.emit('close', 3); await error;
  });
  it('按 CLI 的平铺协议读取纯文本，只接收用户发给当前机器人的消息', () => {
    expect(parseLarkCliMessage(raw, 'bot')).toEqual({ id: 'm1', actorId: 'user', chatId: 'chat', chatType: 'group', text: '删除未下载的项目', replyTo: null });
    expect(parseLarkCliMessage(raw, 'other')).toBeNull();
    expect(parseLarkCliMessage({ ...raw, sender_type: 'bot' }, 'bot')).toBeNull();
    expect(parseLarkCliMessage({ ...raw, message_type: 'post' }, 'bot')).toMatchObject({ messageType: 'post', needsHydration: true });
    expect(parseLarkCliMessage({ ...raw, content: '{不是 JSON}', chat_type: 'p2p' }, 'bot')?.text).toBe('{不是 JSON}');
    expect(parseLarkCliMessage({ ...raw, sender_id: '' }, 'bot')).toBeNull();
    expect(parseLarkCliMessage({ ...raw, content: '@研发分身 删除条目', mentions: [{ key: '@_user_1', id: 'bot', name: '研发分身' }] }, 'bot')?.text).toBe('删除条目');
    expect(parseLarkCliMessage({ ...raw, create_time: '1790640000000', reply_to: 'previous-bot-message' }, 'bot')).toMatchObject({ createdAt: new Date(1790640000000).toISOString(), replyTo: 'previous-bot-message' });
    expect(parseLarkCliMessage({ ...raw, content: '可以 @研发分身', mentions: [{ key: '@_user_1', id: 'bot', name: '研发分身' }] }, 'bot')?.text).toBe('可以');
  });
  it('等待订阅 ready，处理分片 NDJSON，订阅退出后明确报告失败', async () => {
    const process = child(); mocks.spawn.mockReturnValue(process);
    const transport = new LarkCliTransport('profile', 'bot', '/selected/lark-cli');
    const receive = vi.fn(); const failed = vi.fn();
    const connected = transport.connect(receive, failed);
    process.stderr.write('[event] ready event_key=im.message.');
    process.stderr.write('receive_v1\n');
    await connected;
    const line = JSON.stringify(raw);
    process.stdout.write(line.slice(0, 40)); process.stdout.write(`${line.slice(40)}\n`);
    expect(receive).toHaveBeenCalledOnce();
    process.emit('close', 1, null);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('退出') }));
    expect(mocks.spawn.mock.calls[0]![1]).toEqual(['--profile', 'profile', 'event', 'consume', 'im.message.receive_v1', '--as', 'bot']);
    expect(mocks.spawn.mock.calls[0]![0]).toBe('/selected/lark-cli');
  });
  it('启动失败不能报告连接成功', async () => {
    const process = child(); mocks.spawn.mockReturnValue(process);
    const connected = new LarkCliTransport('profile', 'bot').connect(vi.fn(), vi.fn());
    const assertion = expect(connected).rejects.toThrow(/ENOENT/);
    process.emit('error', new Error('ENOENT'));
    await assertion;
  });
  it('旧 CLI 缺少发送人身份时停止接入，不能猜测身份或静默丢消息', async () => {
    const process = child(); mocks.spawn.mockReturnValue(process);
    const receive = vi.fn(); const failed = vi.fn();
    const connected = new LarkCliTransport('profile', 'bot').connect(receive, failed);
    process.stderr.write('[event] ready event_key=im.message.receive_v1\n'); await connected;
    process.stdout.write(`${JSON.stringify({ ...raw, sender_type: undefined })}\n`);
    expect(receive).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('FEISHU_CLI_PATH') }));
    process.emit('close', 0, null);
    expect(failed).toHaveBeenCalledOnce();
  });
  it('发送使用固定身份和通知 UUID，非成功 JSON 必须保留重试', async () => {
    const process = child(); mocks.spawn.mockReturnValue(process);
    const notification = { id: 'notification-uuid', taskId: null, recipientType: 'chat_id' as const, recipientId: 'chat', text: '内容 $() `literal`', createdAt: '' };
    const transport = new LarkCliTransport('profile', 'bot');
    const sent = transport.send(notification);
    process.stdout.write(JSON.stringify({ ok: true, data: { message_id: 'sent' } })); process.emit('close', 0, null);
    expect(await sent).toBe('sent');
    expect(mocks.spawn.mock.calls[0]![1]).toEqual(['--profile', 'profile', 'im', '+messages-send', '--as', 'bot', '--chat-id', 'chat', '--text', notification.text, '--idempotency-key', notification.id]);
    const next = child(); mocks.spawn.mockReturnValue(next);
    const retry = transport.send(notification); const assertion = expect(retry).rejects.toThrow(/发送失败/);
    next.stdout.write('{"ok":false,"error":{"message":"denied"}}'); next.emit('close', 0, null);
    await assertion;
  });
  it('主动关闭只结束订阅 stdin，不误报故障或强杀共享事件服务', async () => {
    const process = child(); mocks.spawn.mockReturnValue(process);
    const transport = new LarkCliTransport('profile', 'bot'); const failed = vi.fn();
    const connected = transport.connect(vi.fn(), failed);
    process.stderr.write('[event] ready event_key=im.message.receive_v1\n'); await connected;
    const closed = transport.disconnect(); process.emit('close', 0, null); await closed;
    expect(process.stdin.writableEnded).toBe(true);
    expect(process.kill).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });
});
