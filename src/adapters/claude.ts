import { query, type Options, type HookCallback, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { responseJsonSchema, responseSchema, type AgentEngine, type EngineRequest, type EngineResult, type Usage } from '../domain/model.js';
import { conversationJsonSchema, conversationSchema, type Interpretation } from '../domain/conversation.js';
import { minimalEnvironment } from '../infra/process.js';
import { assertSafePath } from '../infra/workspace.js';
import { claudeEffortSchema } from '../config.js';
import { referencePrompt } from './inputs.js';

async function* claudeInput(request: EngineRequest, text: string): AsyncGenerator<SDKUserMessage> {
  const content: Exclude<SDKUserMessage['message']['content'], string> = [{ type: 'text', text }];
  for (const item of request.attachments ?? []) {
    if (item.kind !== 'image') continue;
    const mediaType = item.mimeType;
    if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/gif' && mediaType !== 'image/webp') throw new Error('Claude 不支持这个图片格式');
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: (await readFile(item.path)).toString('base64') } });
  }
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: request.sessionId ?? undefined };
}

export class ClaudeEngine implements AgentEngine {
  readonly id = 'claude' as const;
  async execute(request: EngineRequest): Promise<EngineResult> {
    const result = await this.generate(request, responseJsonSchema, false);
    return { ...result, response: responseSchema.parse(result.response) };
  }
  async interpretConversation(request: EngineRequest): Promise<Interpretation> {
    const result = await this.generate({ ...request, sessionId: null }, conversationJsonSchema, true);
    return { decision: conversationSchema.parse(result.response), sessionId: result.sessionId, usage: result.usage };
  }
  private async generate(request: EngineRequest, schema: Record<string, unknown>, conversation: boolean): Promise<{ response: unknown; sessionId: string; usage: Usage }> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Claude 缺少 ANTHROPIC_API_KEY；请在本机 .env 配置，不要通过飞书发送');
    const abortController = new AbortController();
    const abort = () => abortController.abort(request.signal.reason);
    request.signal.throwIfAborted();
    request.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => abortController.abort(new Error('Claude 执行超时')), request.timeoutMs);
    const guard: HookCallback = async input => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const tool = input.tool_name;
      let allowed = (conversation ? ['StructuredOutput'] : ['Read', 'Glob', 'Grep', 'StructuredOutput']).includes(tool);
      if (allowed && tool !== 'StructuredOutput') {
        const args = input.tool_input as Record<string, unknown>;
        const path = String(args.file_path ?? args.path ?? request.cwd);
        const local = relative(request.cwd, resolve(request.cwd, path));
        try { if (local) await assertSafePath(request.cwd, local); }
        catch (error) { allowed = false; request.onProgress(`只读路径检查拒绝：${String(error)}`); }
        if (String(args.pattern ?? '').split('/').includes('..')) allowed = false;
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny', permissionDecisionReason: allowed ? '项目内只读调查' : '工具或路径超出本轮授权；通过结构化结果提出需要' } };
    };
    const options: Options = {
      cwd: request.cwd, model: request.model, resume: request.sessionId ?? undefined,
      effort: conversation ? 'low' : request.effort ? claudeEffortSchema.parse(request.effort) : undefined,
      systemPrompt: conversation ? request.instructions : { type: 'preset', preset: 'claude_code', append: request.instructions },
      tools: conversation ? [] : ['Read', 'Glob', 'Grep'], settingSources: [], mcpServers: {}, strictMcpConfig: true,
      permissionMode: 'default', hooks: { PreToolUse: [{ hooks: [guard] }] },
      canUseTool: async () => ({ behavior: 'deny', message: '本轮仅允许项目内只读工具' }),
      outputFormat: { type: 'json_schema', schema },
      env: minimalEnvironment({ ANTHROPIC_API_KEY: apiKey }),
      abortController, maxTurns: conversation ? 3 : 40,
    };
    let result: { response: unknown; sessionId: string; usage: Usage } | undefined;
    try {
      const prompt = await referencePrompt(request);
      for await (const message of query({ prompt: request.attachments?.some(item => item.kind === 'image') ? claudeInput(request, prompt) : prompt, options })) {
        abortController.signal.throwIfAborted();
        if (message.type === 'assistant') request.onProgress('Claude 正在调查和生成方案');
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) throw new Error(`Claude 执行失败：${message.subtype}`);
          result = {
            response: message.structured_output ?? JSON.parse(message.result), sessionId: message.session_id,
            // 恢复会话的累计费用不能直接记作本轮费用，缺少可靠差值时保留未知。
            usage: { inputTokens: message.usage?.input_tokens ?? null, outputTokens: message.usage?.output_tokens ?? null, costUsd: request.sessionId ? null : message.total_cost_usd },
          };
        }
      }
      if (!result) throw new Error('Claude 未返回完整结构化结果');
      return result;
    } finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); }
  }
}
