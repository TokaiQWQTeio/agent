import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CodexClient extends EventEmitter {
  constructor(binary = process.env.CODEX_BIN || 'codex') {
    super();
    this.binary = binary;
    this.pending = new Map();
    this.seq = 0;
    this.ready = null;
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.initialize();
    return this.ready;
  }
  async initialize() {
    this.proc = spawn(this.binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.on('error', error => this.crash(error));
    this.proc.on('exit', code => this.crash(new Error(`Codex 服务退出 (${code})`)));
    this.proc.stdin.on('error', error => this.crash(error));
    createInterface({ input: this.proc.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        // This console never automatically grants requests outside the selected sandbox.
        this.send({ id: message.id, error: { code: -32601, message: '控制台不支持此次权限请求；请在 Codex 中处理。' } });
        this.emit('notification', { method: 'console/requestDenied', params: message.params });
      } else this.emit('notification', message);
    });
    // Stderr is deliberately not sent to the browser: it can include account/runtime details.
    this.proc.stderr.on('data', () => {});
    await this.request('initialize', { clientInfo: { name: 'local_agent_studio', title: 'Agent 协作工作台', version: '1.0.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  crash(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.ready = null;
    this.emit('disconnected', error);
  }
  send(message) {
    if (!this.proc?.stdin.writable) throw new Error('Codex 服务未连接');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 请求超时`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { this.proc?.kill(); }
}
