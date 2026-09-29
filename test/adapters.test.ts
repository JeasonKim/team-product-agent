import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineRequest } from '../src/domain/model.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), start: vi.fn(), resume: vi.fn(), constructor: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class { constructor(options: unknown) { mocks.constructor(options); } startThread = mocks.start; resumeThread = mocks.resume; } }));
import { ClaudeEngine } from '../src/adapters/claude.js';
import { CodexEngine } from '../src/adapters/codex.js';
const output = { decision: 'ready', summary: '完成调查', rationale: '沿用现模型', question: null, affectedPaths: ['src/a.ts'], acceptance: ['行为正确'], edits: [], learning: null };
const request = (engine: 'claude' | 'codex'): EngineRequest => ({ taskId: 'test', engine, cwd: process.cwd(), prompt: '修复问题', instructions: '角色', sessionId: null, signal: new AbortController().signal, timeoutMs: 5000, onProgress: () => {} });
async function* frames(items: unknown[]) { for (const item of items) yield item; }
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('真实 SDK 事件适配契约（SDK 边界替身）', () => {
  it('两套 SDK 收到各自的模型和推理级别，默认值不强行覆盖', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key'); vi.stubEnv('OPENAI_API_KEY', 'test-key');
    mocks.query.mockReturnValue(frames([{ type: 'result', subtype: 'success', session_id: 'c', structured_output: output, usage: {} }]));
    mocks.start.mockReturnValue({ id: 'o', runStreamed: async () => ({ events: frames([{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }]) }) });
    await new ClaudeEngine().execute({ ...request('claude'), model: 'claude-model', effort: 'high' });
    await new CodexEngine().execute({ ...request('codex'), model: 'codex-model', effort: 'xhigh' });
    expect(mocks.query.mock.calls[0]![0].options).toMatchObject({ model: 'claude-model', effort: 'high' });
    expect(mocks.start.mock.calls[0]![0]).toMatchObject({ model: 'codex-model', modelReasoningEffort: 'xhigh' });
  });
  it('双 SDK 会话识别使用独立无工具上下文，不复用编码会话', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key'); vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const route = { intent: 'new', taskId: null, title: '价格展示', confidence: 'high', candidates: [], explanation: '独立需求', response: '' };
    mocks.query.mockReturnValue(frames([{ type: 'result', subtype: 'success', session_id: 'claude-route', structured_output: route, total_cost_usd: 0, usage: {} }]));
    mocks.start.mockReturnValue({ id: 'codex-route', runStreamed: async () => ({ events: frames([{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(route) } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }]) }) });
    expect((await new ClaudeEngine().interpretConversation({ ...request('claude'), sessionId: 'old' })).decision).toEqual(route);
    expect(mocks.query.mock.calls[0]![0].options.tools).toEqual([]);
    expect(mocks.query.mock.calls[0]![0].options.resume).toBeUndefined();
    expect((await new CodexEngine().interpretConversation({ ...request('codex'), sessionId: 'old' })).decision).toEqual(route);
    expect(mocks.constructor.mock.calls[0]![0].config.features.shell_tool).toBe(false);
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it('Claude 只接受成功的结构化结果，不把消息流关闭当成功', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    mocks.query.mockReturnValue(frames([{ type: 'system', subtype: 'init', session_id: 'claude-1' }, { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-1', structured_output: output, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 20 } }]));
    expect((await new ClaudeEngine().execute(request('claude'))).response).toEqual(output);
    mocks.query.mockReturnValue(frames([]));
    await expect(new ClaudeEngine().execute(request('claude'))).rejects.toThrow(/结果/);
    const options = mocks.query.mock.calls[0]![0].options;
    expect(options.tools).not.toContain('Bash');
    expect(options.settingSources).toEqual([]);
  });
  it('Codex 可继续本引擎会话，SDK 失败事件不能转为成功', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    mocks.resume.mockReturnValue({ id: 'codex-1', runStreamed: async () => ({ events: frames([{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }]) }) });
    const req = { ...request('codex'), sessionId: 'codex-1' };
    expect((await new CodexEngine().execute(req)).response).toEqual(output);
    expect(mocks.resume).toHaveBeenCalledWith('codex-1', expect.objectContaining({ approvalPolicy: 'never', webSearchMode: 'disabled' }));
    mocks.start.mockReturnValue({ id: 'codex-2', runStreamed: async () => ({ events: frames([{ type: 'turn.failed', error: { message: 'quota exceeded' } }]) }) });
    await expect(new CodexEngine().execute(request('codex'))).rejects.toThrow(/quota/);
  });
  it('缺少凭证时明确失败，不回退另一套模型或消费个人会话', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENAI_API_KEY', '');
    await expect(new ClaudeEngine().execute(request('claude'))).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(new CodexEngine().execute(request('codex'))).rejects.toThrow(/OPENAI_API_KEY/);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it('明确选择本机 Codex 登录时复用原生认证，不注入 API Key 或其他应用凭证', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-use');
    vi.stubEnv('FEISHU_APP_SECRET', 'must-not-inherit');
    vi.stubEnv('CODEX_HOME', '/test/codex');
    mocks.start.mockReturnValue({ id: 'local-1', runStreamed: async () => ({ events: frames([{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }]) }) });
    const result = await new CodexEngine().execute({ ...request('codex'), authentication: 'local_login' });
    expect(result.sessionId).toBe('local-1');
    const options = mocks.constructor.mock.calls[0]![0];
    expect(options.apiKey).toBeUndefined();
    expect(options.env.CODEX_HOME).toBe('/test/codex');
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.FEISHU_APP_SECRET).toBeUndefined();
  });
});
