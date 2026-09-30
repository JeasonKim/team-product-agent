import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { engineSchema } from './domain/model.js';
import { AgentStore } from './infra/store.js';
import { executeCommand } from './infra/process.js';
import { applicationDirectory } from './infra/paths.js';
import { ClaudeEngine } from './adapters/claude.js';
import { CodexEngine } from './adapters/codex.js';
import { TaskService } from './service.js';
import { runWorker } from './worker.js';
import { evaluateCandidate, promoteCandidate } from './improvement.js';
import { Management } from './management.js';
import { openAdmin } from './admin/open.js';

const help = `团队产品 Agent\n\n准备：pnpm start init /你的产品仓库\n一键调试：pnpm dev（直接运行源码，连接飞书并打开后台）\n一键运行：pnpm start（需先 pnpm build）\n只启服务：pnpm serve\n打开后台：pnpm admin\n本地调试：pnpm dev --no-feishu\n本地：pnpm start submit product "需求描述"\n执行：pnpm start run\n查看：pnpm start status [任务号]\n回应：pnpm start reply 任务号 待决编号 approve|reject:原因|业务答案\n取消：pnpm start cancel 任务号\n恢复：pnpm start retry 任务号\n切换：pnpm start engine 任务号 claude|codex\n诊断：pnpm start doctor\n经验：pnpm start candidates\n候选：pnpm start candidate 任务号 经验文件\n评估：pnpm start evaluate 候选号 场景文件\n晋升：pnpm start promote 候选号 评估编号\n\n可用 --config 指定配置文件，--port 调整端口，--no-open 禁止自动打开浏览器；凭证放本机 .env。`;

