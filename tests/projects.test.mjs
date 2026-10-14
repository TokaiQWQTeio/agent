import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { ProjectStore, validateProjectRoot, resolveProjectDirectory } from '../projects.mjs';
import { createStudio } from '../server.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-projects-'));
  const first = path.join(root, 'project-a'), second = path.join(root, 'project-b');
  await Promise.all([mkdir(first), mkdir(second)]);
  return { root, first, second, data: path.join(root, 'data') };
}
test('跨项目注册、去重、重启保留；移出列表不删除文件', async () => {
  const f = await fixture();
  const filename = path.join(f.data, 'projects.json');
  const store = await new ProjectStore(filename).load(f.first);
  const first = store.list()[0];
  const second = await store.add({ name: '另一个项目', root: f.second });
  assert.equal(store.list().length, 2);
  assert.equal((await store.add({ root: path.join(f.second, '.') })).id, second.id);
  const reloaded = await new ProjectStore(filename).load(f.first);
  assert.deepEqual(reloaded.list(), store.list());
  await writeFile(path.join(f.second, 'user.txt'), 'preserve');
  await reloaded.remove(second.id);
  assert.equal(await readFile(path.join(f.second, 'user.txt'), 'utf8'), 'preserve');
  assert.equal((await reloaded.add({ root: f.second })).id, second.id);
  assert.equal(reloaded.get(first.id).root, first.root);
});
test('并发添加两个项目不会丢失注册信息', async () => {
  const f = await fixture(), third = path.join(f.root, 'project-c'); await mkdir(third);
  const store = await new ProjectStore(path.join(f.data, 'projects.json')).load(f.first);
  await Promise.all([store.add({ root: f.second }), store.add({ root: third })]);
  assert.equal(store.list().length, 3);
  const disk = JSON.parse(await readFile(store.filename, 'utf8'));
  assert.equal(disk.projects.length, 3);
});
test('任务不能越过已选择的项目或进入内部配置目录', async () => {
  const f = await fixture();
  const project = { root: await validateProjectRoot(f.first) };
  const child = path.join(f.first, 'src'); await mkdir(child);
  assert.equal(await resolveProjectDirectory(project, child), await validateProjectRoot(child));
  await assert.rejects(resolveProjectDirectory(project, f.second), /所选项目/);
  const privateDir = path.join(f.first, '.git'); await mkdir(privateDir);
  await assert.rejects(resolveProjectDirectory(project, privateDir), /配置目录/);
  await assert.rejects(validateProjectRoot(privateDir), /内部目录/);
  await assert.rejects(validateProjectRoot(path.parse(f.first).root), /磁盘根目录/);
});
test('链接到项目外的子目录不能扩大任务目录范围', async t => {
  const f = await fixture();
  const link = path.join(f.first, 'outside');
  try { await symlink(f.second, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('环境不允许创建测试链接'); return; } throw error; }
  await assert.rejects(resolveProjectDirectory({ root: await validateProjectRoot(f.first) }, link), /所选项目/);
});
class LocalClient extends EventEmitter {
  seq = 0;
  async connect() {}
  close() {}
  async request(method, params) {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ model: 'test', displayName: 'Test', isDefault: true }] };
    if (method === 'thread/start') return { thread: { id: `thread-${++this.seq}` } };
    if (method === 'turn/start') {
      const turn = { id: `turn-${params.threadId}`, status: 'inProgress' };
      setTimeout(() => {
        this.emit('notification', { method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', text: '项目独立结果' } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { ...turn, status: 'completed' } } });
      }, 10);
      return { turn };
    }
    throw new Error(`Unexpected method ${method}`);
  }
}
test('HTTP 注册外部项目、任务目录限制、报告按项目隔离及旧历史迁移', async t => {
  const f = await fixture();
  await mkdir(path.join(f.data, 'reports'), { recursive: true });
  await writeFile(path.join(f.data, 'reports', 'legacy.json'), JSON.stringify({ id: 'legacy', cwd: f.first, status: 'completed', agents: [], logs: [], createdAt: '2026-01-01T00:00:00Z' }));
  const studio = await createStudio({ root: f.first, dataDir: f.data, port: 0, client: new LocalClient() });
  t.after(() => studio.close());
  studio.server.listen(0, '127.0.0.1'); await once(studio.server, 'listening'); await studio.connect();
  const origin = `http://127.0.0.1:${studio.server.address().port}`;
  const post = (route, input) => fetch(origin + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const initial = await (await fetch(origin + '/api/state')).json();
  assert.equal(initial.runs[0].projectId, initial.projects[0].id);
  const response = await post('/api/projects', { root: f.second, name: '项目 B' });
  assert.equal(response.status, 201); const project = await response.json();
  const bad = await post('/api/runs', { projectId: project.id, cwd: f.first, mode: 'read', model: 'test', goal: '检查项目结构' });
  assert.equal(bad.status, 400);
  const start = await post('/api/runs', { projectId: project.id, cwd: f.second, mode: 'read', model: 'test', goal: '检查项目结构' });
  assert.equal(start.status, 201); const run = await start.json();
  const removal = await post(`/api/projects/${project.id}/remove`, {});
  assert.equal(removal.status, 409);
  while (studio.engine.runs.get(run.id).status === 'running') await once(studio.engine, 'update');
  await studio.engine.persist(studio.engine.runs.get(run.id));
  const report = path.join(f.data, 'reports', project.id, `${run.id}.md`);
  assert.match(await readFile(report, 'utf8'), /项目 B/);
  assert.ok((await stat(path.join(f.data, 'reports', 'legacy.json'))).isFile());
  const crossSite = await fetch(origin + '/api/projects', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossSite.status, 403);
});
