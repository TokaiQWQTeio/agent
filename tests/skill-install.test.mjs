import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installSkill } from '../scripts/install-skill.mjs';

test('Skill 安装到指定目录，重复安装不覆盖，显式更新保留用户额外文件', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-skill-'));
  const target = await installSkill({ parent });
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /name: multi-agent-workflow/);
  await assert.rejects(installSkill({ parent }), /已存在/);
  await writeFile(path.join(target, 'personal.txt'), 'keep');
  await installSkill({ parent, update: true });
  assert.equal(await readFile(path.join(target, 'personal.txt'), 'utf8'), 'keep');
});
test('Skill 更新不能覆盖其他 Skill', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-skill-'));
  const target = path.join(parent, 'multi-agent-workflow'); await mkdir(target);
  await writeFile(path.join(target, 'SKILL.md'), '---\nname: another-skill\n---');
  await assert.rejects(installSkill({ parent, update: true }), /其他 Skill/);
});
