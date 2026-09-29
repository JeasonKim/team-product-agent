import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccessRequest, AuditEvent, ChannelContext, EvaluationJob, Evidence, Improvement, IncomingMessage, Notification, Run, Task } from '../domain/model.js';
import { emptyContext, type ConversationContext, type MessageLink, type RoutingEvidence } from '../domain/conversation.js';

interface PayloadRow { payload: string }
interface OutboxRow extends PayloadRow { attempts: number }
export class AgentStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 3) throw new Error(`不支持的数据版本 ${version}`);
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, created_at);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, started_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, status TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS improvements (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_links (id TEXT PRIMARY KEY, task_id TEXT, interaction_id TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_links_interaction ON message_links(task_id, interaction_id);
      CREATE TABLE IF NOT EXISTS routing_evidence (message_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_task ON audit_events(task_id, created_at);
      CREATE TABLE IF NOT EXISTS channel_contexts (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access_requests (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS pending_access ON access_requests(actor_id) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS evaluation_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL);
      PRAGMA user_version = 3;
    `));
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  insertTask(task: Task): void {
    this.db.prepare('INSERT INTO tasks(id, project_id, status, created_at, payload) VALUES (?, ?, ?, ?, ?)').run(task.id, task.projectId, task.status, task.createdAt, JSON.stringify(task));
    this.audit('task.submitted', task.requesterId, task.id, { request: task.request, projectId: task.projectId, engine: task.engine });
  }
  task(id: string): Task {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as PayloadRow | undefined;
    if (!row) throw new Error(`任务不存在：${id}`);
    return JSON.parse(row.payload) as Task;
  }
  tasks(status?: string): Task[] {
    const rows = (status ? this.db.prepare('SELECT payload FROM tasks WHERE status = ? ORDER BY created_at, id').all(status) : this.db.prepare('SELECT payload FROM tasks ORDER BY created_at, id').all()) as PayloadRow[];
    return rows.map(row => JSON.parse(row.payload) as Task);
  }
  mutateTask(id: string, transition: (task: Task) => void): Task {
    return this.transaction(() => {
      const task = this.task(id);
      const before = { status: task.status, phase: task.phase, interaction: task.interaction, summary: task.summary, engine: task.engine, revision: task.revision };
      transition(task);
      task.revision += 1;
      task.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE tasks SET status = ?, payload = ? WHERE id = ?').run(task.status, JSON.stringify(task), task.id);
      const after = { status: task.status, phase: task.phase, interaction: task.interaction, summary: task.summary, engine: task.engine, revision: task.revision };
      if (before.status !== after.status || before.phase !== after.phase || before.interaction?.id !== after.interaction?.id || before.summary !== after.summary) this.audit('task.transition', 'system', id, { before, after });
      return task;
    });
  }
  recordRun(run: Run): void {
    this.db.prepare('INSERT INTO runs(id, task_id, status, started_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload').run(run.id, run.taskId, run.status, run.startedAt, JSON.stringify(run));
  }
  runs(taskId: string): Run[] {
    return (this.db.prepare('SELECT payload FROM runs WHERE task_id = ? ORDER BY started_at, rowid').all(taskId) as PayloadRow[]).map(row => JSON.parse(row.payload) as Run);
  }
  recordEvidence(evidence: Evidence): void {
    this.db.prepare('INSERT INTO evidence(id, task_id, created_at, payload) VALUES (?, ?, ?, ?)').run(evidence.id, evidence.taskId, evidence.createdAt, JSON.stringify(evidence));
  }
  evidence(taskId: string): Evidence[] {
    return (this.db.prepare('SELECT payload FROM evidence WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as PayloadRow[]).map(row => JSON.parse(row.payload) as Evidence);
  }
  enqueueMessage(message: IncomingMessage): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO inbox(id, status, received_at, payload) VALUES (?, ?, ?, ?)').run(message.id, 'pending', new Date().toISOString(), JSON.stringify(message)).changes === 1;
  }
  pendingMessages(): IncomingMessage[] {
    return (this.db.prepare("SELECT payload FROM inbox WHERE status = 'pending' ORDER BY received_at, rowid LIMIT 50").all() as PayloadRow[]).map(row => JSON.parse(row.payload) as IncomingMessage);
  }
  acknowledgeMessage(id: string): void { this.db.prepare("UPDATE inbox SET status = 'done' WHERE id = ?").run(id); }
  notify(notification: Notification): void {
    this.db.prepare("INSERT OR IGNORE INTO outbox(id, status, payload) VALUES (?, 'pending', ?)").run(notification.id, JSON.stringify(notification));
  }
  pendingNotifications(): Notification[] {
    return (this.db.prepare("SELECT payload FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY rowid LIMIT 20").all(Date.now()) as PayloadRow[]).map(row => JSON.parse(row.payload) as Notification);
  }
  delivered(id: string, remoteMessageId?: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM outbox WHERE id = ?').get(id) as PayloadRow | undefined;
      if (!row) throw new Error('发送记录不存在');
      const notification = JSON.parse(row.payload) as Notification;
      const link: MessageLink = { messageId: remoteMessageId ?? id, taskId: notification.taskId, interactionId: notification.interactionId ?? null, recipientType: notification.recipientType, recipientId: notification.recipientId, deliveredAt: new Date().toISOString() };
      this.db.prepare('INSERT OR IGNORE INTO message_links(id, task_id, interaction_id, payload) VALUES (?, ?, ?, ?)').run(link.messageId, link.taskId, link.interactionId, JSON.stringify(link));
      this.db.prepare("UPDATE outbox SET status = 'delivered' WHERE id = ?").run(id);
    });
  }
  messageLink(id: string): MessageLink | null {
    const row = this.db.prepare('SELECT payload FROM message_links WHERE id = ?').get(id) as PayloadRow | undefined;
    return row ? JSON.parse(row.payload) as MessageLink : null;
  }
  wasPresented(taskId: string, interactionId: string, message: IncomingMessage): boolean {
    if (!message.createdAt || !Number.isFinite(Date.parse(message.createdAt))) return false;
    const links = this.db.prepare('SELECT payload FROM message_links WHERE task_id = ? AND interaction_id = ?').all(taskId, interactionId) as PayloadRow[];
    return links.some(row => {
      const link = JSON.parse(row.payload) as MessageLink;
      return (link.recipientType === 'chat_id' ? link.recipientId === message.chatId : link.recipientId === message.actorId) && Date.parse(link.deliveredAt) <= Date.parse(message.createdAt!);
    });
  }
  conversation(id: string): ConversationContext {
    const row = this.db.prepare('SELECT payload FROM conversations WHERE id = ?').get(id) as PayloadRow | undefined;
    return row ? JSON.parse(row.payload) as ConversationContext : emptyContext();
  }
  saveConversation(id: string, context: ConversationContext): void {
    this.db.prepare('INSERT INTO conversations(id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload').run(id, JSON.stringify(context));
  }
  recordRouting(evidence: RoutingEvidence): void { this.db.prepare('INSERT INTO routing_evidence(message_id, payload) VALUES (?, ?)').run(evidence.messageId, JSON.stringify(evidence)); }
  routingEvidence(): RoutingEvidence[] { return (this.db.prepare('SELECT payload FROM routing_evidence ORDER BY rowid').all() as PayloadRow[]).map(row => JSON.parse(row.payload) as RoutingEvidence); }
  deliveryFailed(id: string, error: string): void {
    const row = this.db.prepare('SELECT payload, attempts FROM outbox WHERE id = ?').get(id) as OutboxRow;
    const attempts = row.attempts + 1;
    this.db.prepare('UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, error = ? WHERE id = ?').run(attempts >= 5 ? 'failed' : 'pending', attempts, Date.now() + Math.min(60_000 * 2 ** attempts, 3_600_000), error, id);
  }
  notificationsWithErrors(): unknown[] { return this.db.prepare("SELECT id, status, attempts, error FROM outbox WHERE status = 'failed'").all(); }
  retryNotification(id: string): void {
    if (!this.db.prepare("UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = 0, error = NULL WHERE id = ? AND status = 'failed'").run(id).changes) throw new Error('消息不存在或没有发送失败');
  }
  taskNotifications(taskId: string): unknown[] {
    return (this.db.prepare('SELECT status, attempts, error, payload FROM outbox ORDER BY rowid').all() as Array<PayloadRow & { status: string; attempts: number; error: string | null }>).filter(row => (JSON.parse(row.payload) as Notification).taskId === taskId).map(({ payload, ...delivery }) => ({ ...JSON.parse(payload) as Notification, ...delivery }));
  }
  channel(id: string): ChannelContext {
    const row = this.db.prepare('SELECT payload FROM channel_contexts WHERE id = ?').get(id) as PayloadRow | undefined;
    return row ? JSON.parse(row.payload) as ChannelContext : { projectId: null, selection: null };
  }
  saveChannel(id: string, context: ChannelContext): void { this.db.prepare('INSERT INTO channel_contexts VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload').run(id, JSON.stringify(context)); }
  audit(action: string, actorId: string, taskId: string | null, detail: unknown): void {
    const event: AuditEvent = { id: randomUUID(), action, actorId, taskId, detail, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO audit_events VALUES (?, ?, ?, ?)').run(event.id, taskId, event.createdAt, JSON.stringify(event));
  }
  auditEvents(taskId?: string): AuditEvent[] {
    const rows = (taskId ? this.db.prepare('SELECT payload FROM audit_events WHERE task_id = ? ORDER BY rowid').all(taskId) : this.db.prepare('SELECT payload FROM audit_events ORDER BY rowid DESC LIMIT 300').all()) as PayloadRow[];
    return rows.map(row => JSON.parse(row.payload) as AuditEvent);
  }
  accessRequests(): AccessRequest[] { return (this.db.prepare('SELECT payload FROM access_requests ORDER BY rowid').all() as PayloadRow[]).map(row => JSON.parse(row.payload) as AccessRequest); }
  saveAccess(item: AccessRequest): void { this.db.prepare('INSERT INTO access_requests VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload').run(item.id, item.actorId, item.status, JSON.stringify(item)); }
  evaluationJobs(): EvaluationJob[] { return (this.db.prepare('SELECT payload FROM evaluation_jobs ORDER BY rowid').all() as PayloadRow[]).map(row => JSON.parse(row.payload) as EvaluationJob); }
  saveEvaluationJob(job: EvaluationJob): void { this.db.prepare('INSERT INTO evaluation_jobs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload').run(job.id, job.status, JSON.stringify(job)); }
  recordImprovement(candidate: Improvement): void {
    this.db.prepare('INSERT INTO improvements(id, status, created_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload').run(candidate.id, candidate.status, candidate.createdAt, JSON.stringify(candidate));
  }
  improvements(): Improvement[] {
    return (this.db.prepare('SELECT payload FROM improvements ORDER BY created_at, rowid').all() as PayloadRow[]).map(row => JSON.parse(row.payload) as Improvement);
  }
  projectExperience(projectId: string, engine: 'claude' | 'codex'): string {
    return this.improvements().filter(item => item.status === 'promoted' && (!item.validatedEngines || item.validatedEngines.includes(engine)) && this.task(item.taskId).projectId === projectId).map(item => item.content).join('\n\n');
  }
  close(): void { this.db.close(); }
}
