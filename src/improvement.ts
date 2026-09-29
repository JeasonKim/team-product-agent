import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import type { AgentEngine, Engine, Improvement } from './domain/model.js';
import { fingerprint } from './domain/policy.js';
import { AgentStore } from './infra/store.js';
import { executeCommand } from './infra/process.js';
import { TaskService, type Instructions } from './service.js';
import { runtimeVersions } from './infra/versions.js';

interface TrialResult { passed: boolean; taskId: string; durationMs: number; repeatedTaskIds?: string[] }
export interface EvaluationCaseResult {
  caseId: string;
  engine: Engine;
  split: 'regression' | 'holdout';
  baseline: TrialResult;
  candidate: TrialResult;
}
interface Verdict { allowed: boolean; reason: string }
export interface EvaluationReport {
  id: string;
  candidateId: string;
  candidateHash: string;
  projectHash: string;
  instructionsHash: string;
  baselineExperienceHash: string;
  behaviorHash?: string;
  engines?: Engine[];
  manifestHash: string;
  baseCommit: string;
  versions: Record<string, string>;
  createdAt: string;
  results: EvaluationCaseResult[];
  verdict: Verdict;
}
const manifestSchema = z.object({
  cases: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/), split: z.enum(['regression', 'holdout']), request: z.string().min(1),
    expected: z.enum(['ready', 'architecture', 'clarification']),
    acceptance: z.object({ argv: z.array(z.string()).min(1), timeoutMs: z.number().positive().default(60_000) }).optional(),
  }).strict()).min(2),
}).strict();
export function promotionVerdict(results: EvaluationCaseResult[]): Verdict {
  if (!results.length) return { allowed: false, reason: '没有评估证据' };
  for (const engine of new Set(results.map(row => row.engine))) {
    const cases = results.filter(row => row.engine === engine);
    if (!cases.some(row => row.split === 'regression') || !cases.some(row => row.split === 'holdout')) return { allowed: false, reason: `${engine} 缺少回归或保留场景` };
  }
  if (results.some(row => row.baseline.passed && !row.candidate.passed)) return { allowed: false, reason: '出现原有场景退化' };
  if (results.some(row => !row.candidate.passed)) return { allowed: false, reason: '候选仍有未通过场景' };
  if (!results.some(row => !row.baseline.passed && row.candidate.passed)) return { allowed: false, reason: '没有观察到通过率改善' };
  return { allowed: true, reason: '无退化，回归及保留场景通过，且存在实际改善' };
}
function locateCandidate(store: AgentStore, id: string): Improvement {
  const candidate = store.improvements().find(item => item.id === id);
  if (!candidate || candidate.status !== 'candidate') throw new Error('找不到待评估候选');
  return candidate;
}
function experienceSnapshot(store: AgentStore, projectId: string, engines: Engine[]): unknown { return Object.fromEntries(engines.map(engine => [engine, store.projectExperience(projectId, engine)])); }
function behaviorHash(config: Config): string { return fingerprint({ profile: config.profile, maxIterations: config.maxIterations, runTimeoutMs: config.runTimeoutMs }); }
export async function evaluateCandidate(config: Config, store: AgentStore, instructions: Instructions, engines: Partial<Record<Engine, AgentEngine>>, candidateId: string, manifestPath: string, options: { engines?: Engine[]; signal?: AbortSignal; onProgress?: (message: string) => void } = {}): Promise<EvaluationReport> {
  const candidate = locateCandidate(store, candidateId);
  const projectId = store.task(candidate.taskId).projectId;
  const project = config.projects.find(project => project.id === projectId)!;
  const selectedEngines = [...new Set(options.engines ?? [project.engine])];
  if (!selectedEngines.length) throw new Error('请选择至少一个评估引擎');
  for (const engine of selectedEngines) {
    if (!engines[engine]) throw new Error(`评估引擎不可用：${engine}`);
    if (engine === 'claude' && !process.env.ANTHROPIC_API_KEY) throw new Error('Claude 评估需要 ANTHROPIC_API_KEY');
    if (engine === 'codex' && project.authentication?.codex !== 'local_login' && !process.env.OPENAI_API_KEY) throw new Error('Codex 评估需要 API Key 或已配置的本机登录');
  }
  const configuration = structuredClone(config);
  const candidateHash = fingerprint(candidate.content);
  const baselineExperienceHash = fingerprint(experienceSnapshot(store, projectId, selectedEngines));
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (new Set(manifest.cases.map(item => item.id)).size !== manifest.cases.length) throw new Error('评估场景编号重复');
  if (!manifest.cases.some(item => item.split === 'holdout') || !manifest.cases.some(item => item.split === 'regression')) throw new Error('需要回归和独立保留场景');
  for (const item of manifest.cases) if (item.expected === 'ready' && !item.acceptance) throw new Error(`交付场景 ${item.id} 必须提供独立验收命令`);
  const id = randomUUID();
  const source = await executeCommand({ name: '评估版本', argv: ['git', 'rev-parse', 'HEAD'], timeoutMs: 5000 }, project.repository);
  if (source.exitCode !== 0) throw new Error('无法确定评估代码版本');
  const baseCommit = source.output.trim();
  const directory = join(config.dataDirectory, 'evaluations', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const trialStore = new AgentStore(join(directory, 'trials.sqlite'));
  const results: EvaluationCaseResult[] = [];
  try {
    for (const engine of selectedEngines) {
      const experience = store.projectExperience(projectId, engine);
      const localConfig: Config = { ...configuration, dataDirectory: directory, localActorId: 'eval-owner', projects: [{ ...structuredClone(project), engine, ownerIds: ['eval-owner'], requesterIds: ['eval-user'], chatIds: [] }] };
      const service = new TaskService(localConfig, trialStore, engines, instructions);
      const stop = () => service.interruptActive();
      options.signal?.addEventListener('abort', stop, { once: true });
      try {
      for (const scenario of manifest.cases) {
        const trials: TrialResult[] = [];
        for (const variant of ['baseline', 'candidate'] as const) {
          const started = Date.now();
          const taskIds: string[] = [];
          let passed = true;
          for (let repeat = 0; repeat < 2; repeat++) {
            options.signal?.throwIfAborted();
            options.onProgress?.(`${engine} · ${scenario.id} · ${variant === 'baseline' ? '原始表现' : '使用经验'} · 第 ${repeat + 1}/2 次`);
            const task = service.submit(projectId, 'eval-user', scenario.request);
            taskIds.push(task.id);
            trialStore.mutateTask(task.id, task => { task.experience = variant === 'candidate' ? `${experience}\n\n${candidate.content}` : experience; });
            await service.drain();
            options.signal?.throwIfAborted();
            const finished = trialStore.task(task.id);
            if (finished.baseCommit && finished.baseCommit !== baseCommit) throw new Error('评估过程中产品 HEAD 改变，停止本次比较，试验现场已保留');
            let repeatPassed = scenario.expected === 'ready' ? finished.status === 'ready' : finished.status === 'waiting' && finished.interaction?.kind === scenario.expected;
            if (repeatPassed && scenario.expected === 'ready') {
              const assertion = await executeCommand({ name: `独立验收 ${scenario.id}`, ...scenario.acceptance! }, finished.workspace!, options.signal);
              repeatPassed = assertion.exitCode === 0 && !assertion.timedOut;
              await writeFile(join(directory, `${engine}-${scenario.id}-${variant}-${repeat}.json`), JSON.stringify(assertion, null, 2));
            }
            passed &&= repeatPassed;
          }
          trials.push({ passed, taskId: taskIds[0]!, durationMs: Date.now() - started, repeatedTaskIds: taskIds });
        }
        results.push({ caseId: scenario.id, engine, split: scenario.split, baseline: trials[0]!, candidate: trials[1]! });
        await writeFile(join(directory, 'progress.json'), JSON.stringify(results, null, 2));
      }
      } finally { options.signal?.removeEventListener('abort', stop); }
    }
  } finally { trialStore.close(); }
  const report: EvaluationReport = { id, candidateId, candidateHash, projectHash: fingerprint(configuration.projects.find(p => p.id === projectId)), instructionsHash: fingerprint(instructions), baselineExperienceHash, behaviorHash: behaviorHash(configuration), engines: selectedEngines, manifestHash: fingerprint(manifest), baseCommit, versions: runtimeVersions(), createdAt: new Date().toISOString(), results, verdict: promotionVerdict(results) };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
export async function promoteCandidate(config: Config, store: AgentStore, instructions: Instructions, candidateId: string, evaluationId: string, actor: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(evaluationId)) throw new Error('无效评估编号');
  const candidate = locateCandidate(store, candidateId);
  const projectId = store.task(candidate.taskId).projectId;
  const project = config.projects.find(project => project.id === projectId)!;
  if (!project.ownerIds.includes(actor)) throw new Error('只有技术负责人可以晋升候选');
  const report = JSON.parse(await readFile(join(config.dataDirectory, 'evaluations', evaluationId, 'report.json'), 'utf8')) as EvaluationReport;
  const current = await executeCommand({ name: '晋升代码版本', argv: ['git', 'rev-parse', 'HEAD'], timeoutMs: 5000 }, project.repository);
  // 异步检查期间可能发生停用、权限调整或另一条晋升；落盘前重新读取宿主状态。
  const latest = locateCandidate(store, candidateId);
  const latestProject = config.projects.find(item => item.id === projectId);
  if (!latestProject?.ownerIds.includes(actor)) throw new Error('负责人权限已经变化');
  if (current.exitCode !== 0 || report.baseCommit !== current.output.trim() || fingerprint(report.versions) !== fingerprint(runtimeVersions())) throw new Error('代码或运行时版本改变，需要重新评估');
  const validatedEngines = report.engines ?? ['claude', 'codex'];
  const currentExperience = report.engines ? experienceSnapshot(store, projectId, validatedEngines) : store.projectExperience(projectId, 'codex');
  if (report.id !== evaluationId || report.candidateId !== candidateId || report.candidateHash !== fingerprint(latest.content) || report.projectHash !== fingerprint(latestProject) || report.instructionsHash !== fingerprint(instructions) || report.baselineExperienceHash !== fingerprint(currentExperience) || (report.behaviorHash && report.behaviorHash !== behaviorHash(config))) throw new Error('评估版本与当前候选、角色或项目不一致，需重新评估');
  if (!validatedEngines.length || validatedEngines.some(engine => !report.results.some(row => row.engine === engine))) throw new Error('缺少所选引擎的评估证据');
  const verdict = promotionVerdict(report.results);
  if (!verdict.allowed) throw new Error(verdict.reason);
  store.recordImprovement({ ...latest, status: 'promoted', promotedAt: new Date().toISOString(), evaluatedHash: fingerprint(report), validatedEngines });
  store.audit('experience.promoted', actor, candidate.taskId, { candidateId, evaluationId, validatedEngines });
}
