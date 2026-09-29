import { describe, expect, it } from 'vitest';
import { AgentStore } from '../src/infra/store.js';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('飞书投递与执行恢复', () => {
  it('升级旧数据库时保留历史任务；选择上下文和回复引用经过真实关闭重开仍可使用', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agent-store-migration-')), 'state.sqlite');
    const old = new Database(path);
    old.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL); PRAGMA user_version = 1;');
    old.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run('legacy', 'demo', 'completed', '2020', JSON.stringify({ id: 'legacy', status: 'completed', request: '旧需求' }));
    old.close();
    const store = new AgentStore(path);
    expect(store.tasks()[0]?.request).toBe('旧需求');
    const message = { id: 'm', actorId: 'user', chatId: 'chat', text: '同意', replyTo: null, createdAt: '2099-01-01T00:00:00.000Z' };
    const context = { focusTaskId: 'legacy', turns: [], selection: { original: message, choices: [{ taskId: 'legacy', revision: 2, interactionId: 'i', title: '旧需求' }], createdAt: new Date().toISOString() } };
    store.saveConversation('scope', context);
    store.notify({ id: 'notice', taskId: 'legacy', interactionId: 'i', recipientType: 'chat_id', recipientId: 'chat', text: '方案', createdAt: '' });
    expect(store.wasPresented('legacy', 'i', message)).toBe(false);
    store.delivered('notice', 'remote'); store.close();
    const reopened = new AgentStore(path);
    expect(reopened.conversation('scope')).toEqual(context);
    expect(reopened.messageLink('remote')?.interactionId).toBe('i');
    expect(reopened.wasPresented('legacy', 'i', message)).toBe(true);
    expect(reopened.wasPresented('legacy', 'i', { ...message, chatId: 'other' })).toBe(false);
    expect(reopened.wasPresented('legacy', 'i', { ...message, createdAt: '2000-01-01T00:00:00.000Z' })).toBe(false);
    reopened.close();
  });
  it('相同消息只入队一次，重启恢复不盲目重新执行代码', () => {
    const store = new AgentStore(':memory:');
    const message = { id: 'm-1', actorId: 'u-1', chatId: 'c-1', text: '修复页面', replyTo: null };
    expect(store.enqueueMessage(message)).toBe(true);
    expect(store.enqueueMessage(message)).toBe(false);
    expect(store.pendingMessages()).toHaveLength(1);
    store.acknowledgeMessage('m-1');
    expect(store.pendingMessages()).toHaveLength(0);
    store.close();
  });
});
