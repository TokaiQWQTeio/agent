import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';

export async function installSkill({ parent = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills'), update = false } = {}) {
  const name = 'multi-agent-workflow';
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', name);
  const target = path.join(path.resolve(parent), name);
  if (target === source) throw new Error('安装目录不能等于仓库内的 Skill 源码目录。');
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('安装位置已有非普通目录，请指定其他目录。');
    if (!update) throw new Error('Skill 已存在。更新请显式使用 --update。');
    const existing = await readFile(path.join(target, 'SKILL.md'), 'utf8');
    if (!/^name: multi-agent-workflow$/m.test(existing)) throw new Error('安装位置属于其他 Skill，停止更新。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const copy = async (from, to) => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Skill 源码包含未支持的链接。');
      const input = path.join(from, entry.name), output = path.join(to, entry.name);
      if (entry.isDirectory()) await copy(input, output);
      else if (entry.isFile()) await writeFile(output, await readFile(input));
    }
  };
  await copy(source, target);
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let parent, update = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--destination' && args[i + 1]) parent = args[++i];
    else if (args[i] === '--update') update = true;
    else throw new Error(`不支持的参数：${args[i]}`);
  }
  console.log(`个人 Skill 已安装：${await installSkill({ parent, update })}`);
  console.log('在其他项目中使用 $multi-agent-workflow；未出现时重新打开 Codex。');
}