async function main(): Promise<void> {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (!(major === 20 && minor >= 19 || major === 22 && minor >= 13 || major >= 24)) throw new Error(`需要 Node.js 20.19+、22.13+ 或 24+，当前为 ${process.versions.node}；使用 nvm 时可在项目目录运行 nvm use`);
  if (existsSync('.env')) loadEnvFile('.env');
  const { positionals, values } = parseArgs({ allowPositionals: true, allowNegative: true, options: { config: { type: 'string', default: 'agent.config.json' }, port: { type: 'string', default: '4318' }, feishu: { type: 'boolean' }, open: { type: 'boolean' }, help: { type: 'boolean', short: 'h', default: false } } });
  const [requestedCommand, ...args] = positionals;
  const defaultStart = !requestedCommand;
  const command = requestedCommand ?? 'serve';
  if (values.help || command === 'help') { console.log(help); return; }
  const required = (index: number) => { if (!args[index]) throw new Error(`缺少参数。\n${help}`); return args[index]; };
  const configPath = resolve(values.config!);
  if (command === 'init') {
    if (existsSync(configPath)) throw new Error('配置已存在，不会覆盖');
    const repository = resolve(required(0));
    const check = await executeCommand({ name: '仓库检查', argv: ['git', 'rev-parse', '--show-toplevel'], timeoutMs: 5000 }, repository);
    if (check.exitCode !== 0) throw new Error('目标不是 Git 仓库');
    const template = JSON.parse(await readFile(join(applicationDirectory, 'agent.config.example.json'), 'utf8'));
    template.projects[0].repository = check.output.trim();
    await writeFile(configPath, JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`已创建 ${configPath}。请按该产品实际情况设置检查命令、飞书人员和聊天，然后运行 doctor。`); return;
  }
  if (!existsSync(configPath)) throw new Error(`缺少 ${configPath}；先运行 pnpm start init /产品仓库`);
  const config = await loadConfig(configPath);
  if (command === 'admin') { console.log(`已在浏览器打开管理后台：${await openAdmin(config.dataDirectory)}`); return; }
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const store = new AgentStore(join(config.dataDirectory, 'agent.sqlite'));
  const skillDirectory = join(applicationDirectory, 'resources', 'skills', 'verify-and-improve');
  const instructions = { role: await readFile(join(applicationDirectory, 'resources', 'agent-role.md'), 'utf8'), skill: `${await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')}\n\n${await readFile(join(skillDirectory, 'references', 'agent-experience.md'), 'utf8')}` };
  const engines = { claude: new ClaudeEngine(), codex: new CodexEngine() };
  const service = new TaskService(config, store, engines, instructions);
  const actor = config.localActorId;
  try {
    switch (command) {
      case 'serve': {
        const port = Number(values.port); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('后台端口应为 1024–65535');
        const onReady = async () => {
          console.info('日志显示在当前终端，按 Ctrl+C 停止服务。');
          if (!(values.open ?? defaultStart)) return;
          try { console.info(`已打开管理后台：${await openAdmin(config.dataDirectory)}`); }
          catch (error) { console.warn(`服务保持运行，后台未自动打开：${error instanceof Error ? error.message : String(error)} 可另行运行 pnpm admin。`); }
        };
        await runWorker(service, values.feishu ?? defaultStart, false, new Management(service, configPath), port, onReady); break;
      }
      case 'run': {
        const started = new Date().toISOString();
        await runWorker(service, false, true);
        if (store.tasks().some(task => task.status === 'failed' && task.updatedAt >= started)) process.exitCode = 1;
        break;
      }
      case 'submit': console.log(JSON.stringify(service.submit(required(0), actor, args.slice(1).join(' ')), null, 2)); break;
      case 'status':
        console.log(JSON.stringify(args[0] ? { task: store.task(args[0]), runs: store.runs(args[0]), evidence: store.evidence(args[0]) } : store.tasks().map(({ id, projectId, engine, status, summary, interaction }) => ({ id, projectId, engine, status, summary, interaction })), null, 2)); break;
      case 'reply': console.log(JSON.stringify(service.reply(required(0), required(1), actor, args.slice(2).join(' ')), null, 2)); break;
      case 'cancel': console.log(service.cancel(required(0), actor).summary); break;
      case 'retry': console.log(service.retry(required(0), actor).summary); break;
      case 'engine': console.log(service.switchEngine(required(0), actor, engineSchema.parse(required(1))).engine); break;
      case 'candidates': console.log(JSON.stringify(store.improvements(), null, 2)); break;
      case 'candidate': {
        const task = store.task(required(0));
        if (!service.project(task.projectId).ownerIds.includes(actor)) throw new Error('仅负责人可手工建立候选');
        const content = await readFile(required(1), 'utf8');
        if (!content.trim() || content.length > 20_000) throw new Error('候选应为 1–20000 字符');
        const candidate = { id: randomUUID().slice(0,8), taskId: task.id, status: 'candidate' as const, content, createdAt: new Date().toISOString(), promotedAt: null, evaluatedHash: null };
        store.recordImprovement(candidate); console.log(candidate.id); break;
      }
      case 'evaluate': console.log(JSON.stringify(await evaluateCandidate(config, store, instructions, engines, required(0), required(1)), null, 2)); break;
      case 'promote': await promoteCandidate(config, store, instructions, required(0), required(1), actor); console.log('候选已晋升，只影响之后的新任务'); break;
      case 'doctor': {
        const projects = [];
        for (const project of config.projects) {
          const git = await executeCommand({ name: '仓库检查', argv: ['git', 'status', '--porcelain'], timeoutMs: 5000 }, project.repository);
          projects.push({ id: project.id, repositoryAvailable: git.exitCode === 0, hasUncommittedChanges: git.output.length > 0, engine: project.engine, authentication: project.authentication?.[project.engine] ?? 'api_key', checks: project.checks.map(check => check.name), localOwnerConfigured: project.ownerIds.includes(actor) });
        }
        console.log(JSON.stringify({ node: process.versions.node, credentials: Object.fromEntries(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BOT_OPEN_ID'].map(key => [key, Boolean(process.env[key])])), feishu: { transport: process.env.FEISHU_CLI_PROFILE ? 'lark-cli' : 'node-sdk', profile: process.env.FEISHU_CLI_PROFILE ?? null, executable: process.env.FEISHU_CLI_PATH ?? 'lark-cli' }, projects, failedNotifications: store.notificationsWithErrors() }, null, 2)); break;
      }
      default: throw new Error(`未知命令 ${command}\n${help}`);
    }
  } finally { store.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
