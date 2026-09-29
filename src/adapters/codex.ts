import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import { join } from 'node:path';
import { responseJsonSchema, responseSchema, type AgentEngine, type EngineRequest, type EngineResult, type Usage } from '../domain/model.js';
import { minimalEnvironment } from '../infra/process.js';
import { applicationDirectory } from '../infra/paths.js';
import { conversationJsonSchema, conversationSchema, type Interpretation } from '../domain/conversation.js';
import { codexEffortSchema } from '../config.js';

export function codexReadOnlyFilesystem(cwd: string): string {
  return `permissions.team_agent_read.filesystem={":minimal"="read",${JSON.stringify(cwd)}="read",${JSON.stringify(`${cwd}/**/.env*`)}="deny"}`;
}
export class CodexEngine implements AgentEngine {
  readonly id = 'codex' as const;
  async execute(request: EngineRequest): Promise<EngineResult> {
    const result = await this.generate(request, responseJsonSchema, false);
    return { ...result, response: responseSchema.parse(result.response) };
  }
  async interpretConversation(request: EngineRequest): Promise<Interpretation> {
    const result = await this.generate({ ...request, sessionId: null }, conversationJsonSchema, true);
    return { decision: conversationSchema.parse(result.response), sessionId: result.sessionId, usage: result.usage };
  }
  private async generate(request: EngineRequest, schema: unknown, conversation: boolean): Promise<{ response: unknown; sessionId: string; usage: Usage }> {
    const localLogin = request.authentication === 'local_login';
    const apiKey = localLogin ? undefined : process.env.OPENAI_API_KEY;
    if (!localLogin && !apiKey) throw new Error('Codex 缺少 OPENAI_API_KEY；请在本机 .env 配置，或明确选择项目 authentication.codex=local_login');
    const authEnvironment: Record<string, string> = {};
    if (localLogin) for (const key of ['HOME', 'CODEX_HOME']) if (process.env[key]) authEnvironment[key] = process.env[key]!;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
    const client = new Codex({
      apiKey,
      codexPathOverride: join(applicationDirectory, 'resources', 'codex-launcher.mjs'),
      env: minimalEnvironment(authEnvironment),
      config: {
        developer_instructions: request.instructions,
        ...(conversation ? { project_doc_max_bytes: 0 } : {}),
        default_permissions: 'team_agent_read',
        features: { apps: false, hooks: false, plugins: false, remote_plugin: false, multi_agent: false, shell_tool: !conversation },
        shell_environment_policy: { inherit: 'none', set: { PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8' } },
        permissions: { team_agent_read: { network: { enabled: false } } },
      },
      configOverrides: [
        codexReadOnlyFilesystem(request.cwd),
        `projects.${JSON.stringify(request.cwd)}.trust_level="untrusted"`,
      ],
    });
    const options: ThreadOptions = { model: request.model, workingDirectory: request.cwd, approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled', threadSource: 'team-product-agent', skipGitRepoCheck: conversation, modelReasoningEffort: conversation ? 'low' : request.effort ? codexEffortSchema.parse(request.effort) : undefined };
    const thread = request.sessionId ? client.resumeThread(request.sessionId, options) : client.startThread(options);
    const { events } = await thread.runStreamed(request.prompt, { outputSchema: schema, signal });
    let finalText = '';
    let sessionId = request.sessionId;
    let completed = false;
    let usage: Usage = { inputTokens: null, outputTokens: null, costUsd: null };
    for await (const event of events) {
      signal.throwIfAborted();
      if (event.type === 'thread.started') sessionId = event.thread_id;
      if (event.type === 'item.completed' && event.item.type === 'agent_message') finalText = event.item.text;
      if (event.type === 'item.started') request.onProgress(event.item.type);
      if (event.type === 'turn.failed') throw new Error(event.error.message);
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'turn.completed') {
        completed = true;
        // 固定运行时 0.158.0 实测此事件为会话累计值；恢复后不能再次当成独立本轮费用相加。
        usage = { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens, cachedInputTokens: event.usage.cached_input_tokens ?? null, costUsd: null, scope: 'session' };
      }
    }
    sessionId ??= thread.id;
    if (!completed || !sessionId || !finalText) throw new Error('Codex 未返回完整结构化结果');
    return { response: JSON.parse(finalText) as unknown, sessionId, usage };
  }
}
