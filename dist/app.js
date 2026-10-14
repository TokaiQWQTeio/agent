const $ = selector => document.querySelector(selector);
const statusNames = { waiting: '等待', starting: '启动中', running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止', stopping: '停止中', skipped: '已跳过' };
const names = { explorer: '分析 Agent', planner: '规划 Agent', builder: '执行 Agent', reviewer: '审查 Agent' };
let connection = { connected: false, loggedIn: false, models: [] }, runs = new Map(), currentId = null, selectedAgent = 'explorer', source, busy = false, submitting = false;
let projects = [], activeProjectId = null;
const drafts = new Map();
const readPreference = key => { try { return localStorage.getItem(key); } catch { return null; } };
const savePreference = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } };
const projectRuns = () => [...runs.values()].filter(run => run.projectId === activeProjectId);
function selectProject(id) {
  if (activeProjectId) drafts.set(activeProjectId, { goal: $('#goal').value, cwd: $('#cwd').value });
  activeProjectId = id;
  const project = projects.find(p => p.id === id);
  if (id) savePreference('agent-studio-project', id);
  $('#project-select').value = id || '';
  $('#project-title').textContent = project?.name || '项目工作台';
  const draft = drafts.get(id);
  $('#goal').value = draft?.goal || '';
  $('#cwd').value = draft?.cwd || project?.root || '';
  setMode(readPreference(`agent-studio-mode-${id}`) || 'read', false);
  const model = readPreference(`agent-studio-model-${id}`);
  const defaultModel = connection.models.find(m => m.isDefault) || connection.models[0];
  if (connection.models.some(m => m.id === model)) $('#model').value = model;
  else if (defaultModel) $('#model').value = defaultModel.id;
  currentId = projectRuns().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.id || null;
  selectedAgent = 'explorer';
  render();
}
function renderProjects(list, preferredId = activeProjectId) {
  projects = list;
  $('#project-select').replaceChildren();
  if (!projects.length) $('#project-select').append(new Option('先添加一个本机项目', ''));
  for (const project of projects) $('#project-select').append(new Option(project.name, project.id));
  const id = projects.some(p => p.id === preferredId) ? preferredId : projects[0]?.id || null;
  if (activeProjectId !== id || !$('#cwd').value) selectProject(id);
  else { $('#project-select').value = id; render(); }
  $('#remove-project').disabled = !id;
}
function setMode(mode, remember = true) {
  if (!['read', 'write'].includes(mode)) return;
  document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
  if (remember && activeProjectId) savePreference(`agent-studio-mode-${activeProjectId}`, mode);
  renderMode();
}
function renderMode() {
  const write = $('input[name=mode]:checked').value === 'write';
  $('#start').replaceChildren(document.createTextNode(write ? '启动完整流程 ' : '启动只读分析 '));
  const arrow = document.createElement('span'); arrow.textContent = '↗'; $('#start').append(arrow);
  $('#mode-help').textContent = write ? '完整流程会运行执行 Agent，并允许修改所选项目目录内的文件。' : '当前只读模式：执行 Agent 不会运行。制作网站请选择完整流程。';
  $('#mode-help').classList.toggle('write', write);
}
function fillFromRun(run, mode = run.mode) {
  if (run.projectId !== activeProjectId) selectProject(run.projectId);
  $('#goal').value = run.goal;
  $('#cwd').value = run.cwd;
  if (connection.models.some(m => m.id === run.model)) $('#model').value = run.model;
  setMode(mode);
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 6000); }
async function api(endpoint, body) {
  const response = await fetch(endpoint, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('本机服务尚未启动。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function renderConnection(value) {
  connection = value;
  $('#connection-dot').classList.toggle('connected', value.connected && value.loggedIn);
  $('#connection-text').textContent = value.connected ? (value.loggedIn ? 'Codex 已连接' : 'Codex 未登录') : 'Codex 未连接';
  const previous = $('#model').value || readPreference(`agent-studio-model-${activeProjectId}`);
  $('#model').replaceChildren();
  if (!value.models?.length) $('#model').append(new Option('连接后读取可用模型', ''));
  else for (const model of value.models) $('#model').append(new Option(model.name || model.id, model.id));
  if (value.models?.some(m => m.id === previous)) $('#model').value = previous;
  else { const defaultModel = value.models?.find(m => m.isDefault); if (defaultModel) $('#model').value = defaultModel.id; }
  $('#offline').hidden = value.connected && value.loggedIn;
  if (value.error) $('#offline-message').textContent = value.error;
  else if (value.connected && !value.loggedIn) $('#offline-message').textContent = '请在本机终端运行 codex login 完成登录，再点击重新连接。';
  updateControls();
}
function updateControls() {
  busy = [...runs.values()].some(r => ['running', 'stopping'].includes(r.status));
  $('#start').disabled = submitting || busy || !activeProjectId || !connection.connected || !connection.loggedIn;
  $('#stop').hidden = !busy;
  $('#stop').disabled = [...runs.values()].some(r => r.status === 'stopping');
  const activeRun = [...runs.values()].find(r => ['running', 'stopping'].includes(r.status));
  $('#stop').textContent = activeRun ? `停止任务：${activeRun.projectName || '运行中的项目'}` : '停止当前任务';
  const run = runs.get(currentId);
  $('#rerun-write').disabled = submitting || busy || !connection.connected || !connection.loggedIn || !connection.models.some(m => m.id === run?.model);
}
function tab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) button.classList.toggle('selected', button.dataset.tab === name);
  for (const view of ['output', 'logs', 'history']) $(`#${view}-view`).hidden = view !== name;
}
function upsert(run) {
  runs.set(run.id, run);
  if (!currentId && run.projectId === activeProjectId) currentId = run.id;
  render();
}
function render() {
  updateControls();
  const run = runs.get(currentId);
  const mode = run?.mode || $('input[name=mode]:checked').value;
  const analysisOnly = mode === 'read';
  const skipped = run?.agents.find(a => a.id === 'builder')?.status === 'skipped';
  $('#active-goal').hidden = !run;
  $('#active-goal').textContent = run ? run.goal : '';
  $('#run-status').textContent = run ? statusNames[run.status] : '等待任务';
  $('#run-status').className = `status-pill ${run?.status || ''}`;
  $('#run-mode').hidden = !run;
  $('#run-mode').textContent = analysisOnly ? '本次任务：只读分析 · 执行 Agent 不运行' : '本次任务：完整流程 · 包含文件实施';
  $('#progress').textContent = `${run?.agents.filter(a => a.status === 'completed' && (!analysisOnly || a.id !== 'builder')).length || 0} / ${analysisOnly ? 3 : 4} 阶段`;
  $('#builder-detail').textContent = analysisOnly ? '只读模式：不实施、不修改文件' : '实施修改 · 运行验证';
  $('#execution-skipped').hidden = !skipped;
  $('#handoff-label').textContent = analysisOnly ? '交接分析与规划（无实施结果）' : '交付实际结果';
  for (const card of document.querySelectorAll('[data-agent]')) {
    const agent = run?.agents.find(a => a.id === card.dataset.agent);
    card.className = `agent-card ${card.dataset.agent === 'builder' || card.dataset.agent === 'reviewer' ? 'wide' : ''} ${agent?.status || ''} ${selectedAgent === card.dataset.agent ? 'selected' : ''}`;
    card.querySelector('.agent-state').textContent = agent?.status === 'skipped' && card.dataset.agent === 'builder' ? '只读模式 · 已跳过' : statusNames[agent?.status || 'waiting'];
    const detail = card.querySelector('.card-detail');
    if (detail) detail.textContent = agent?.threadId ? '真实 Codex 会话' : '等待目标';
  }
  const agent = run?.agents.find(a => a.id === selectedAgent);
  $('#selected-name').textContent = names[selectedAgent];
  $('#selected-status').textContent = statusNames[agent?.status || 'waiting'];
  $('#thread-id').textContent = agent?.threadId ? `THREAD / ${agent.threadId}` : '';
  const view = $('#output-view');
  const follow = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
  $('#agent-output').textContent = agent ? (agent.output || agent.finalOutput || agent.error || (agent.status === 'skipped' ? '分析模式已跳过此阶段，不修改文件。' : '等待 Agent 返回输出…')) : '从左侧输入目标并启动协作。\n\n这里将显示真实 Agent 的输出，结果会自动交给后续 Agent。';
  if (follow) view.scrollTop = view.scrollHeight;
  $('#logs').replaceChildren();
  if (!run?.logs.length) $('#logs').textContent = '任务开始后，事件将在这里出现。';
  else for (const log of [...run.logs].reverse()) {
    const row = document.createElement('div'); row.className = 'log';
    const time = document.createElement('time'); time.textContent = `${new Date(log.time).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${names[log.agent] || '调度器'}`;
    row.append(time, document.createTextNode(log.text)); $('#logs').append(row);
  }
  $('#history').replaceChildren();
  if (!projectRuns().length) $('#history').textContent = '当前项目还没有运行记录。';
  else for (const entry of projectRuns().sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const button = document.createElement('button'); button.textContent = entry.goal.slice(0, 85);
    const meta = document.createElement('small'); meta.textContent = `${statusNames[entry.status]} · ${new Date(entry.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    meta.textContent += entry.mode === 'write' ? ' · 完整流程' : ' · 只读分析';
    button.append(meta); button.addEventListener('click', () => { currentId = entry.id; fillFromRun(entry); render(); tab('output'); });
    $('#history').append(button);
  }
  $('#download').disabled = !run;
  $('#report-note').textContent = run?.status === 'completed' ? (analysisOnly ? '分析已完成 · 未执行文件修改' : '完整流程已完成 · 报告已保存') : run ? '可随时下载当前结果' : '完成后可下载本地报告';
}
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || submitting) return;
  submitting = true; updateControls();
  try {
    const run = await api('/api/runs', { goal: $('#goal').value, cwd: $('#cwd').value, model: $('#model').value, mode: $('input[name=mode]:checked').value, projectId: activeProjectId });
    currentId = run.id; selectedAgent = 'explorer'; upsert(run); tab('output'); toast('真实 Agent 协作已启动。');
  } catch (error) { toast(error.message); }
  finally { submitting = false; updateControls(); }
});
$('#stop').addEventListener('click', async () => {
  const active = [...runs.values()].find(r => r.status === 'running'); if (!active) return;
  $('#stop').disabled = true;
  try { upsert(await api(`/api/runs/${active.id}/stop`, {})); toast('已请求停止任务。'); } catch (error) { toast(error.message); } finally { updateControls(); }
});
$('#reconnect').addEventListener('click', async () => { try { renderConnection(await api('/api/connect', {})); } catch (error) { toast(error.message); } });
$('#project-select').addEventListener('change', event => selectProject(event.target.value));
$('#model').addEventListener('change', () => { if (activeProjectId) savePreference(`agent-studio-model-${activeProjectId}`, $('#model').value); });
$('#add-project').addEventListener('click', () => $('#project-dialog').showModal());
$('#cancel-project').addEventListener('click', () => $('#project-dialog').close());
$('#project-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#save-project').disabled = true;
  try {
    const project = await api('/api/projects', { name: $('#new-project-name').value, root: $('#new-project-root').value.trim() });
    const state = await api('/api/state');
    renderProjects(state.projects, project.id);
    $('#project-dialog').close(); $('#project-form').reset(); toast(`已切换到项目：${project.name}`);
  } catch (error) { toast(error.message); }
  finally { $('#save-project').disabled = false; }
});
$('#remove-project').addEventListener('click', async () => {
  if (!activeProjectId) return;
  try { await api(`/api/projects/${activeProjectId}/remove`, {}); const state = await api('/api/state'); renderProjects(state.projects); toast('已移出项目列表，项目文件和报告仍保留。'); }
  catch (error) { toast(error.message); }
});
document.querySelectorAll('input[name=mode]').forEach(input => input.addEventListener('change', () => { setMode(input.value); render(); }));
$('#rerun-write').addEventListener('click', () => {
  const run = runs.get(currentId);
  if (!run || busy || submitting) return;
  fillFromRun(run, 'write');
  $('#task-form').requestSubmit();
});
$('#download').addEventListener('click', () => { if (currentId) window.location.href = `/api/runs/${currentId}/report`; });
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => { $('#goal').value = button.dataset.example; $('#goal').focus(); }));
document.querySelectorAll('[data-agent]').forEach(button => button.addEventListener('click', () => { selectedAgent = button.dataset.agent; render(); tab('output'); }));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
$('#nav-history').addEventListener('click', () => { tab('history'); $('.inspector').scrollIntoView({ behavior: 'smooth' }); });
$('#nav-work').addEventListener('click', () => { tab('output'); $('.brief').scrollIntoView({ behavior: 'smooth' }); });
async function bootstrap() {
  renderMode();
  try {
    const state = await api('/api/state');
    state.runs.forEach(run => runs.set(run.id, run));
    // Migrate the previous single-project preference once to that project's key.
    const initialProject = state.projects[0];
    if (initialProject && !readPreference(`agent-studio-mode-${initialProject.id}`)) {
      const previous = readPreference('agent-studio-mode');
      if (['read', 'write'].includes(previous)) savePreference(`agent-studio-mode-${initialProject.id}`, previous);
    }
    renderConnection(state.connection);
    renderProjects(state.projects, readPreference('agent-studio-project'));
    source?.close(); source = new EventSource('/api/events');
    source.addEventListener('connection', event => renderConnection(JSON.parse(event.data)));
    source.addEventListener('run', event => upsert(JSON.parse(event.data)));
    source.addEventListener('projects', event => renderProjects(JSON.parse(event.data)));
    source.addEventListener('open', async () => {
      // Recover events lost while the browser was disconnected.
      try { const latest = await api('/api/state'); latest.runs.forEach(run => runs.set(run.id, run)); renderConnection(latest.connection); renderProjects(latest.projects); }
      catch (error) { toast(error.message); }
    });
    source.addEventListener('error', () => { $('#connection-text').textContent = '事件流断开 · 正在重连'; $('#connection-dot').classList.remove('connected'); $('#start').disabled = true; });
  } catch (error) {
    renderConnection({ connected: false, loggedIn: false, models: [] });
    $('#offline').hidden = false;
    $('#offline-message').textContent = '此页面无法访问本机调度服务。请启动本机服务，然后打开本机工作台；连接前不会产生任何模型调用。';
  }
}
bootstrap();
