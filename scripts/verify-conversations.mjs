// 真实 SDK 试验：消息传输模拟，编码、路由和项目检查均为真实生产路径。
// 独立业务断言留在此运行器中，不注入被测 Agent 上下文。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentStore } from '../dist/src/infra/store.js';
import { TaskService } from '../dist/src/service.js';
import { MessageRouter } from '../dist/src/adapters/messages.js';
import { CodexEngine } from '../dist/src/adapters/codex.js';
import { executeCommand } from '../dist/src/infra/process.js';
import { fingerprint } from '../dist/src/domain/policy.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = process.argv[2] ?? 'first';
const scratch = join(root, 'work');
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(join(scratch, `codex-conversation-${suite}-`));
const repository = join(directory, 'sample-shop');
await mkdir(repository);
const initialSource = `export function formatPrice(amount) { return String(amount); }
export function orderList(orders) { return [...orders]; }
export function emptyOrderMessage() { return '暂无记录'; }
`;
await writeFile(join(repository, 'product.mjs'), initialSource);
await writeFile(join(repository, 'checks.mjs'), `import assert from 'node:assert/strict';
import {formatPrice,orderList,emptyOrderMessage} from './product.mjs';
assert.equal(typeof formatPrice(12), 'string');
const orders = [{id:'a',createdAt:'2026-01-01'}, {id:'b',createdAt:'2026-01-02'}];
const saved = JSON.stringify(orders);
assert.equal(orderList(orders).length, 2);
assert.equal(JSON.stringify(orders), saved);
assert.notEqual(orderList(orders), orders);
assert.equal(typeof emptyOrderMessage(), 'string');
console.log('已有行为检查通过');
`);
await writeFile(join(repository, 'README.md'), '# 小店试验项目\n这是独立临时项目，product.mjs 提供价格显示、订单列表和空订单提示。订单的 createdAt 是 ISO 日期字符串。checks.mjs 是固定项目回归检查。\n');
for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Agent Trial', '-c', 'user.email=trial@example.invalid', 'commit', '-m', 'Isolated conversation trial fixture']]) {
  const r = await executeCommand({ name: 'setup', argv: ['git', ...args], timeoutMs: 10000 }, repository); assert.equal(r.exitCode, 0, r.output);
}
const config = { dataDirectory: join(directory, 'data'), localActorId: 'owner', maxIterations: 3, runTimeoutMs: 180000, projects: [{ id: 'sample-shop', name: '临时小店', repository, engine: 'codex', authentication: { codex: 'local_login' }, models: {}, requesterIds: ['teammate'], ownerIds: ['owner'], chatIds: ['trial-chat'], setup: [], checks: [{ name: '固定项目回归', argv: [process.execPath, 'checks.mjs'], timeoutMs: 10000 }], sensitivePaths: ['checks.mjs', 'AGENTS.md'] }] };
await writeFile(join(directory, 'config.json'), JSON.stringify(config, null, 2));
const skill = join(root, 'resources/skills/verify-and-improve');
const instructions = { role: await readFile(join(root, 'resources/agent-role.md'), 'utf8'), skill: `${await readFile(join(skill, 'SKILL.md'), 'utf8')}\n\n${await readFile(join(skill, 'references/agent-experience.md'), 'utf8')}` };
const store = new AgentStore(join(config.dataDirectory, 'agent.sqlite'));
const service = new TaskService(config, store, { codex: new CodexEngine() }, instructions);
let router = new MessageRouter(service);
const report = { suite, startedAt: new Date().toISOString(), directory, transport: 'simulated inbox/outbox; real Codex SDK local login; real coding/checks', steps: [], success: false };
let serial = 0;
function delivery() {
  const notices = store.pendingNotifications();
  for (const n of notices) {
    assert.doesNotMatch(n.text, /(?:同意|回答|拒绝) [a-f0-9]{8} [a-f0-9]{8}|待决编号/);
    store.delivered(n.id, `remote-${++serial}`);
  }
  return notices.map(n => n.text);
}
async function send(text, options = {}) {
  const started = Date.now();
  const id = options.id ?? `trial-${++serial}`;
  store.enqueueMessage({ id, text, actorId: options.actor ?? 'owner', chatId: 'trial-chat', replyTo: options.replyTo ?? null, createdAt: new Date().toISOString() });
  await router.dispatchPending();
  const responses = delivery();
  report.steps.push({ input: text, responses, durationMs: Date.now() - started, tasks: store.tasks().map(t => ({ id: t.id, title: t.title, status: t.status, interaction: t.interaction?.kind, feedback: t.feedback })) });
  console.log(JSON.stringify({ input: text, responses, states: store.tasks().map(t => `${t.title}:${t.status}`) }));
  return responses;
}
async function runToReady(id) {
  await service.drain(); delivery();
  const t = store.task(id);
  assert.equal(t.status, 'ready', `${t.status}: ${t.summary} ${t.interaction?.question ?? ''}`);
  assert.equal(store.evidence(id).some(e => e.kind === 'delivery' && e.passed), true);
}
async function product(id) { return import(`${pathToFileURL(join(store.task(id).workspace, 'product.mjs')).href}?trial=${++serial}`); }
function seed(question, kind = 'clarification') {
  const t = service.submit('sample-shop', 'owner', question, 'trial-chat');
  const plan = { decision: 'architecture', summary: question, rationale: '测试已有会话', question: '是否继续？', affectedPaths: ['product.mjs'], acceptance: [], edits: [], learning: null };
  store.mutateTask(t.id, task => { task.status = 'waiting'; task.plan = plan; task.planHash = fingerprint(plan); task.interaction = { id: `seed-${++serial}`, kind, question: kind === 'clarification' ? '小数位和货币符号希望如何显示？' : '是否按这个方案继续？', proposalHash: fingerprint(plan), createdAt: new Date().toISOString() }; });
  const current = store.task(t.id);
  store.notify({ id: `n-${++serial}`, taskId: t.id, interactionId: current.interaction.id, recipientType: 'chat_id', recipientId: 'trial-chat', text: current.interaction.question, createdAt: new Date().toISOString() });
  delivery(); return current;
}
try {
  if (suite === 'heldout') {
    report.transport = 'simulated transport and seeded prior task states; real Codex conversation inference';
    const a = seed('商品价格展示');
    await send('另外帮我把没有订单时的提示换成“还没有订单，去逛逛吧”');
    assert.equal(store.tasks().length, 2); assert.equal(store.task(a.id).status, 'waiting');
    await send('说回商品价格，两位小数就行，先不用货币符号');
    assert.equal(store.task(a.id).status, 'queued'); assert.match(store.task(a.id).feedback.join('\n'), /两位小数/);
    const c = seed('搜索结果分页', 'architecture');
    await send('这个方案我还没同意，先别执行');
    assert.equal(store.task(c.id).decisions.length, 0);
    const d = seed('导出订单报表', 'architecture');
    const menu = await send('没问题'); assert.match(menu.join('\n'), /1\./);
    assert.equal(store.task(c.id).decisions.length, 0); assert.equal(store.task(d.id).decisions.length, 0);
    await send('谢谢啦'); assert.equal(store.tasks().length, 4);
    const news = await send('订单报表那个现在进行到哪里了？'); assert.match(news.join('\n'), /订单报表/);
  } else {
    await send(suite === 'first' ? '价格展示保留两位小数。' : '商品金额显示整齐一点，统一显示到小数点后两位。');
    assert.equal(store.tasks().length, 1);
    const a = store.tasks()[0]; await runToReady(a.id);
    assert.equal((await product(a.id)).formatPrice(12.3), '12.30');
    assert.equal((await product(a.id)).formatPrice(0), '0.00');
    await send(suite === 'first' ? '另外做个订单排序，按创建时间从新到旧。' : '还有件事，订单列表让最新创建的排在最前面。');
    assert.equal(store.tasks().length, 2); assert.equal(store.task(a.id).status, 'ready');
    const b = store.tasks().find(t => t.id !== a.id); await runToReady(b.id);
    const orders = [{ id: 'old', createdAt: '2024-01-01' }, { id: 'new', createdAt: '2026-01-01' }, { id: 'middle', createdAt: '2025-01-01' }];
    assert.deepEqual((await product(b.id)).orderList(orders).map(x => x.id), ['new', 'middle', 'old']);
    assert.equal(orders[0].id, 'old');
    const menu = await send(suite === 'first' ? '同意' : '可以');
    assert.match(menu.join('\n'), /1\./); assert.match(menu.join('\n'), /2\./);
    const selected = store.conversation(JSON.stringify(['sample-shop', 'trial-chat', 'owner'])).selection.choices[1].taskId;
    router = new MessageRouter(service); await send('第二个');
    assert.equal(store.task(selected).status, 'completed');
    const other = [a.id, b.id].find(id => id !== selected);
    await send(`${store.task(other).title}那个，验收通过`);
    assert.equal(store.task(other).status, 'completed');
    await send(suite === 'first' ? '之前价格那个再加上人民币符号，放在数字前面。' : '金额那件事再调整一下，数字前面带上人民币符号。');
    assert.equal(store.tasks().length, 2); assert.equal(store.task(a.id).status, 'queued');
    await runToReady(a.id);
    assert.match((await product(a.id)).formatPrice(12.3), /^[¥￥]\s?12\.30$/);
    assert.match((await product(a.id)).formatPrice(0), /^[¥￥]\s?0\.00$/);
    await send('好的，就按这个方案做'); assert.equal(store.task(a.id).status, 'completed');
    await send('谢谢'); assert.equal(store.tasks().length, 2);
    assert.equal(await readFile(join(repository, 'product.mjs'), 'utf8'), initialSource);
  }
  report.success = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally {
  report.finishedAt = new Date().toISOString(); report.routes = store.routingEvidence();
  report.tasks = store.tasks().map(task => ({ task, runs: store.runs(task.id), evidence: store.evidence(task.id) }));
  // 固定 Codex 0.158.0 的完成事件实测报告会话累计 token；同一 session 取最后/最大累计值。
  const sessions = new Map();
  for (const result of [...report.routes.map(x => x.result), ...report.tasks.flatMap(x => x.runs)]) {
    if (!result?.usage || !result.sessionId) continue;
    const previous = sessions.get(result.sessionId);
    sessions.set(result.sessionId, { inputTokens: Math.max(previous?.inputTokens ?? 0, result.usage.inputTokens ?? 0), outputTokens: Math.max(previous?.outputTokens ?? 0, result.usage.outputTokens ?? 0) });
  }
  report.usageBasis = 'Codex 0.158.0 observed session totals; deduplicated by sessionId; includes cached input; monetary cost unavailable';
  report.usage = [...sessions.values()].reduce((sum, u) => ({ inputTokens: sum.inputTokens + u.inputTokens, outputTokens: sum.outputTokens + u.outputTokens, costUsd: null }), { inputTokens: 0, outputTokens: 0, costUsd: null });
  const out = join(root, 'validation'); await mkdir(out, { recursive: true });
  const filename = join(out, `conversation-${suite}-${report.startedAt.replaceAll(/[:.]/g, '-')}.json`);
  await writeFile(filename, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success: report.success, report: filename, directory, usage: report.usage }));
  store.close();
}
