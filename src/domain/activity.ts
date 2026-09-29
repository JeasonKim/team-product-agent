import type { Engine, Task, TaskStatus } from './model.js';

export interface RuntimeHealth {
  worker: 'starting' | 'running' | 'stopping' | 'stopped';
  feishu: 'disabled' | 'connected' | 'disconnected' | 'failed';
  startedAt: string;
  heartbeatAt: string | null;
}
export type TaskDigest = Pick<Task, 'id' | 'projectId' | 'status' | 'phase' | 'engine' | 'summary' | 'interaction' | 'requesterId' | 'revision' | 'updatedAt' | 'createdAt'> & { title: string; model: string | null; effort: string | null };
export type TaskCounts = Record<TaskStatus, number>;
export interface ProjectActivity {
  id: string;
  name: string;
  engine: Engine;
  model: string | null;
  effort: string | null;
  counts: TaskCounts;
}
export interface AgentActivity {
  name: string;
  online: boolean;
  health: RuntimeHealth;
  observedAt: string;
  projects: ProjectActivity[];
  tasks: TaskDigest[];
  counts: TaskCounts;
}
export const taskLanes: { id: string; title: string; statuses: TaskStatus[] }[] = [
  { id: 'queued', title: '待执行', statuses: ['queued'] },
  { id: 'running', title: '进行中', statuses: ['running'] },
  { id: 'waiting', title: '等待回复', statuses: ['waiting'] },
  { id: 'ready', title: '待验收', statuses: ['ready'] },
  { id: 'failed', title: '需要协助', statuses: ['failed'] },
  { id: 'closed', title: '已结束', statuses: ['completed', 'cancelled'] },
];
export function countTasks(tasks: Pick<Task, 'status'>[]): TaskCounts {
  const counts: TaskCounts = { queued: 0, running: 0, waiting: 0, ready: 0, failed: 0, completed: 0, cancelled: 0 };
  for (const task of tasks) counts[task.status]++;
  return counts;
}
export function taskDigest(task: Task): TaskDigest {
  const { id, projectId, status, phase, engine, summary, interaction, requesterId, revision, updatedAt, createdAt } = task;
  return { id, title: task.title || task.request.slice(0, 40), projectId, status, phase, engine, model: task.projectSnapshot.models[engine] ?? null, effort: task.projectSnapshot.efforts?.[engine] ?? null, summary, interaction, requesterId, revision, updatedAt, createdAt };
}
export function engineLabel(engine: Engine): string { return engine === 'codex' ? 'Codex SDK' : 'Claude Code SDK'; }
export function activityReply(activity: AgentActivity): string {
  const connection = { connected: '飞书已连接', disabled: '飞书未启用', disconnected: '飞书已断开', failed: '飞书连接异常' }[activity.health.feishu];
  const service = activity.online ? '服务在线' : activity.health.worker === 'starting' ? '正在启动' : activity.health.worker === 'stopping' ? '正在停止' : '暂未确认在线';
  const text = [`${activity.name} · ${service} · ${connection}`, '', '新需求默认配置：'];
  for (const project of activity.projects) text.push(`• ${project.name}：${engineLabel(project.engine)}；模型 ${project.model || '跟随引擎默认（未固定）'}；推理 ${project.effort || '跟随模型默认（未固定）'}`);
  text.push('', `你的可见需求：进行中 ${activity.counts.running}，待执行 ${activity.counts.queued}，等待回复 ${activity.counts.waiting}，待验收 ${activity.counts.ready}，需要协助 ${activity.counts.failed}；已完成 ${activity.counts.completed}，已取消 ${activity.counts.cancelled}。`);
  for (const lane of taskLanes.filter(lane => lane.id !== 'closed')) {
    const tasks = activity.tasks.filter(task => lane.statuses.includes(task.status));
    if (!tasks.length) continue;
    text.push('', `${lane.title}（${tasks.length}）：`);
    for (const task of tasks.slice(0, 5)) {
      const project = activity.projects.find(project => project.id === task.projectId)!;
      const waitingFor = task.interaction ? { clarification: '等需求方补充', architecture: '等负责人审定', recovery: '等负责人恢复', acceptance: '等需求方验收' }[task.interaction.kind] : '';
      text.push(`• ${task.title}〔${project.name}〕${waitingFor ? ` · ${waitingFor}` : ''}\n  ${engineLabel(task.engine)} · ${task.model || '默认模型（未固定）'} · 推理 ${task.effort || '模型默认'}`);
    }
    if (tasks.length > 5) text.push(`另有 ${tasks.length - 5} 项，可按需求名称询问具体进展。`);
  }
  text.push('', '任务使用创建时的配置。可以直接说“订单排序进展如何”，或告诉我新的需求。');
  return text.join('\n');
}
