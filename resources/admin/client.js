const main = document.querySelector('#main');
const notice = document.querySelector('#notice');
const initialToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (initialToken) { sessionStorage.setItem('agent-admin-token', initialToken); history.replaceState(null, '', location.pathname + location.search); }
let state, settings, catalog = { codex: [] }, currentTask, dirty = false, loading = false;
let view = new URLSearchParams(location.search).get('view') || 'overview';
let taskId = new URLSearchParams(location.search).get('task');
let search = '', statusFilter = '', projectFilter = '', lastReceivedAt = 0;
const labels = { queued: '等待执行', running: '正在处理', waiting: '等待回复', ready: '待业务验收', completed: '已完成', failed: '需要协助', cancelled: '已取消', candidate: '待评估', promoted: '已启用', archived: '已停用', passed: '评估通过', interrupted: '已中断' };
const actions = { 'task.submitted': '收到新需求', 'task.transition': '执行进展', 'task.followup': '补充需求', 'task.reply': '处理待决事项', 'task.retry': '恢复执行', 'task.cancel': '取消需求', 'conversation.message': '收到消息', 'settings.updated': '更新 Agent 设置', 'settings.requested': '保存设置变更', 'access.requested': '新同事申请接入', 'access.granted': '开通产品权限', 'access.denied': '暂未开通权限', 'experience.created': '保存经验候选', 'experience.promoted': '启用已评估经验', 'experience.archived': '停用经验', 'evaluation.queued': '开始经验评估', 'evaluation.finished': '完成经验评估', 'evaluation.cancelled': '停止经验评估', 'notification.retry': '重试发送通知' };
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const projectName = id => state?.projects.find(p => p.id === id)?.name || id;
const badge = (status, label) => `<span class="status ${h(status)}">${h(label || labels[status] || status)}</span>`;
const engineName = id => id === 'claude' ? 'Claude Code' : 'Codex';
const empty = (title, subtitle = '') => `<div class="empty"><div class="empty-symbol"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg></div><strong>${h(title)}</strong>${h(subtitle)}</div>`;
const options = (items, value) => items.map(([id, name]) => `<option value="${h(id)}" ${id === (value ?? '') ? 'selected' : ''}>${h(name)}</option>`).join('');
const field = (label, name, value, hint = '', type = 'text') => `<div class="field"><label for="${h(name)}">${h(label)}</label><input id="${h(name)}" name="${h(name)}" type="${type}" value="${h(value)}">${hint ? `<small>${h(hint)}</small>` : ''}</div>`;
const area = (label, name, value, hint = '') => `<div class="field"><label for="${h(name)}">${h(label)}</label><textarea id="${h(name)}" name="${h(name)}">${h(value)}</textarea>${hint ? `<small>${h(hint)}</small>` : ''}</div>`;
function showNotice(text, error = false) { notice.textContent = text; notice.hidden = false; notice.className = error ? 'error' : ''; }
let pendingConfirmation;
function confirmAction(text) {
  const dialog=document.querySelector('#confirm-dialog');
  if (pendingConfirmation) return Promise.resolve(false);
  document.querySelector('#confirm-text').textContent=text;dialog.showModal();
  return new Promise(resolve=>{pendingConfirmation=resolve;});
}
function resolveConfirmation(answer) { document.querySelector('#confirm-dialog').close(); const resolve=pendingConfirmation;pendingConfirmation=undefined;resolve?.(answer); }
document.querySelector('#confirm-no').addEventListener('click',()=>resolveConfirmation(false));
document.querySelector('#confirm-yes').addEventListener('click',()=>resolveConfirmation(true));
document.querySelector('#confirm-dialog').addEventListener('cancel',()=>resolveConfirmation(false));
async function api(path, method = 'GET', data) {
  const response = await fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${sessionStorage.getItem('agent-admin-token') || ''}`, ...(data !== undefined ? { 'content-type': 'application/json' } : {}) }, body: data !== undefined ? JSON.stringify(data) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `请求未完成 (${response.status})`); return result;
}
async function refresh(render = true) {
  if (loading) return; loading = true;
  try {
    state = await api('/state');
    lastReceivedAt = Date.now();
    document.querySelector('#connection').textContent = state.activity.online ? state.health.feishu === 'connected' ? 'Agent 在线 · 飞书已连接' : 'Agent 在线 · 飞书未连接' : '暂未确认 Agent 在线';
    document.querySelector('.connection-dot').classList.toggle('offline',!state.activity.online);
    document.querySelector('#sync-time').textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 更新`;
    const count = state.metrics.attention + state.accessRequests.filter(r => r.status === 'pending').length + state.failedNotifications.length;
    document.querySelector('#attention-count').textContent = count || '';
    if (render) await renderView();
  } catch (error) { showNotice(error.message, true); markDisconnected(); if (!state) main.innerHTML = empty('暂时无法进入工作台', '请确认服务正在运行，并使用本机 data 目录的 admin.url 链接重新打开。'); }
  finally { loading = false; }
}
function markDisconnected() {
  document.querySelector('#connection').textContent = '无法连接 · 请检查本机服务';
  document.querySelector('.connection-dot').classList.add('offline');
  document.querySelectorAll('[data-live-status]').forEach(node=>{node.textContent='暂未确认在线';node.classList.add('offline');});
  const freshness=document.querySelector('#board-freshness');if(freshness)freshness.textContent='连接已中断，下方为上次读取的记录';
}
function taskRows(tasks) {
  return tasks.length ? tasks.map(t => `<a class="task-row" href="/?view=tasks&task=${h(t.id)}" data-task="${h(t.id)}"><div><div class="task-name">${h(t.title)}</div><div class="task-summary">${h(t.summary)}</div><div class="task-meta"><span>${h(projectName(t.projectId))}</span><span>·</span><span>${engineName(t.engine)}</span></div></div><div class="row-end">${badge(t.status, t.interaction?.kind === 'architecture' ? '待你审定方案' : t.interaction?.kind === 'recovery' ? '待你确认恢复' : undefined)}<small>${date(t.updatedAt)}</small></div></a>`).join('') : empty('这里暂时没有需求', '同事可以直接单聊机器人，用自己的话描述想改什么。');
}
function heading(title, description, eyebrow = '') { return `<div class="page-heading"><div>${eyebrow ? `<div class="eyebrow">${h(eyebrow)}</div>` : ''}<h1>${h(title)}</h1><p class="lead">${h(description)}</p></div><span class="date-label">${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span></div>`; }
function accessCards() {
  return state.accessRequests.filter(r => r.status === 'pending').map(r => `<div class="access-card"><div class="section-heading"><h3>新同事申请接入</h3>${badge('waiting', '待开通')}</div><p class="text-block">${h(r.message.text)}</p><p class="muted"><small>飞书身份：${h(r.actorId)}</small></p><div class="actions"><select aria-label="为这位同事选择产品" id="access-${h(r.id)}">${options(state.projects.map(p => [p.id, p.name]))}</select><button class="primary small" data-access="${h(r.id)}" data-grant="yes">开通并继续需求</button><button class="quiet small" data-access="${h(r.id)}" data-grant="no">暂不开通</button></div></div>`).join('');
}
function renderOverview() {
  const attention = state.tasks.filter(t => t.status === 'failed' || ['architecture', 'recovery'].includes(t.interaction?.kind));
  const attentionCount = attention.length + state.accessRequests.filter(r => r.status === 'pending').length + state.failedNotifications.length;
  main.innerHTML = `${heading('把日常需求交给分身', '了解进展，处理关键决定，让团队的想法持续变成产品改进。', 'YOUR TEAM, IN PROGRESS')}
  <div class="metric-grid"><div class="metric emphasis"><div class="metric-label">需要你处理</div><div class="metric-value">${attentionCount}<span class="metric-note"> 件</span></div><div class="metric-note">关键决定集中在这里</div></div><div class="metric"><div class="metric-label">正在推进</div><div class="metric-value">${state.metrics.active}</div><div class="metric-note">包含等待澄清与验收的需求</div></div><div class="metric"><div class="metric-label">已验收完成</div><div class="metric-value">${state.metrics.completed}</div><div class="metric-note">累计 ${state.metrics.total} 个需求</div></div><div class="metric"><div class="metric-label">已启用经验</div><div class="metric-value">${state.metrics.improved}</div><div class="metric-note">经过独立评估后积累</div></div></div>
  <div class="columns"><div><section class="panel"><div class="section-heading"><div><h2>待我处理</h2><div class="section-caption">业务细节交给需求者，关键边界由你决定。</div></div><span class="badge-outline">${attentionCount} 件</span></div>${accessCards()}${attention.length ? taskRows(attention) : ''}${state.failedNotifications.map(n => `<div class="access-card"><h3>通知发送失败</h3><p class="text-block">${h(n.error)}</p><button class="small" data-notification="${h(n.id)}">重新发送</button></div>`).join('')}${!attentionCount ? empty('暂时不需要你介入', '分身会继续处理已授权的需求。遇到架构决定或执行失败，会通过飞书单聊通知你。') : ''}</section><section class="panel"><div class="section-heading"><h2>最近的需求</h2><a class="subtle-link" href="/?view=tasks" data-view="tasks">查看全部 →</a></div>${taskRows(state.tasks.slice(0, 5))}</section></div>
  <div><section class="panel"><div class="panel-body"><div class="section-heading"><h2>从一句话开始</h2><span class="badge-outline">单聊优先</span></div><div class="step"><span class="step-number">1</span><div><strong>直接单聊机器人</strong><p>告诉它想改哪个功能、期望什么效果；多个产品首次选择后会记住。</p></div></div><div class="step"><span class="step-number">2</span><div><strong>分身调查、实现并检查</strong><p>遇到业务问题问提出者；涉及架构或执行异常时通知你。</p></div></div><div class="step"><span class="step-number">3</span><div><strong>确认结果，留下经验</strong><p>在原会话中补充和验收。有效经验经过对比评估，再用于后续需求。</p></div></div><div class="divider"></div><p class="muted"><small>群里 @ 机器人也可以。默认只回复一次收件提示，详细过程转入单聊。</small></p></div></section>
  <section class="panel"><div class="panel-body"><div class="section-heading"><h2>已接入产品</h2><a class="subtle-link" href="/?view=settings" data-view="settings">配置</a></div>${state.projects.map(p => `<div class="product-row"><span class="product-icon">${h(p.name.slice(0, 1))}</span><div><strong>${h(p.name)}</strong><small>${engineName(p.engine)} · ${h(p.model || '引擎默认模型')}</small></div></div>`).join('')}<div class="divider"></div><p class="muted"><small>在独立工作副本中执行，保留方案、检查记录和交付补丁。</small></p></div></section></div></div>`;
}
function renderTasks(focusResults = false) {
  const filtered = state.tasks.filter(t => (!projectFilter || t.projectId === projectFilter) && (!statusFilter || t.status === statusFilter) && (!search || `${t.title} ${t.summary} ${projectName(t.projectId)} ${t.model || ''}`.toLowerCase().includes(search.toLowerCase())));
  const projects=state.activity.projects.filter(p=>!projectFilter||p.id===projectFilter);
  const previousBoard=document.querySelector('.task-board');
  const boardScroll=previousBoard?.scrollLeft || 0;
  const laneScroll=new Map([...document.querySelectorAll('.lane-cards')].map(node=>[node.id,node.scrollTop]));
  main.innerHTML = `${heading('需求与进展', '从想法到交付，每件事都有自己的位置。点击卡片，查看方案、证据和下一步。','WORK IN MOTION')}
  <section class="agent-presence" aria-label="Agent 运行状态"><div class="presence-heading"><div><span class="presence-dot ${state.activity.online?'':'offline'}"></span><strong>${h(state.activity.name)}</strong><span class="presence-status ${state.activity.online?'':'offline'}" data-live-status>${state.activity.online?'在线':'暂未确认在线'}</span></div><span id="board-freshness">${state.health.feishu==='connected'?'飞书已连接':'飞书未连接'} · 每 10 秒更新</span></div><div class="agent-products">${projects.map(p=>`<div class="agent-product"><div><span class="product-icon">${h(p.name.slice(0,1))}</span><div><strong>${h(p.name)}</strong><span class="model-caption">新需求默认配置</span></div></div><div class="agent-model"><span class="engine-chip">${engineName(p.engine)} SDK</span><strong>${h(p.model||'引擎默认模型')}</strong><span>推理 ${h(p.effort||'模型默认')}</span></div><div class="agent-load"><span><b>${p.counts.running}</b> 进行中</span><span><b>${p.counts.queued+p.counts.waiting+p.counts.ready+p.counts.failed}</b> 待办</span></div></div>`).join('')}</div></section>
  <div class="toolbar board-toolbar"><input id="task-search" type="search" aria-label="搜索需求" placeholder="搜索需求、产品或模型…" value="${h(search)}"><select id="project-filter" aria-label="按产品筛选">${options([['','全部产品'],...state.projects.map(p=>[p.id,p.name])],projectFilter)}</select><select id="task-filter" aria-label="按状态筛选">${options([['','全部状态'], ...Object.entries(labels).filter(([id]) => ['queued','running','waiting','ready','completed','failed','cancelled'].includes(id))], statusFilter)}</select><span class="board-total">${filtered.length} 个需求</span></div>
  <div class="lane-index" aria-label="跳转到状态泳道">${state.lanes.map(lane=>`<button class="lane-jump ${lane.id}" data-lane="${lane.id}"><span></span>${lane.title}<b>${filtered.filter(t=>lane.statuses.includes(t.status)).length}</b></button>`).join('')}</div>
  <div class="task-board" role="region" aria-label="需求状态看板" tabindex="0">${state.lanes.map(lane=>{
    const tasks=filtered.filter(t=>lane.statuses.includes(t.status));
    return `<section class="task-lane ${lane.id}" id="lane-${lane.id}" aria-labelledby="lane-title-${lane.id}"><header><h2 id="lane-title-${lane.id}"><span class="lane-dot"></span>${lane.title}</h2><span class="lane-count">${tasks.length}</span></header><div class="lane-cards" id="cards-${lane.id}">${tasks.length?tasks.map(t=>boardCard(t)).join(''):`<div class="lane-empty"><span>—</span>${search||statusFilter||projectFilter?'没有符合筛选的需求':'暂无此状态的需求'}</div>`}</div></section>`;
  }).join('')}</div><p class="board-footnote">卡片中的模型与推理级别来自任务快照。待办包含待执行、等待回复、待验收和需要协助的需求。</p>`;
  const board=document.querySelector('.task-board');
  board.scrollLeft=boardScroll;
  if(!previousBoard||focusResults){
    const first=state.lanes.find(lane=>filtered.some(task=>lane.statuses.includes(task.status)));
    const lane=first&&document.getElementById(`lane-${first.id}`);
    if(lane)board.scrollLeft+=lane.getBoundingClientRect().left-board.getBoundingClientRect().left;
  }
  for(const [id,top] of laneScroll){const node=document.getElementById(id);if(node)node.scrollTop=top;}
  if(Date.now()-lastReceivedAt>20_000)markDisconnected();
}
function boardCard(task) {
  const next={clarification:'等待需求方补充',architecture:'等待负责人审定',recovery:'等待负责人确认恢复',acceptance:'等待需求方验收'}[task.interaction?.kind];
  return `<a class="board-card" href="/?view=tasks&task=${h(task.id)}" data-task="${h(task.id)}"><div class="card-top"><span class="card-product">${h(projectName(task.projectId))}</span>${task.status==='cancelled'?badge('cancelled'):task.status==='completed'?badge('completed'):task.status==='running'?`<span class="card-phase">${task.phase==='plan'?'调查方案':'实现与验证'}</span>`:''}</div><h3>${h(task.title)}</h3><p class="card-summary">${h(task.summary)}</p>${next?`<div class="card-next">${h(next)}</div>`:''}<div class="card-engine"><span>${engineName(task.engine)}</span><span>${h(task.model||'引擎默认模型')}</span></div><footer><span>推理 ${h(task.effort||'模型默认')}</span><time datetime="${h(task.updatedAt)}">${date(task.updatedAt)}</time></footer></a>`;
}
function decisionPanel(task) {
  const interaction = task.interaction;
  if (['completed', 'cancelled'].includes(task.status)) return '';
  const needsText = interaction?.kind === 'clarification';
  const title = task.status === 'failed' ? '这一步需要你协助' : { architecture: '请审定这个方案', recovery: '请确认是否恢复执行', acceptance: '等待业务验收', clarification: '还有一个业务问题' }[interaction?.kind] || '补充你的想法';
  return `<section class="decision"><div class="section-heading"><h2>${title}</h2>${badge(task.status)}</div><p class="text-block">${h(interaction?.question || task.summary)}</p>${interaction?.kind === 'acceptance' ? '<p class="hint">验收表示需求结果符合预期。交付物是独立工作副本和补丁，尚未自动合并或上线。</p><br>' : ''}<label for="task-feedback">${needsText ? '业务答案' : '需要调整或补充的内容'}<small>${needsText ? '' : '（可选）'}</small></label><textarea id="task-feedback" placeholder="直接写下你的决定或想法…"></textarea><div class="actions"><button class="primary" data-action="${task.status === 'failed' ? 'retry' : interaction && !needsText ? 'approve' : needsText ? 'reply' : 'followup'}">${task.status === 'failed' ? '保留现场并重试' : interaction ? { architecture: '按此方案继续', recovery: '确认恢复', acceptance: '通过业务验收', clarification: '回复并继续' }[interaction.kind] : '提交补充'}</button>${interaction && !needsText ? '<button data-action="reject">提出调整</button>' : ''}<button class="quiet danger" data-action="cancel">停止这个需求</button></div></section>`;
}
function renderDetail(detail) {
  currentTask = detail.task; const t = detail.task;
  main.innerHTML = `<button class="quiet back" data-view="tasks">← 所有需求</button>${heading(t.title || t.request.slice(0, 40), `${projectName(t.projectId)} · ${engineName(t.engine)} · ${date(t.createdAt)} 提出`)}<div class="detail-grid"><div>${decisionPanel(t)}<section class="panel"><div class="panel-body"><div class="section-heading"><h2>需求与方案</h2>${badge(t.status)}</div><p class="text-block">${h(t.request)}</p>${t.plan ? `<div class="divider"></div><h3>当前方案</h3><p class="text-block">${h(t.plan.summary)}\n${h(t.plan.rationale)}</p><div class="pill-row">${t.plan.affectedPaths.map(p => `<span class="badge-outline">${h(p)}</span>`).join('')}</div><h3>验收依据</h3><p class="text-block">${h(t.plan.acceptance.map(a => `• ${a}`).join('\n'))}</p>` : '<p class="muted"><small>方案会在调查完成后记录在这里。</small></p>'}${t.feedback.length ? `<details><summary>需求补充与反馈（${t.feedback.length}）</summary><div class="text-block">${h(t.feedback.join('\n\n'))}</div></details>` : ''}</div></section>
  <section class="panel"><div class="section-heading"><h2>检查与交付</h2>${detail.evidence.some(e => e.artifact) ? '<button class="small" data-download>下载最新补丁</button>' : ''}</div><div class="panel-body">${detail.evidence.length ? detail.evidence.map(e => `<div><div class="check-row"><strong>${{baseline:'原始基线',verification:'改动后验证',delivery:'交付产物'}[e.kind]}</strong>${badge(e.passed ? 'passed' : 'failed', e.passed ? '通过' : '未通过')}</div><small>${date(e.createdAt)}</small>${e.checks.map(c => `<details><summary>${h(c.name)} · ${c.timedOut ? '超时' : `退出码 ${c.exitCode}`} · ${(c.durationMs / 1000).toFixed(1)} 秒</summary><pre>${h(c.output || '无输出')}${c.truncated ? '\n（输出已截断）' : ''}</pre></details>`).join('')}</div>`).join('<div class="divider"></div>') : '<p class="muted">执行后会显示实际运行的检查结果。</p>'}</div></section>
  <section class="panel"><div class="panel-body"><h2>把这次经验留给分身</h2><p class="section-caption">记录你的纠正或可复用做法，评估后再用于后续任务。</p><form id="candidate-form"><div class="field"><label for="candidate-content">经验内容</label><textarea id="candidate-content" name="content" required maxlength="20000" placeholder="例如：金额展示统一使用现有格式化函数，并验证空值、小数和负数。"></textarea></div><button type="submit">保存为经验候选</button></form></div></section></div>
  <div><section class="panel"><div class="panel-body"><h2>执行信息</h2><dl class="detail-meta"><dt>运行引擎</dt><dd>${engineName(t.engine)}</dd><dt>模型</dt><dd>${h(t.projectSnapshot.models[t.engine] || '引擎默认')}</dd><dt>推理级别</dt><dd>${h(t.projectSnapshot.efforts?.[t.engine] || '引擎默认')}</dd><dt>修复轮次</dt><dd>${t.iteration} / ${t.maxIterations}</dd><dt>会话版本</dt><dd>${t.revision}</dd><dt>最后更新</dt><dd>${date(t.updatedAt)}</dd></dl><details><summary>技术信息与身份快照</summary><pre>${h(JSON.stringify({ taskId:t.id, requesterId:t.requesterId, workspace:t.workspace, baseCommit:t.baseCommit, sdkSession:t.sessionId, delivery:t.delivery, versions:t.versions },null,2))}</pre><pre>${h(t.role)}</pre><pre>${h(t.experience || '此任务尚未使用已晋升经验。')}</pre></details></div></section>
  <section class="panel"><div class="panel-body"><div class="section-heading"><h2>过程记录</h2><span class="badge-outline">${detail.timeline.length} 条</span></div><ol class="timeline">${detail.timeline.slice().reverse().map(e => `<li><strong>${h(actions[e.action] || e.action)}</strong>${e.action === 'task.transition' ? `<p>${h(e.detail.after.summary)}</p>` : ''}<small>${date(e.createdAt)} · ${e.actorId === 'system' ? '分身' : e.actorId === state.localActorId ? '你' : h(e.actorId)}</small><details><summary>查看记录</summary><pre>${h(JSON.stringify(e.detail,null,2))}</pre></details></li>`).join('') || '<li>旧任务在升级后继续记录新进展；已有运行记录保留如下。</li>'}</ol><details><summary>SDK 运行记录（${detail.runs.length}）</summary>${detail.runs.map(r => `<div><strong>${r.phase === 'plan' ? '调查方案' : '执行修改'} · ${h(r.status)}</strong><small> ${date(r.startedAt)}</small><pre>${h(JSON.stringify(r,null,2))}</pre></div>`).join('')}</details><details><summary>通知送达记录（${detail.notifications.length}）</summary>${detail.notifications.map(n => `<div><small>${h(n.status)} · ${date(n.createdAt)} · ${h(n.recipientId)}</small><p class="text-block">${h(n.text)}</p>${n.error ? `<p>${h(n.error)}</p>` : ''}</div>`).join('<div class="divider"></div>')}</details></div></section></div></div>`;
}
function renderLearning() {
  const candidates = state.improvements.filter(i => i.status !== 'archived');
  main.innerHTML = `${heading('每次协作，都积累一点经验', '明确的偏好直接写入身份设置；从任务里总结的方法，先验证效果再启用。', 'LEARNING WITH EVIDENCE')}<div class="hint">经验的成长路径：任务中发现 → 保存候选 → 与原始表现对比、验证保留场景 → 负责人启用。启用只影响新任务，随时可停用；不会修改角色边界或扩大权限。</div><br><div class="columns"><section class="panel"><div class="section-heading"><h2>经验库</h2><span class="badge-outline">${candidates.length} 条</span></div>${candidates.length ? candidates.map(i => {
    const jobs = state.evaluations.filter(j => j.candidateId === i.id); const last = jobs.at(-1); const running = last && ['queued','running'].includes(last.status);
    return `<article class="experience"><div class="experience-meta">${badge(i.status)}<span>${h(projectName(i.projectId))}</span>${i.validatedEngines?.length ? `<span>适用 ${i.validatedEngines.map(engineName).join('、')}</span>` : ''}</div><p class="text-block">${h(i.content)}</p><div class="experience-meta"><a class="subtle-link" data-task="${h(i.taskId)}" href="/?view=tasks&task=${h(i.taskId)}">来源：${h(i.sourceTitle || '查看原始需求')} ↗</a><span>${date(i.createdAt)}</span></div>${last ? `<div class="job">${badge(last.status,{failed:'暂不启用',queued:'等待评估',running:'正在评估'}[last.status])} <span>${h(last.summary)}</span><div class="actions">${last.reportId ? `<button class="small quiet" data-report="${h(last.id)}">查看对比报告</button>` : ''}${running ? `<button class="small quiet" data-stop-evaluation="${h(last.id)}">停止评估</button>` : ''}</div></div>` : ''}<div class="actions">${i.status === 'candidate' ? `${!running ? `<button class="small" data-evaluate="${h(i.id)}">${last ? '重新评估' : '独立评估'}</button>` : ''}${last?.status === 'passed' ? `<button class="small primary" data-promote="${h(i.id)}" data-job="${h(last.id)}">启用这条经验</button>` : ''}` : ''}<button class="small quiet" data-archive="${h(i.id)}">${i.status === 'promoted' ? '停用' : '归档'}</button></div></article>`;
  }).join('') : empty('有效经验，从真实需求里长出来', '分身会在交付时总结候选。你也可以在任务详情里记录一次纠正，再发起独立评估。')}</section><div><section class="panel"><div class="panel-body"><h2>让它更懂你的方式</h2><div class="divider"></div><div class="step"><span class="step-number">1</span><div><strong>稳定的协作偏好</strong><p>例如沟通风格、架构偏好、对交付物的要求。由你明确设置，直接用于新任务。</p></div></div><div class="step"><span class="step-number">2</span><div><strong>有证据的方法改进</strong><p>在独立副本重复比较原始表现和候选表现，既看改进，也检查旧场景是否退化。</p></div></div><div class="step"><span class="step-number">3</span><div><strong>引擎分别验证</strong><p>用 Codex 验证过的经验只给 Codex 使用；换引擎不会把未经验证的经验自动带过去。</p></div></div><button class="small" data-view="settings">设置协作偏好</button></div></section><section class="panel"><div class="panel-body"><h3>评估需要什么？</h3><p class="section-caption">在产品高级设置中指定独立评估场景文件，包含回归与保留场景。每个场景会运行原始与候选各两次，会消耗当前模型额度。准备好的场景应独立于 Agent 的实现。</p></div></section></div></div><details><summary>已停用的经验（${state.improvements.length - candidates.length}）</summary>${state.improvements.filter(i => i.status === 'archived').map(i => `<div class="panel-body text-block">${h(i.content)}</div>`).join('')}</details>`;
}
function effortOptions(engine, value, model) {
  const known = catalog.codex.find(m => m.id === model);
  const efforts = engine === 'claude' ? ['low','medium','high','xhigh','max'] : known?.efforts || ['minimal','low','medium','high','xhigh','max','ultra','persistent'];
  if (value && !efforts.includes(value)) efforts.push(value);
  const descriptions = { minimal:'最低', low:'低', medium:'中等', high:'高', xhigh:'更高', max:'最高', ultra:'超高', persistent:'持续推理' };
  return options([['','跟随模型默认'], ...efforts.map(e => [e, `${descriptions[e] || e} · ${e}`])], value);
}
function renderSettings() {
  const c = settings.config; const p = c.profile || { name:'研发分身', role:'帮助团队产品和运营完成已有产品的改进', style:'简洁、直接，用业务语言沟通，说明结果和下一步。', preferences:'优先维护统一的业务模型，沿用现有能力；有证据再交付。' };
  main.innerHTML = `${heading('定义你的研发分身', '配置如何思考、怎样协作，以及哪些产品和同事可以接入。')}<form id="settings-form"><section class="settings-section"><div class="section-description"><h2>身份与协作方式</h2><p>让它知道自己为谁工作，以及你对沟通与交付的期待。</p></div><div class="panel"><div class="panel-body">${field('分身称呼','profile-name',p.name,'用于 Agent 的协作身份；飞书联系人名称在开放平台管理。')}${area('职责定位','profile-role',p.role)}${area('沟通风格','profile-style',p.style)}${area('你的长期偏好','profile-preferences',p.preferences,'这些偏好直接用于新任务；授权边界、独立验证和人工决定仍由宿主控制。')}</div></div></section>
  <section class="settings-section"><div class="section-description"><h2>入口与通知</h2><p>同事通过单聊提需求；只有需要你决定的事项才发给你。</p></div><div class="panel"><div class="panel-body"><div class="field"><label for="group-mode">群聊收到需求时</label><select id="group-mode" name="group-mode">${options([['private','只提示一次已收件，后续转单聊'],['milestones','详细过程单聊，群里保留关键结果'],['group','在群里继续处理（需要 @ 机器人）']],c.notifications?.groupMode || 'private')}</select><small>不会影响已建立任务的通知方式。私聊自动记住所选产品。</small></div><div class="hint">负责人通知：架构方案待审定、执行中断待恢复、自动修复失败。业务澄清与日常验收直接交给需求提出者。</div></div></div></section>
  <section class="settings-section"><div class="section-description"><h2>产品与模型</h2><p>每个产品可以使用不同的引擎、模型和推理级别。保存后用于新需求。</p><p>Codex 模型列表来自本机目录，也可以手填。实际可用模型与级别由账号和 SDK 决定。</p></div><div>${c.projects.map((project,i) => `<section class="panel"><div class="panel-body"><div class="section-heading"><h2>${h(project.name)}</h2><span class="badge-outline">${h(project.id)}</span></div><div class="field"><label for="project-${i}-engine">默认执行引擎</label><select name="project-${i}-engine" id="project-${i}-engine">${options([['codex','Codex SDK'],['claude','Claude Code SDK']],project.engine)}</select></div>${['codex','claude'].map(engine => `<div class="engine-block"><div class="engine-heading"><strong>${engineName(engine)}</strong><small>${engine === 'claude' ? state.credentials.claudeApiKey ? 'API Key 已配置' : 'API Key 尚未配置' : project.authentication?.codex === 'local_login' ? '使用本机 Codex 登录' : state.credentials.codexApiKey ? 'API Key 已配置' : 'API Key 尚未配置'}</small></div><div class="form-grid"><div class="field"><label for="project-${i}-${engine}-model">模型</label><input id="project-${i}-${engine}-model" name="project-${i}-${engine}-model" value="${h(project.models[engine] || '')}" placeholder="留空使用引擎默认模型" ${engine === 'codex' ? 'list="codex-models"' : ''} data-model-engine="${engine}" data-project-index="${i}"></div><div class="field"><label for="project-${i}-${engine}-effort">推理级别</label><select id="project-${i}-${engine}-effort" name="project-${i}-${engine}-effort">${effortOptions(engine,project.efforts?.[engine],project.models[engine])}</select></div></div>${engine === 'codex' ? `<div class="field"><label for="project-${i}-auth">认证方式</label><select id="project-${i}-auth" name="project-${i}-auth">${options([['local_login','本机已登录 Codex'],['api_key','OPENAI_API_KEY']], project.authentication?.codex || 'api_key')}</select></div>` : '<small>Claude 使用本机 ANTHROPIC_API_KEY，密钥不在管理页面中传输或显示。</small>'}</div>`).join('')}<details><summary>产品接入、成员与检查</summary>${field('产品名称',`project-${i}-name`,project.name)}${field('本机 Git 仓库',`project-${i}-repository`,project.repository,'实际修改在独立工作副本中完成。')}${area('可提需求的飞书成员',`project-${i}-requesters`,project.requesterIds.join('\n'),'每行一个 open_id。也可以在总览中批准同事发起的接入申请。')}${area('项目负责人',`project-${i}-owners`,project.ownerIds.join('\n'),'保留本机管理身份；填入飞书 open_id 后可接收需要介入的单聊通知。')}${area('绑定的群聊',`project-${i}-chats`,project.chatIds.join('\n'),'每行一个 chat_id。单聊不要求绑定群。')}${field('独立评估场景文件',`project-${i}-manifest`,project.evaluationManifest || '', '用于经验对比评估的本机 JSON 文件路径。')}<div class="field"><label class="checkbox-label"><input type="checkbox" name="project-${i}-auto-evaluate" ${project.autoEvaluate ? 'checked' : ''}> 需求验收后，自动评估它产生的经验候选</label><small>需先配置场景文件；每个候选只自动评估一次，最多同时运行一组。评估会消耗模型额度，通过后通知你决定是否启用。</small></div>${area('固定检查命令（JSON）',`project-${i}-checks`,JSON.stringify(project.checks,null,2),'宿主运行这些检查；Agent 不可自行降低断言。')}${area('环境准备命令（JSON）',`project-${i}-setup`,JSON.stringify(project.setup,null,2))}${area('需负责人审定的路径',`project-${i}-sensitive`,project.sensitivePaths.join('\n'),'每行一个文件或目录前缀；目录以 / 结尾。仓库、权限和检查发生变化时，旧任务会要求负责人重新核对。')}</details></div></section>`).join('')}<datalist id="codex-models">${catalog.codex.map(m => `<option value="${h(m.id)}">${h(m.name)}</option>`).join('')}</datalist></div></section>
  <section class="settings-section"><div class="section-description"><h2>自主执行范围</h2><p>限定一轮任务的修复次数和超时，失败后保留现场并通知你。</p></div><div class="panel"><div class="panel-body"><div class="form-grid">${field('最多自动修复轮次','max-iterations',c.maxIterations,'1–20 次','number')}${field('每次执行超时（秒）','run-timeout',c.runTimeoutMs/1000,'包括 SDK 调查和生成过程','number')}</div></div></div></section><div class="save-bar"><span class="muted" id="save-state">模型、推理级别与身份设置只影响新任务。</span><button class="primary" type="submit">保存设置</button></div></form><details><summary>最近的管理变更</summary>${state.audit.filter(e => !e.taskId).slice(0,15).map(e => `<div class="audit-row">${h(actions[e.action] || e.action)}<small>${date(e.createdAt)} · ${h(e.actorId)}</small><details><summary>查看变更记录</summary><pre>${h(JSON.stringify(e.detail,null,2))}</pre></details></div>`).join('')}</details>`;
  main.querySelector('#profile-name').required = true; main.querySelector('#profile-role').required = true;
  const iterations = main.querySelector('#max-iterations'); iterations.min = 1; iterations.max = 20; iterations.required = true;
  const timeout = main.querySelector('#run-timeout'); timeout.min = 1; timeout.required = true;
}
async function renderView() {
  main.classList.toggle('board-main',view==='tasks'&&!taskId);
  const names = { overview:'总览', tasks:'需求与进展', learning:'经验与成长', settings:'Agent 设置' };
  if (!names[view]) view = 'overview';
  document.querySelectorAll('nav [data-view]').forEach(a => { a.classList.toggle('active', a.dataset.view === view); if (a.dataset.view === view) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  document.querySelector('#breadcrumb').textContent = `工作空间 / ${names[view]}${taskId ? ' / 需求详情' : ''}`;
  if (taskId) { renderDetail(await api(`/tasks/${taskId}`)); return; }
  currentTask = null;
  if (view === 'overview') renderOverview();
  if (view === 'tasks') renderTasks();
  if (view === 'learning') renderLearning();
  if (view === 'settings') { [settings,catalog] = await Promise.all([api('/settings'),api('/models')]); renderSettings(); }
}
async function navigate(nextView, nextTask = null) {
  if (dirty && !await confirmAction('还有未保存的内容，确定离开此页面吗？')) return;
  dirty = false; view = nextView; taskId = nextTask;
  const query = new URLSearchParams({ view }); if (taskId) query.set('task',taskId);
  history.pushState(null,'',`/?${query}`); notice.hidden = true;
  await renderView(); main.focus(); window.scrollTo(0,0);
}
async function busy(button, run) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await run(); } catch (error) { showNotice(error.message,true); }
  finally { if (button?.isConnected) button.disabled = false; }
}
document.addEventListener('click', event => {
  const button = event.target.closest('button,a'); if (!button || button.matches('button[type=submit]')) return;
  if (button.dataset.view || button.dataset.task) { event.preventDefault(); void busy(button,() => navigate(button.dataset.task ? 'tasks' : button.dataset.view,button.dataset.task || null)); return; }
  void busy(button,async () => {
    if (button.dataset.lane) {
      const lane=document.getElementById(`lane-${button.dataset.lane}`),board=document.querySelector('.task-board');
      if(lane&&board)board.scrollTo({left:board.scrollLeft+lane.getBoundingClientRect().left-board.getBoundingClientRect().left,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      return;
    }
    if (button.id === 'refresh') { if (dirty) { showNotice('请先保存当前填写的内容，再刷新页面。'); return; } await refresh(); }
    else if (button.dataset.action) {
      const action = button.dataset.action; const text = document.querySelector('#task-feedback').value.trim();
      if (['reply','followup','reject'].includes(action) && !text) { showNotice('请先写下需要补充或调整的内容。',true); document.querySelector('#task-feedback').focus(); return; }
      if (action === 'cancel' && !await confirmAction('停止这个需求？工作副本和过程记录会保留。')) return;
      await api(`/tasks/${currentTask.id}/action`,'POST',{ action,revision:currentTask.revision,interactionId:currentTask.interaction?.id,text });
      dirty = false; await refresh(); showNotice('已记录你的决定，后续进展会继续通知相关同事。');
    } else if (button.dataset.access) {
      const projectId = document.getElementById(`access-${button.dataset.access}`).value;
      await api('/access','POST',{id:button.dataset.access,projectId,grant:button.dataset.grant === 'yes'}); await refresh(); showNotice('接入申请已处理。');
    } else if (button.dataset.notification) { await api('/notifications/retry','POST',{id:button.dataset.notification}); await refresh(); showNotice('已重新加入发送队列。'); }
    else if (button.hasAttribute('data-download')) {
      const response = await fetch(`/api/tasks/${currentTask.id}/patch`,{headers:{authorization:`Bearer ${sessionStorage.getItem('agent-admin-token')}`}});
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href=url; a.download=`task-${currentTask.id}.patch`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    } else if (button.dataset.archive) { await api(`/improvements/${button.dataset.archive}/archive`,'POST',{}); await refresh(); showNotice('经验已停用，后续新任务不再使用。'); }
    else if (button.dataset.evaluate) { await api(`/improvements/${button.dataset.evaluate}/evaluate`,'POST',{}); await refresh(); showNotice('已开始独立评估，可在此查看进度，评估期间仍可处理日常需求。'); }
    else if (button.dataset.promote) { await api(`/improvements/${button.dataset.promote}/promote`,'POST',{jobId:button.dataset.job}); await refresh(); showNotice('经验已启用，仅用于已验证引擎的新任务。'); }
    else if (button.dataset.stopEvaluation) { await api(`/evaluations/${button.dataset.stopEvaluation}/cancel`,'POST',{}); await refresh(); showNotice('已请求停止评估，原始试验会保留。'); }
    else if (button.dataset.report) { const report = await api(`/evaluations/${button.dataset.report}`); document.querySelector('#report-content').textContent = JSON.stringify(report,null,2); document.querySelector('#report-dialog').showModal(); }
    else if (button.id === 'close-report') document.querySelector('#report-dialog').close();
  });
});
document.addEventListener('input',event => {
  if (event.target.closest('#settings-form,#candidate-form') || event.target.id === 'task-feedback') { dirty = true; const marker = document.querySelector('#save-state'); if (marker) marker.textContent = '有未保存的修改'; }
  if (event.target.id === 'task-search') { search=event.target.value; const start=event.target.selectionStart; renderTasks(true); const input=document.querySelector('#task-search'); input.focus(); if (start !== null) input.setSelectionRange(start,start); }
});
document.addEventListener('change',event => {
  if (event.target.id === 'task-filter') { statusFilter=event.target.value; renderTasks(true); }
  if (event.target.id === 'project-filter') { projectFilter=event.target.value; renderTasks(true); }
  if (event.target.dataset.modelEngine === 'codex') { const i=event.target.dataset.projectIndex; const effort=document.getElementById(`project-${i}-codex-effort`); const current=effort.value; effort.innerHTML=effortOptions('codex',undefined,event.target.value); if ([...effort.options].some(o => o.value === current)) effort.value=current; }
  if (event.target.closest('#settings-form')) { dirty=true; document.querySelector('#save-state').textContent='有未保存的修改'; }
});
document.addEventListener('submit',event => {
  event.preventDefault(); const form=event.target;
  void busy(form.querySelector('[type=submit]'),async () => {
    const data=new FormData(form); const value=name=>String(data.get(name)||'').trim(); const lines=name=>value(name).split(/[\n,，]/).map(x=>x.trim()).filter(Boolean);
    if (form.id === 'candidate-form') { await api('/improvements','POST',{taskId:currentTask.id,content:value('content')}); dirty=false; form.reset(); showNotice('已保存为经验候选，可在“经验与成长”中评估。'); return; }
    if (form.id !== 'settings-form') return;
    const config=structuredClone(settings.config);
    config.profile={name:value('profile-name'),role:value('profile-role'),style:value('profile-style'),preferences:value('profile-preferences')};
    config.notifications={groupMode:value('group-mode')}; config.maxIterations=Number(value('max-iterations')); config.runTimeoutMs=Number(value('run-timeout'))*1000;
    config.projects.forEach((p,i)=>{
      p.engine=value(`project-${i}-engine`); p.models={}; p.efforts={};
      for (const engine of ['codex','claude']) { const model=value(`project-${i}-${engine}-model`),effort=value(`project-${i}-${engine}-effort`); if(model)p.models[engine]=model;if(effort)p.efforts[engine]=effort; }
      p.authentication={...p.authentication,codex:value(`project-${i}-auth`)};
      p.name=value(`project-${i}-name`); p.repository=value(`project-${i}-repository`); p.requesterIds=lines(`project-${i}-requesters`); p.ownerIds=lines(`project-${i}-owners`); p.chatIds=lines(`project-${i}-chats`); p.sensitivePaths=lines(`project-${i}-sensitive`);
      p.autoEvaluate=data.get(`project-${i}-auto-evaluate`)==='on';
      const manifest=value(`project-${i}-manifest`); if(manifest)p.evaluationManifest=manifest;else delete p.evaluationManifest;
      try { p.checks=JSON.parse(value(`project-${i}-checks`));p.setup=JSON.parse(value(`project-${i}-setup`)); } catch { throw new Error(`「${p.name}」的检查或准备命令不是有效 JSON，请展开高级设置修正。`); }
    });
    settings=await api('/settings','PUT',{config,revision:settings.revision});dirty=false;await refresh();showNotice('设置已保存。新的模型、推理级别与身份将用于之后的新需求。');
  });
});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
window.addEventListener('popstate',()=>{const query=new URLSearchParams(location.search);view=query.get('view')||'overview';taskId=query.get('task');dirty=false;void renderView().catch(error=>showNotice(error.message,true));});
setInterval(()=>{
  if(lastReceivedAt&&Date.now()-lastReceivedAt>20_000)markDisconnected();
  if(loading)return;
  const editing=dirty||view==='settings'||document.querySelector('dialog[open]')||document.activeElement?.matches('input,select,textarea');
  const focusedTask=document.activeElement?.closest('[data-task]')?.dataset.task;
  const focusedLane=document.activeElement?.dataset.lane;
  void refresh(!editing).then(()=>{
    if(focusedTask)document.querySelector(`[data-task="${CSS.escape(focusedTask)}"]`)?.focus({preventScroll:true});
    if(focusedLane)document.querySelector(`[data-lane="${CSS.escape(focusedLane)}"]`)?.focus({preventScroll:true});
  });
},10000);
void refresh();
