import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { CodexClient } from './codex-client.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { ProjectStore, resolveProjectDirectory } from './projects.mjs';
export { within } from './projects.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
export function validOrigin(request, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(request.headers.host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin && !hosts.some(host => origin === `http://${host}`)) return false;
  if (request.method === 'POST' && !origin) return false;
  return true;
}

export async function createStudio({ root, dataDir = path.join(directory, 'runtime'), port = 4317, client = new CodexClient() } = {}) {
  // Preserve the original workspace when upgrading an installation with legacy reports.
  const reportsDir = path.join(dataDir, 'reports');
  if (!root) {
    let legacy = false;
    try { legacy = (await readdir(reportsDir)).some(name => name.endsWith('.json')); } catch { /* New installation. */ }
    root = legacy ? path.resolve(directory, '..') : directory;
  }
  const projects = await new ProjectStore(path.join(dataDir, 'projects.json')).load(root);
  const engine = new Orchestrator(client, reportsDir);
  const streams = new Set();
  let connection = { connected: false, loggedIn: false, error: null, models: [] };
  let loading = null;
  async function connect() {
    if (loading) return loading;
    loading = (async () => {
      try {
        await client.connect();
        const [account, catalog] = await Promise.all([client.request('account/read', { refreshToken: false }), client.request('model/list', { includeHidden: false })]);
        connection = { connected: true, loggedIn: Boolean(account.account) || account.requiresOpenaiAuth === false, error: null, models: catalog.data.filter(m => !m.hidden).map(m => ({ id: m.model || m.id, name: m.displayName, isDefault: m.isDefault })) };
      } catch (error) { connection = { connected: false, loggedIn: false, error: error.message, models: [] }; }
      finally { loading = null; }
      broadcast('connection', connection);
      return connection;
    })();
    return loading;
  }
  client.on('disconnected', error => { connection.connected = false; connection.error = error.message; broadcast('connection', connection); });
  function broadcast(event, value) {
    for (const stream of streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  const timers = new Map();
  engine.on('update', run => {
    clearTimeout(timers.get(run.id));
    if (['running', 'stopping'].includes(run.status)) timers.set(run.id, setTimeout(() => broadcast('run', engine.publicRun(engine.runs.get(run.id))), 80));
    else broadcast('run', run);
  });
  try {
    const reports = reportsDir;
    const candidates = (await readdir(reports, { recursive: true })).filter(n => n.endsWith('.json'));
    const ordered = await Promise.all(candidates.map(async name => ({ name, time: (await stat(path.join(reports, name))).mtimeMs })));
    for (const { name } of ordered.sort((a, b) => a.time - b.time).slice(-200)) {
      try {
        const run = JSON.parse(await readFile(path.join(reports, name), 'utf8'));
        if (!run.id || !Array.isArray(run.agents) || !run.cwd) continue;
        if (!run.projectId) {
          // Old records may use Windows short names or a link alias for the same folder.
          let canonical = run.cwd;
          try { canonical = await realpath(run.cwd); } catch { /* Retain histories for missing directories. */ }
          run.projectId = projects.match(canonical)?.id || null;
        }
        if (['running', 'stopping'].includes(run.status)) run.status = 'stopped';
        engine.runs.set(run.id, run);
      } catch { /* Skip invalid report files. */ }
    }
  } catch { /* No report history yet. */ }
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const effectivePort = server.address()?.port || port;
      if (!validOrigin(req, effectivePort)) return json(403, { error: '仅允许从本机工作台访问。' });
      const url = new URL(req.url, `http://127.0.0.1:${effectivePort}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { projects: projects.list(), connection, runs: [...engine.runs.values()].map(r => engine.publicRun(r)) });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': connected\n\n'); streams.add(res);
        const keepalive = setInterval(() => res.write(': heartbeat\n\n'), 20000);
        req.on('close', () => { clearInterval(keepalive); streams.delete(res); });
        return;
      }
      if (req.method === 'GET' && /^\/api\/runs\/[a-f0-9-]+\/report$/.test(url.pathname)) {
        const run = engine.runs.get(url.pathname.split('/')[3]);
        if (!run) return json(404, { error: '报告不存在。' });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="agent-report-${run.id}.md"` });
        return res.end(engine.report(run));
      }
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '需要 JSON 请求。' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 20000) return json(413, { error: '输入过长。' }); }
        const input = JSON.parse(body || '{}');
        if (url.pathname === '/api/connect') return json(200, await connect());
        if (url.pathname === '/api/projects') {
          const project = await projects.add(input);
          broadcast('projects', projects.list());
          return json(201, project);
        }
        if (/^\/api\/projects\/[a-f0-9]+\/remove$/.test(url.pathname)) {
          const id = url.pathname.split('/')[3];
          if ([...engine.runs.values()].some(run => run.projectId === id && ['running', 'stopping'].includes(run.status))) return json(409, { error: '该项目还有任务运行，请先等待或停止任务。' });
          await projects.remove(id);
          broadcast('projects', projects.list());
          return json(200, { removed: id });
        }
        if (url.pathname === '/api/runs') {
          if (!connection.connected || !connection.loggedIn) return json(503, { error: 'Codex 尚未连接或未登录。请先在终端运行 codex login，再点击重新连接。' });
          if (typeof input.goal !== 'string' || input.goal.trim().length < 5 || input.goal.length > 8000) return json(400, { error: '请输入 5–8000 字的具体目标。' });
          if (!['read', 'write'].includes(input.mode)) return json(400, { error: '执行模式无效。' });
          if (!connection.models.some(m => m.id === input.model)) return json(400, { error: '请选择当前可用模型。' });
          const project = projects.get(input.projectId);
          if (!project) return json(400, { error: '请先添加并选择项目。' });
          const cwd = await resolveProjectDirectory(project, input.cwd || project.root);
          return json(201, engine.start({ goal: input.goal.trim(), cwd, model: input.model, mode: input.mode, projectId: project.id, projectName: project.name }));
        }
        if (/^\/api\/runs\/[a-f0-9-]+\/stop$/.test(url.pathname)) return json(200, await engine.stop(url.pathname.split('/')[3]));
        return json(404, { error: '接口不存在。' });
      }
      if (req.method !== 'GET') return json(405, { error: '不支持此方法。' });
      const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
      const filename = files[url.pathname];
      if (!filename) return json(404, { error: '页面不存在。' });
      const content = await readFile(path.join(directory, 'dist', filename));
      res.writeHead(200, { 'Content-Type': filename.endsWith('.css') ? 'text/css; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" });
      res.end(content);
    } catch (error) { json(400, { error: error.message }); }
  });
  return { server, engine, projects, connect, close: () => { for (const timer of timers.values()) clearTimeout(timer); for (const stream of streams) stream.end(); client.close(); server.close(); }, port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4317;
  const openBrowser = () => {
    if (process.platform === 'win32') spawn('cmd.exe', ['/d', '/c', 'start', '""', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: 'ignore' }).on('error', error => console.error(`请手动打开工作台：${error.message}`));
  };
  if (process.argv.includes('--open')) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
      const state = await response.json();
      if (response.ok && state.connection && Array.isArray(state.runs)) { openBrowser(); console.log('工作台已在运行，已打开浏览器。'); process.exit(0); }
    } catch { /* Start the local service when no existing studio is listening. */ }
  }
  const studio = await createStudio({ port });
  studio.server.on('error', error => { console.error(`启动失败：${error.message}`); studio.close(); process.exitCode = 1; });
  studio.server.listen(studio.port, '127.0.0.1', () => {
    console.log(`Agent 工作台：http://127.0.0.1:${studio.port}`);
    if (process.argv.includes('--open')) openBrowser();
    studio.connect().then(state => console.log(state.connected ? `Codex 已连接；登录状态：${state.loggedIn ? '已登录' : '未登录'}` : `Codex 连接失败：${state.error}`));
  });
  process.on('SIGINT', () => { studio.close(); process.exit(0); });
  process.on('SIGTERM', () => { studio.close(); process.exit(0); });
}
