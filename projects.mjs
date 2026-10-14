import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, mkdir, writeFile, rename } from 'node:fs/promises';

const privateDirectories = new Set(['.git', '.codex', '.agents', '.aws', '.ssh']);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
export function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function projectId(root) { return createHash('sha256').update(key(root)).digest('hex').slice(0, 20); }
export async function validateProjectRoot(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('请输入项目文件夹的绝对路径。');
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error('项目路径必须是已有文件夹。');
  if (key(root) === key(path.parse(root).root) || key(root) === key(os.homedir())) throw new Error('请选择具体项目文件夹，不能使用磁盘根目录或整个用户目录。');
  if (root.split(path.sep).some(segment => privateDirectories.has(segment.toLowerCase()))) throw new Error('不能将账号配置或 Git 内部目录注册为项目。');
  return root;
}
export async function resolveProjectDirectory(project, input = project.root) {
  const root = await realpath(project.root);
  if (key(root) !== key(project.root)) throw new Error('项目目录位置已改变，请重新添加项目。');
  const cwd = await realpath(input);
  if (!within(root, cwd) || !(await stat(cwd)).isDirectory()) throw new Error('任务目录必须位于所选项目内。');
  if (path.relative(root, cwd).split(path.sep).some(segment => privateDirectories.has(segment.toLowerCase()))) throw new Error('不能在项目内部配置目录中执行任务。');
  return cwd;
}

export class ProjectStore {
  constructor(filename) { this.filename = filename; this.projects = []; this.queue = Promise.resolve(); }
  async load(defaultRoot) {
    try {
      const data = JSON.parse(await readFile(this.filename, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error('项目配置文件格式无效。');
      this.projects = data.projects;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`无法加载项目配置：${error.message}`);
      const root = await validateProjectRoot(defaultRoot);
      this.projects = [{ id: projectId(root), name: path.basename(root), root, createdAt: new Date().toISOString() }];
      await this.save();
    }
    return this;
  }
  list() { return this.projects.map(project => ({ ...project })); }
  get(id) { return this.projects.find(project => project.id === id); }
  async save() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, projects: this.projects }, null, 2));
    await rename(temporary, this.filename);
  }
  mutate(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  async add({ root: input, name }) {
    const root = await validateProjectRoot(input);
    const label = typeof name === 'string' && name.trim() ? name.trim() : path.basename(root);
    if (label.length > 80) throw new Error('项目名称不能超过 80 字。');
    return this.mutate(async () => {
      const existing = this.projects.find(p => key(p.root) === key(root));
      if (existing) return { ...existing };
      const project = { id: projectId(root), name: label, root, createdAt: new Date().toISOString() };
      const previous = this.projects;
      this.projects = [...previous, project];
      try { await this.save(); } catch (error) { this.projects = previous; throw error; }
      return { ...project };
    });
  }
  async remove(id) {
    return this.mutate(async () => {
      if (!this.get(id)) throw new Error('项目不存在。');
      const previous = this.projects;
      this.projects = previous.filter(p => p.id !== id);
      try { await this.save(); } catch (error) { this.projects = previous; throw error; }
    });
  }
  match(cwd) { return this.projects.filter(p => within(p.root, cwd)).sort((a, b) => b.root.length - a.root.length)[0]; }
}
