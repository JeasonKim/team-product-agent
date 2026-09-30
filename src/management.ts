import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeConfig, type Config } from './config.js';
import { fingerprint } from './domain/policy.js';
import type { EvaluationJob } from './domain/model.js';
import { evaluateCandidate, promoteCandidate } from './improvement.js';
import type { TaskService } from './service.js';
import { taskLanes } from './domain/activity.js';

export class Conflict extends Error {}
export class Management {
  private saving = false;
  private evaluation?: { id: string; controller: AbortController };
  get health() { return this.service.health; }
  constructor(readonly service: TaskService, readonly configPath: string) {}
  settings(): { config: Config; revision: string } {
    // 可选字段在运行中新增时，Object.assign 的插入顺序与文件解析结果不同。
    // 统一经过 Schema 规范化后取版本，避免把字段顺序误判为并发修改。
    const config = normalizeConfig(this.service.config, this.configPath);
    return { config, revision: fingerprint(config) };
  }
  private owner(projectId: string): string {
    const actor = this.service.config.localActorId;
    if (!this.service.project(projectId).ownerIds.includes(actor)) throw new Error('本机管理身份不是该产品负责人');
    return actor;
  }
  async saveSettings(raw: unknown, expected: string): Promise<ReturnType<Management['settings']>> {
    if (this.saving) throw new Conflict('设置正在保存，请稍后刷新');
    this.saving = true;
    try {
      const current = this.settings();
      const disk = normalizeConfig(JSON.parse(await readFile(this.configPath, 'utf8')), this.configPath);
      if (expected !== current.revision) throw new Conflict('设置已更新，请刷新后重新修改');
      if (expected !== fingerprint(disk)) throw new Conflict('配置文件已在后台之外修改；请重启服务加载，或还原外部修改后重试');
      const next = normalizeConfig(raw, this.configPath);
      if (next.dataDirectory !== current.config.dataDirectory || next.localActorId !== current.config.localActorId) throw new Error('运行中不能修改数据目录或本机身份，请停服后修改配置文件');
      for (const project of current.config.projects) this.owner(project.id);
      if (next.projects.some(p => !p.ownerIds.includes(next.localActorId))) throw new Error('每个产品必须保留本机管理身份的负责人权限');
      if (this.service.store.tasks().some(t => !next.projects.some(p => p.id === t.projectId))) throw new Error('有历史任务的产品不能删除；可移除提需求成员和群绑定以停止接入');
      const actor = next.localActorId;
      const changeId = randomUUID();
      this.service.store.audit('settings.requested', actor, null, { changeId, before: current.config, after: next });
      const temporary = `${this.configPath}.${changeId}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.configPath);
      Object.assign(this.service.config, next);
      // Object.assign 不删除可选字段；以经过校验的配置为准。
      if (!next.profile) delete this.service.config.profile;
      if (!next.notifications) delete this.service.config.notifications;
      this.service.store.audit('settings.updated', actor, null, { changeId, revision: fingerprint(next) });
      return this.settings();
    } finally { this.saving = false; }
  }
  state() {
    const { store, config } = this.service;
    const tasks = store.tasks().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const active = tasks.filter(t => !['completed', 'cancelled'].includes(t.status));
    const attention = active.filter(t => t.status === 'failed' || ['architecture', 'recovery'].includes(t.interaction?.kind ?? ''));
    const activity = this.service.activity(config.localActorId);
    return {
      profile: config.profile, localActorId: config.localActorId, health: this.health, activity, lanes: taskLanes, projects: activity.projects,
      tasks: activity.tasks,
      metrics: { total: tasks.length, active: active.length, attention: attention.length, completed: tasks.filter(t => t.status === 'completed').length, improved: store.improvements().filter(i => i.status === 'promoted').length },
      accessRequests: store.accessRequests(), failedNotifications: store.notificationsWithErrors(),
      improvements: store.improvements().map(i => ({ ...i, projectId: store.task(i.taskId).projectId, sourceTitle: store.task(i.taskId).title })),
      evaluations: store.evaluationJobs(), audit: store.auditEvents(),
      credentials: { codexApiKey: !!process.env.OPENAI_API_KEY, claudeApiKey: !!process.env.ANTHROPIC_API_KEY, feishu: !!(process.env.FEISHU_CLI_PROFILE || process.env.FEISHU_APP_ID) },
    };
  }
  taskDetail(id: string) {
    const { store } = this.service; const task = store.task(id); this.owner(task.projectId);
    return { task, runs: store.runs(id), evidence: store.evidence(id), timeline: store.auditEvents(id), notifications: store.taskNotifications(id) };
  }
  taskAction(id: string, input: { action: 'approve' | 'reject' | 'reply' | 'followup' | 'cancel' | 'retry'; revision: number; interactionId?: string; text?: string }) {
    return this.service.store.transaction(() => {
      const task = this.service.store.task(id); const actor = this.owner(task.projectId);
      if (task.revision !== input.revision) throw new Conflict('任务已更新，请查看最新进展后再操作');
      if (input.action === 'cancel') return this.service.cancel(id, actor);
      if (input.action === 'retry') return this.service.retry(id, actor);
      if (input.action === 'followup') return this.service.followUp(id, actor, input.text ?? '');
      if (!task.interaction || input.interactionId !== task.interaction.id) throw new Conflict('这条待决事项已过期，请刷新任务');
      return this.service.reply(id, input.interactionId, actor, input.action === 'approve' ? 'approve' : input.action === 'reject' ? `reject:${input.text || '请调整方案'}` : input.text ?? '');
    });
  }
  async resolveAccess(id: string, projectId: string, grant: boolean): Promise<void> {
    const { store } = this.service;
    const request = store.accessRequests().find(r => r.id === id);
    if (!request || request.status !== 'pending') throw new Conflict('申请已处理或不存在');
    const actor = this.owner(projectId);
    if (grant) {
      const settings = this.settings(); const project = settings.config.projects.find(p => p.id === projectId)!;
      project.requesterIds = [...new Set([...project.requesterIds, request.actorId])];
      await this.saveSettings(settings.config, settings.revision);
    }
    store.transaction(() => {
      // 配置写入后再次校验，保证并发点击不会重复恢复需求。
      if (store.accessRequests().find(r => r.id === id)?.status !== 'pending') throw new Conflict('申请已处理');
      store.saveAccess({ ...request, projectId: grant ? projectId : null, status: grant ? 'granted' : 'denied', resolvedAt: new Date().toISOString() });
      store.audit(grant ? 'access.granted' : 'access.denied', actor, null, { requestId: id, projectId, requesterId: request.actorId });
      store.notify({ id: randomUUID(), taskId: null, recipientType: 'open_id', recipientId: request.actorId, text: grant ? `已开通「${this.service.project(projectId).name}」，现在继续处理你之前的需求。` : '负责人暂未开通访问权限，可以直接与他确认负责的产品。', createdAt: new Date().toISOString() });
      if (grant) {
        // 原群可能属于另一产品，授权后的需求统一续到该成员的私聊上下文。
        const message = { ...request.message, id: `access:${id}`, chatId: `private:${request.actorId}`, chatType: 'p2p' as const, replyTo: null, source: request.message.source ?? { messageId: request.message.id, chatId: request.message.chatId } };
        store.saveChannel(JSON.stringify([message.chatId, message.actorId]), { projectId, selection: null });
        store.enqueueMessage(message);
      }
    });
  }
  archiveImprovement(id: string): void {
    const item = this.service.store.improvements().find(i => i.id === id);
    if (!item) throw new Error('经验不存在');
    const actor = this.owner(this.service.store.task(item.taskId).projectId);
    this.service.store.recordImprovement({ ...item, status: 'archived' });
    this.service.store.audit('experience.archived', actor, item.taskId, { candidateId: id, previousStatus: item.status });
  }
  createImprovement(taskId: string, content: string): void {
    const task = this.service.store.task(taskId); const actor = this.owner(task.projectId);
    if (!content.trim() || content.length > 20000) throw new Error('请填写 1–20000 字的经验');
    const id = randomUUID().slice(0, 8);
    this.service.store.recordImprovement({ id, taskId, content: content.trim(), status: 'candidate', createdAt: new Date().toISOString(), promotedAt: null, evaluatedHash: null });
    this.service.store.audit('experience.created', actor, taskId, { candidateId: id, content });
  }
  queueEvaluation(candidateId: string): EvaluationJob {
    const store = this.service.store;
    const candidate = store.improvements().find(i => i.id === candidateId && i.status === 'candidate');
    if (!candidate) throw new Error('找不到待评估经验');
    const project = this.service.project(store.task(candidate.taskId).projectId); const actor = this.owner(project.id);
    if (!project.evaluationManifest) throw new Error('请先在产品设置中配置独立评估场景文件');
    if (store.evaluationJobs().some(j => j.candidateId === candidateId && ['queued', 'running'].includes(j.status))) throw new Conflict('这条经验已在评估队列中');
    const job: EvaluationJob = { id: randomUUID(), candidateId, status: 'queued', reportId: null, summary: '等待评估；会使用当前产品引擎运行真实对比', createdAt: new Date().toISOString(), finishedAt: null };
    store.saveEvaluationJob(job); store.audit('evaluation.queued', actor, candidate.taskId, { jobId: job.id, candidateId }); return job;
  }
  recoverEvaluations(): void {
    for (const job of this.service.store.evaluationJobs().filter(j => j.status === 'running')) this.service.store.saveEvaluationJob({ ...job, status: 'interrupted', summary: '上次评估中断，原始试验保留；可重新评估', finishedAt: new Date().toISOString() });
  }
  async runNextEvaluation(signal: AbortSignal): Promise<void> {
    if (this.evaluation || signal.aborted) return;
    const { store } = this.service;
    // 每个候选只自动入队一次；只从业务验收后的需求学习，避免无限重试消耗额度。
    if (!store.evaluationJobs().some(j => ['queued', 'running'].includes(j.status))) {
      const candidate = store.improvements().find(i => {
        if (i.status !== 'candidate' || store.evaluationJobs().some(j => j.candidateId === i.id)) return false;
        const task = store.task(i.taskId); const project = this.service.project(task.projectId);
        return task.status === 'completed' && project.autoEvaluate && project.evaluationManifest && project.ownerIds.includes(this.service.config.localActorId);
      });
      if (candidate) this.queueEvaluation(candidate.id);
    }
    const job = store.evaluationJobs().find(j => j.status === 'queued'); if (!job) return;
    const controller = new AbortController(); this.evaluation = { id: job.id, controller };
    store.saveEvaluationJob({ ...job, status: 'running', summary: '正在准备独立工作副本' });
    try {
      const candidate = store.improvements().find(i => i.id === job.candidateId)!;
      const project = this.service.project(store.task(candidate.taskId).projectId);
      const report = await evaluateCandidate(this.service.config, store, this.service.instructions, this.service.engines, job.candidateId, project.evaluationManifest!, { signal: AbortSignal.any([signal, controller.signal]), onProgress: summary => store.saveEvaluationJob({ ...job, status: 'running', summary }) });
      store.saveEvaluationJob({ ...job, status: report.verdict.allowed ? 'passed' : 'failed', reportId: report.id, summary: report.verdict.reason, finishedAt: new Date().toISOString() });
      store.audit('evaluation.finished', 'system', candidate.taskId, { jobId: job.id, reportId: report.id, verdict: report.verdict });
      if (report.verdict.allowed) for (const owner of project.ownerIds.filter(id => id.startsWith('ou_'))) store.notify({ id: randomUUID(), taskId: null, recipientType: 'open_id', recipientId: owner, text: `「${project.name}」有一条经验通过了回归和保留场景的对比评估，观察到实际改善。你可以在管理后台“经验与成长”查看证据后启用。`, createdAt: new Date().toISOString() });
    } catch (error) {
      store.saveEvaluationJob({ ...job, status: signal.aborted || controller.signal.aborted ? 'interrupted' : 'failed', summary: String(error), finishedAt: new Date().toISOString() });
    } finally { this.evaluation = undefined; }
  }
  cancelEvaluation(id: string): void {
    const job = this.service.store.evaluationJobs().find(j => j.id === id); if (!job || !['queued', 'running'].includes(job.status)) throw new Conflict('评估已结束');
    if (this.evaluation?.id === id) this.evaluation.controller.abort(new Error('负责人停止评估'));
    else this.service.store.saveEvaluationJob({ ...job, status: 'interrupted', summary: '负责人停止评估', finishedAt: new Date().toISOString() });
    this.service.store.audit('evaluation.cancelled', this.service.config.localActorId, null, { jobId: id });
  }
  async promote(candidateId: string, jobId: string): Promise<void> {
    const job = this.service.store.evaluationJobs().find(j => j.id === jobId && j.candidateId === candidateId && j.status === 'passed');
    if (!job?.reportId) throw new Error('需要一份通过的独立评估报告');
    await promoteCandidate(this.service.config, this.service.store, this.service.instructions, candidateId, job.reportId, this.service.config.localActorId);
  }
  async evaluationReport(id: string): Promise<unknown> {
    const job = this.service.store.evaluationJobs().find(j => j.id === id);
    if (!job?.reportId || !/^[a-f0-9-]{36}$/.test(job.reportId)) throw new Error('评估报告尚未生成');
    return JSON.parse(await readFile(join(this.service.config.dataDirectory, 'evaluations', job.reportId, 'report.json'), 'utf8')) as unknown;
  }
}
