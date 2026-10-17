#!/usr/bin/env node
// agent-operate 업데이트: 이 맥에 agent-operate가 깔린 길을 찾아 그 길로 새 판을 받는다.
//   - Claude Code 플러그인(~/.claude/plugins/installed_plugins.json의 agent-operate@<마켓플레이스>)
//       → claude plugin marketplace update <마켓플레이스> → claude plugin update agent-operate@<마켓플레이스>
//   - skills CLI(~/.agents/.skill-lock.json에서 source가 vriznet/agent-operate인 스킬, opencode·Codex 등)
//       → npx skills update <스킬…> -g -y
// 사용: node update.mjs [--dry-run]
// 출력: 길마다 전·후 판(또는 커밋)과 재시작 필요 여부. 마지막 줄은 요약 JSON.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const REPO = 'vriznet/agent-operate';
const HOME = os.homedir();
const INSTALLED = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
const SKILL_LOCK = path.join(HOME, '.agents', '.skill-lock.json');
const SKILLS_CLI = 'skills@latest';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const short = (sha) => (sha || '').slice(0, 7) || '-';

function run(cmd, args) {
  const line = `${cmd} ${args.join(' ')}`;
  if (DRY) { console.log(`  (미리 보기) ${line}`); return { ok: true, out: '' }; }
  console.log(`  $ ${line}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const tail = out.split('\n').filter(Boolean).slice(-3).join('\n    ');
  if (tail) console.log(`    ${tail}`);
  return { ok: r.status === 0, out, error: r.error?.message };
}

function pluginEntries() {
  const data = readJson(INSTALLED);
  const plugins = data?.plugins || {};
  return Object.entries(plugins)
    .filter(([id]) => id.startsWith('agent-operate@'))
    .flatMap(([id, list]) => (Array.isArray(list) ? list : [list]).map((e) => ({ id, ...e })));
}

function lockedSkills() {
  const lock = readJson(SKILL_LOCK)?.skills || {};
  return Object.entries(lock).filter(([, v]) => v?.source === REPO).map(([name, v]) => ({ name, hash: v.skillFolderHash }));
}

const summary = { plugin: null, skillsCli: null, restartClaude: false };

// ---- 1) Claude Code 플러그인
const before = pluginEntries();
console.log('■ Claude Code 플러그인');
if (!before.length) {
  console.log('  깔려 있지 않다. (깔려면: claude plugin marketplace add vriznet/agent-operate && claude plugin install agent-operate@agent-operate)');
} else if (spawnSync('claude', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('  claude 명령을 찾지 못했다. Claude Code가 깔린 셸에서 다시 돌린다.');
  summary.plugin = { error: 'claude 없음' };
} else {
  const ids = [...new Set(before.map((e) => e.id))];
  for (const id of ids) {
    const market = id.split('@')[1];
    const was = before.filter((e) => e.id === id);
    console.log(`  ${id}: ${was.map((e) => `${e.version} (${short(e.gitCommitSha)}, ${e.scope})`).join(', ')}`);
    const m = run('claude', ['plugin', 'marketplace', 'update', market]);
    const u = m.ok ? run('claude', ['plugin', 'update', id]) : { ok: false };
    const now = DRY ? was : pluginEntries().filter((e) => e.id === id);
    const changed = !DRY && now.some((n) => !was.some((w) => w.gitCommitSha === n.gitCommitSha && w.version === n.version));
    if (changed) summary.restartClaude = true;
    summary.plugin = {
      id,
      ok: m.ok && u.ok,
      before: was.map((e) => `${e.version}@${short(e.gitCommitSha)}`),
      after: now.map((e) => `${e.version}@${short(e.gitCommitSha)}`),
      changed,
    };
    console.log(`  → ${DRY ? '미리 보기만 함' : changed ? `${summary.plugin.before.join(',')} → ${summary.plugin.after.join(',')} (Claude Code를 다시 시작해야 반영된다)` : m.ok && u.ok ? '이미 최신' : '실패 — 위 출력 참고'}`);
  }
}

// ---- 2) skills CLI (opencode·Codex 등)
const skills = lockedSkills();
console.log('■ skills CLI (opencode·Codex 등)');
if (!skills.length) {
  console.log(`  ${REPO}에서 받은 스킬이 없다. (깔려면: npx skills add ${REPO} -g -a opencode -a codex -y — Claude Code에는 깔지 않는다)`);
} else {
  console.log(`  ${skills.map((s) => s.name).join(', ')}`);
  const r = run('npx', ['--yes', SKILLS_CLI, 'update', ...skills.map((s) => s.name), '-g', '-y']);
  const after = DRY ? skills : lockedSkills();
  const changedNames = after.filter((a) => skills.find((b) => b.name === a.name)?.hash !== a.hash).map((a) => a.name);
  summary.skillsCli = { ok: r.ok, skills: skills.map((s) => s.name), changed: changedNames };
  console.log(`  → ${DRY ? '미리 보기만 함' : !r.ok ? '실패 — 위 출력 참고' : changedNames.length ? `바뀜: ${changedNames.join(', ')} (그 에이전트 세션을 다시 시작해야 반영된다)` : '이미 최신'}`);
}

console.log(JSON.stringify(summary));
