import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { engineSchema } from './domain/model.js';

const commandSchema = z.object({ name: z.string().min(1), argv: z.array(z.string()).min(1), timeoutMs: z.number().int().positive().default(120_000) }).strict();
export const codexEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
export const claudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const profileSchema = z.object({ name: z.string().trim().min(1).max(60), role: z.string().trim().min(1).max(2000), style: z.string().max(2000), preferences: z.string().max(10000) }).strict();
export const defaultProfile = { name: '研发分身', role: '帮助团队产品和运营完成已有产品的改进', style: '简洁、直接，用业务语言沟通，说明结果和下一步。', preferences: '优先维护统一的业务模型，沿用现有能力；有证据再交付。' };
export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  name: z.string().min(1),
  repository: z.string().min(1),
  engine: engineSchema.default('codex'),
  authentication: z.object({ codex: z.enum(['api_key', 'local_login']).optional(), claude: z.literal('api_key').optional() }).strict().optional(),
  models: z.object({ claude: z.string().optional(), codex: z.string().optional() }).strict().default({}),
  efforts: z.object({ claude: claudeEffortSchema.optional(), codex: codexEffortSchema.optional() }).strict().optional(),
  evaluationManifest: z.string().min(1).optional(),
  autoEvaluate: z.boolean().optional(),
  requesterIds: z.array(z.string()).default([]),
  ownerIds: z.array(z.string()).min(1),
  chatIds: z.array(z.string()).default([]),
  setup: z.array(commandSchema).default([]),
  checks: z.array(commandSchema).min(1),
  sensitivePaths: z.array(z.string()).default(['db/', 'migrations/', '.github/', 'package.json', 'pnpm-lock.yaml', 'AGENTS.md', '.claude/', '.codex/']),
}).strict();
export const configSchema = z.object({
  dataDirectory: z.string().default('./data'),
  localActorId: z.string().default('local-owner'),
  maxIterations: z.number().int().min(1).max(20).default(3),
  runTimeoutMs: z.number().int().min(1000).default(600_000),
  profile: profileSchema.optional(),
  notifications: z.object({ groupMode: z.enum(['private', 'milestones', 'group']) }).strict().optional(),
  projects: z.array(projectSchema).min(1),
}).strict();
export type Project = z.infer<typeof projectSchema>;
export type CheckCommand = z.infer<typeof commandSchema>;
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(path: string): Promise<Config> {
  return normalizeConfig(JSON.parse(await readFile(path, 'utf8')), path);
}
export function normalizeConfig(raw: unknown, path: string): Config {
  const config = configSchema.parse(raw);
  const base = dirname(resolve(path));
  config.dataDirectory = resolve(base, config.dataDirectory);
  const ids = new Set<string>();
  const chats = new Set<string>();
  for (const project of config.projects) {
    if (ids.has(project.id)) throw new Error(`重复项目：${project.id}`);
    ids.add(project.id);
    project.repository = resolve(base, project.repository);
    if (project.evaluationManifest) project.evaluationManifest = resolve(base, project.evaluationManifest);
    if (project.autoEvaluate && !project.evaluationManifest) throw new Error(`「${project.name}」开启自动评估前需要配置独立场景文件`);
    if (!isAbsolute(project.repository)) throw new Error('repository 必须为本地路径');
    for (const chat of project.chatIds) {
      if (chats.has(chat)) throw new Error(`一个聊天只能绑定一个项目：${chat}`);
      chats.add(chat);
    }
  }
  return config;
}
// 模型、推理级别、名称和评估集是新任务的默认值；权限与执行契约仍由实时配置约束。
export function executionPolicy(project: Project): unknown {
  return { id: project.id, repository: project.repository, authentication: project.authentication, setup: project.setup, checks: project.checks, sensitivePaths: project.sensitivePaths };
}
export function permissionsReduced(before: Project, after: Project): boolean {
  return (['ownerIds', 'requesterIds', 'chatIds'] as const).some(key => before[key].some(id => !after[key].includes(id)));
}
