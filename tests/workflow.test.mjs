import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../orchestrator.mjs';
import { within, validOrigin } from '../server.mjs';

class FakeCodex extends EventEmitter {
  constructor({ fail = false, manual = false } = {}) { super(); this.calls = []; this.count = 0; this.fail = fail; this.manual = manual; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: `thread-${++this.count}` } };
    if (method === 'turn/start') {
      const id = `turn-${params.threadId}`;
      if (!this.manual) setTimeout(() => {
        this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: params.threadId, delta: '中间说明\n' } });
        this.emit('notification', { method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', text: `最终结果 ${params.threadId}` } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id, status: this.fail && params.threadId === 'thread-1' ? 'failed' : 'completed', error: this.fail ? { message: '测试失败' } : null } } });
      }, 10);
      return { turn: { id } };
    }
    if (method === 'turn/interrupt') {
      setImmediate(() => this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'interrupted' } } }));
      return {};
    }
    throw new Error('Unexpected method');
  }
}
async function makeEngine(options) { return new Orchestrator(new FakeCodex(options), await mkdtemp(path.join(tmpdir(), 'agent-studio-test-'))); }
async function terminal(engine) {
  while ([...engine.runs.values()].some(r => ['running', 'stopping'].includes(r.status))) await once(engine, 'update');
  return [...engine.runs.values()][0];
}
const input = { goal: '测试目标', cwd: process.cwd(), model: 'test-model', mode: 'read' };

test('并行探索和规划之后才审查，交接使用最终消息', async () => {
  const engine = await makeEngine();
  engine.start(input);
  const run = await terminal(engine);
  assert.equal(run.status, 'completed');
  assert.equal(run.agents[2].status, 'skipped');
  const turns = engine.client.calls.filter(c => c.method === 'turn/start');
  assert.equal(turns.length, 3);
  assert.match(turns[2].params.input[0].text, /最终结果 thread-1/);
  assert.doesNotMatch(turns[2].params.input[0].text, /中间说明/);
  assert.deepEqual(turns.map(t => t.params.sandboxPolicy.type), ['readOnly', 'readOnly', 'readOnly']);
  await engine.persist(run);
  assert.match(await readFile(path.join(engine.reportDir, `${run.id}.md`), 'utf8'), /最终结果/);
});
test('实施模式仅执行阶段获得项目写入权限', async () => {
  const engine = await makeEngine(); engine.start({ ...input, mode: 'write' });
  const run = await terminal(engine); assert.equal(run.status, 'completed');
  const turns = engine.client.calls.filter(c => c.method === 'turn/start');
  assert.equal(turns.length, 4);
  assert.deepEqual(turns[2].params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [input.cwd], networkAccess: false });
  assert.equal(turns[3].params.sandboxPolicy.type, 'readOnly');
});
test('前置任务失败会阻止后续阶段', async () => {
  const engine = await makeEngine({ fail: true }); engine.start(input);
  const run = await terminal(engine); assert.equal(run.status, 'failed');
  assert.equal(engine.client.calls.filter(c => c.method === 'turn/start').length, 2);
});
test('停止向两个活动 Agent 发出中断且不启动审查', async () => {
  const engine = await makeEngine({ manual: true }); const run = engine.start(input);
  while ([...engine.runs.values()][0].agents.slice(0, 2).some(a => !a.turnId)) await once(engine, 'update');
  assert.throws(() => engine.start(input), /已有任务/);
  await engine.stop(run.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.runs.get(run.id).status, 'stopped');
  assert.equal(engine.client.calls.filter(c => c.method === 'turn/interrupt').length, 2);
  assert.equal(engine.client.calls.filter(c => c.method === 'turn/start').length, 2);
});
test('同源本机访问允许，跨站请求和伪造 Host 拒绝', () => {
  assert.equal(validOrigin({ method: 'POST', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } }, 4317), true);
  assert.equal(validOrigin({ method: 'POST', headers: { host: '127.0.0.1:4317', origin: 'https://example.com' } }, 4317), false);
  assert.equal(validOrigin({ method: 'POST', headers: { host: '127.0.0.1:4317' } }, 4317), false);
  assert.equal(validOrigin({ method: 'GET', headers: { host: 'evil.test:4317' } }, 4317), false);
  assert.equal(validOrigin({ method: 'GET', headers: { host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site' } }, 4317), false);
});
test('项目路径限制拒绝父目录和相似前缀目录', () => {
  const root = path.resolve('workspace');
  assert.equal(within(root, path.join(root, 'project')), true);
  assert.equal(within(root, root), true);
  assert.equal(within(root, path.resolve(root, '..')), false);
  assert.equal(within(root, root + '-other'), false);
});
