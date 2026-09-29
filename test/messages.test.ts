import { describe, expect, it } from 'vitest';
import { parseFeishuMessage, parseAction } from '../src/adapters/messages.js';
describe('飞书消息边界', () => {
  it('只有应用接收的用户消息可入队；群里需明确 @ 当前机器人', () => {
    const data = { sender: { sender_type: 'user', sender_id: { open_id: 'requester' } }, message: { message_id: 'm1', chat_id: 'chat', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '@_user_1 修一下按钮' }), mentions: [{ key: '@_user_1', id: { open_id: 'bot' } }] } };
    expect(parseFeishuMessage(data, 'bot')?.text).toBe('修一下按钮');
    expect(parseFeishuMessage(data, 'another-bot')).toBe(null);
    expect(parseFeishuMessage({ ...data, sender: { ...data.sender, sender_type: 'app' } }, 'bot')).toBe(null);
  });
  it('保留旧命令兼容入口，普通回复交给会话路由判断', () => {
    expect(parseAction('同意 abc12345 def67890')).toEqual({ type: 'reply', taskId: 'abc12345', interactionId: 'def67890', answer: 'approve' });
    expect(parseAction('回答 abc12345 def67890 按创建时间倒序')).toEqual({ type: 'reply', taskId: 'abc12345', interactionId: 'def67890', answer: '按创建时间倒序' });
    expect(parseAction('好的')).toEqual({ type: 'request', text: '好的' });
  });
  it('非法 JSON 和非文本消息不会击穿收件处理', () => {
    expect(parseFeishuMessage({ sender: {}, message: { content: '{' } }, 'bot')).toBe(null);
  });
});
