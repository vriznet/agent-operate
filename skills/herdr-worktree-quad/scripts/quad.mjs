#!/usr/bin/env node
// herdr-worktree-quad: 워크트리 4개를 만들고 현재 pane 오른쪽을 2x2로 나눠
// 각 워크트리에서 에이전트를 권한 우회 모드로 띄운다. 시작 창 중
// "업데이트"는 건너뛰고 "디렉터리 신뢰"는 승인하며, 그 밖의 창은 건드리지 않고 보고한다.
//
// 사용: node quad.mjs [--only claude,codex] [--base REF] [--pane PANE_ID] [--tab-label agents] [--dry-run]
// 출력: 결과 JSON(stdout). 치명 오류는 {"error": ...}와 종료 코드 1.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 순서 = 화면 배치 순서(좌상, 우상, 좌하, 우하)
const AGENTS = [
  { suffix: 'claude', kind: 'claude', args: ['--dangerously-skip-permissions'] },
  { suffix: 'codex', kind: 'codex', args: ['--yolo'] },
  // opencode에는 --dangerously-skip-permissions가 없다. 같은 역할인 --auto로 고정.
  { suffix: 'opencode', kind: 'opencode', args: ['--auto'] },
  { suffix: 'hermes', kind: 'hermes', args: ['--yolo'] },
];

function parseArgs(argv) {
  const opts = { only: null, base: 'HEAD', pane: process.env.HERDR_PANE_ID, tabLabel: 'agents', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--tab-label') opts.tabLabel = argv[++i];
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--pane') opts.pane = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else fail(`알 수 없는 인자: ${a}`);
  }
  return opts;
}

function fail(message, extra = {}) {
  process.stdout.write(JSON.stringify({ error: message, ...extra }, null, 2) + '\n');
  process.exit(1);
}

async function sh(cmd, args, opts = {}) {
  const { stdout } = await run(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout;
}

async function herdr(...args) {
  try {
    return JSON.parse(await sh('herdr', args));
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`herdr ${args.join(' ')} 실패: ${detail}`);
  }
}

async function git(root, ...args) {
  return (await sh('git', ['-C', root, ...args])).trim();
}

async function hasCommand(name) {
  try {
    await sh('/bin/sh', ['-lc', `command -v ${name}`]);
    return true;
  } catch {
    return false;
  }
}

// herdr 설정의 [worktrees] directory (기본 ~/.herdr/worktrees)
function worktreesDir() {
  const home = homedir();
  const cfg = join(home, '.config', 'herdr', 'config.toml');
  let dir = '~/.herdr/worktrees';
  if (existsSync(cfg)) {
    let section = '';
    for (const line of readFileSync(cfg, 'utf8').split('\n')) {
      const s = line.trim();
      const sec = s.match(/^\[([^\]]+)\]$/);
      if (sec) section = sec[1].trim();
      const kv = s.match(/^directory\s*=\s*"([^"]+)"/);
      if (section === 'worktrees' && kv) dir = kv[1];
    }
  }
  if (dir.startsWith('~')) dir = join(home, dir.slice(1));
  return resolve(dirname(cfg), dir);
}

// herdr 에이전트 이름 규칙: [a-z][a-z0-9_-]{0,31}
function agentName(branch) {
  let n = branch.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '');
  return (n || 'agent').slice(0, 32).replace(/-+$/, '');
}

function parseWorktrees(porcelain) {
  const list = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) list.push((cur = { path: line.slice(9) }));
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
  }
  return list;
}

// ── 시작 창 판별 ──────────────────────────────────────────────
// 선택 메뉴 두 형식을 모두 읽는다.
//   번호형(codex):   "› 1. Yes, continue" / "  2. No, quit"
//   번호 없음(claude): "❯ No, exit" / "  Yes, I trust this folder"
// 선택 표시(›❯▶→>)가 붙은 줄을 기준으로, 빈 줄 없이 붙어 있는 줄들을 한 메뉴로 본다.
const MARK = /^\s*[›❯▶→>]\s+/;
const FOOTER = /enter to|esc to|press enter|to confirm|to cancel/i;
function parseOptions(screen) {
  const lines = screen.split('\n');
  const toOpt = (line, idx) => {
    const selected = MARK.test(line);
    const body = line.replace(MARK, '').trim();
    const m = body.match(/^(\d)[.)]\s+(.+)$/);
    return { idx, selected, key: m ? m[1] : null, text: m ? m[2] : body };
  };
  const sel = lines.findIndex((l) => MARK.test(l) && !FOOTER.test(l));
  if (sel === -1) {
    // 선택 표시 없이 번호만 있는 메뉴
    return lines.map(toOpt).filter((o) => o.key);
  }
  let start = sel;
  let end = sel;
  const inMenu = (l) => l && l.trim() && !FOOTER.test(l);
  while (inMenu(lines[start - 1]) && /^\s{2,}\S/.test(lines[start - 1])) start--;
  while (inMenu(lines[end + 1]) && /^\s{2,}\S/.test(lines[end + 1])) end++;
  const block = lines.slice(start, end + 1).map((l, i) => toOpt(l, start + i));
  // 번호형이면 번호 줄만, 아니면 질문 줄(?/:로 끝남)을 뺀다
  if (block.some((o) => o.key)) return block.filter((o) => o.key);
  return block.filter((o) => o.selected || !/[?:]$/.test(o.text));
}

// 고른 선택지까지 가는 키: 이미 선택돼 있으면 Enter, 번호가 있으면 번호, 아니면 화살표로 이동.
// 이동만 하고 다음 확인 때 Enter를 누른다.
function keysFor(option, opts) {
  if (option.selected) return ['enter'];
  if (option.key) return [option.key];
  const cur = opts.find((o) => o.selected);
  const diff = option.idx - (cur ? cur.idx : option.idx);
  return Array(Math.abs(diff)).fill(diff > 0 ? 'down' : 'up');
}

function classify(screen) {
  const opts = parseOptions(screen);
  const text = screen;
  const pick = (re, avoid) => opts.find((o) => re.test(o.text) && !(avoid && avoid.test(o.text)));

  if (/\btrust\b/i.test(text) && opts.length >= 2) {
    const yes = pick(/\byes\b|\btrust\b/i, /\bno\b|don'?t|exit|quit/i);
    if (yes) return { kind: 'trust', option: yes, keys: keysFor(yes, opts) };
  }
  if (/update available|new version|update now|upgrade available|is available/i.test(text)) {
    if (opts.length >= 2) {
      const skip = pick(/^skip\b(?!.*until)/i) || pick(/skip|not now|later|dismiss|\bno\b/i);
      if (skip) return { kind: 'update', option: skip, keys: keysFor(skip, opts) };
    }
    if (/\[y\/n\]|\(y\/n\)/i.test(text)) return { kind: 'update', keys: ['n', 'enter'] };
  }
  if (opts.length >= 2 && opts.some((o) => o.selected)) return { kind: 'unknown' };
  return { kind: 'none' };
}

function tail(screen, n = 20) {
  return screen.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}

async function settle(name, paneId) {
  const handled = [];
  let clean = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const screen = (await sh('herdr', ['pane', 'read', paneId, '--source', 'visible'])).toString();
    const c = classify(screen);
    if (c.kind === 'trust' || c.kind === 'update') {
      clean = 0;
      await sh('herdr', ['pane', 'send-keys', paneId, ...c.keys]);
      // 화살표로 옮긴 뒤 Enter를 누르는 두 단계도 한 번으로 기록한다
      const entry = { dialog: c.kind, choice: c.option ? c.option.text : c.keys.join('+') };
      const last = handled[handled.length - 1];
      if (!last || last.dialog !== entry.dialog || last.choice !== entry.choice) handled.push(entry);
      continue;
    }
    const agent = await herdr('agent', 'get', name).catch(() => null);
    const status = agent?.result?.agent?.agent_status ?? 'gone';
    if (c.kind === 'unknown' || status === 'blocked') {
      return { status: 'needs_user', handled, screen: tail(screen) };
    }
    if (status === 'gone') return { status: 'exited', handled, screen: tail(screen) };
    if (status === 'idle' || status === 'done') {
      // 업데이트 창은 준비 직후 늦게 뜰 수 있어 두 번 연속 깨끗해야 끝낸다
      if (++clean >= 2) return { status, handled };
    }
  }
  return { status: 'timeout', handled };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const warnings = [];

  if (process.env.HERDR_ENV !== '1') fail('herdr pane 안에서 실행되지 않았습니다(HERDR_ENV=1 아님).');
  if (!opts.pane) fail('기준 pane을 알 수 없습니다(HERDR_PANE_ID 없음, --pane 필요).');

  let selected = AGENTS;
  if (opts.only) {
    const bad = opts.only.filter((s) => !AGENTS.some((a) => a.suffix === s));
    if (bad.length) fail(`--only에 모르는 에이전트: ${bad.join(', ')}`);
    selected = AGENTS.filter((a) => opts.only.includes(a.suffix));
  }

  // 저장소: 링크된 워크트리 안에서 불려도 원래 저장소를 기준으로 한다
  let root;
  try {
    const common = (await sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    root = basename(common) === '.git' ? dirname(common) : fail('bare 저장소는 지원하지 않습니다.');
  } catch {
    fail('git 저장소 안이 아닙니다.');
  }
  const repo = basename(root);
  const wtDir = join(worktreesDir(), repo);

  const missing = [];
  for (const a of selected) if (!(await hasCommand(a.kind))) missing.push(a.kind);
  if (missing.length) fail(`에이전트 명령이 없습니다: ${missing.join(', ')}`);

  if (await git(root, 'status', '--porcelain')) {
    warnings.push(`원래 저장소에 커밋하지 않은 변경이 있습니다. 새 워크트리는 ${opts.base}에서 시작하므로 그 변경은 들어가지 않습니다.`);
  }

  const plan = selected.map((a) => {
    const branch = `${repo}-${a.suffix}`;
    return { ...a, branch, name: agentName(branch) };
  });

  // 1) 워크트리: herdr worktree create는 워크스페이스를 항상 열므로 git으로 직접 만든다.
  //    경로는 herdr 규칙(<worktrees.directory>/<repo>/<branch>)과 같게 두어 herdr 목록·open과 호환된다.
  const existing = parseWorktrees(await git(root, 'worktree', 'list', '--porcelain'));
  for (const p of plan) {
    const found = existing.find((w) => w.branch === p.branch);
    if (found) {
      p.path = found.path;
      p.worktree = 'reused';
      continue;
    }
    p.path = join(wtDir, p.branch.replace(/[^A-Za-z0-9._-]+/g, '-'));
    if (existsSync(p.path)) fail(`워크트리가 아닌 폴더가 이미 있습니다: ${p.path}`);
    p.worktree = 'created';
    if (opts.dryRun) continue;
    let branchExists = true;
    try {
      await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`);
    } catch {
      branchExists = false;
    }
    const args = branchExists ? ['worktree', 'add', p.path, p.branch] : ['worktree', 'add', '-b', p.branch, p.path, opts.base];
    await git(root, ...args);
  }

  // 같은 이름이거나 같은 워크트리 폴더에서 에이전트가 이미 돌고 있으면 건너뛴다(재실행 안전)
  const live = (await herdr('agent', 'list')).result.agents;
  for (const p of plan) p.running = live.find((x) => x.name === p.name || x.cwd === p.path);

  // 2) 예전 방식으로 열려 있던 빈 워크트리 워크스페이스(셸 하나, 에이전트 없음)는 닫는다
  const closedWorkspaces = [];
  const herdrWts = (await herdr('worktree', 'list', '--cwd', root)).result.worktrees;
  for (const p of plan) {
    const ws = herdrWts.find((w) => w.branch === p.branch)?.open_workspace_id;
    if (!ws) continue;
    const panes = (await herdr('pane', 'list', '--workspace', ws)).result.panes;
    const empty = panes.length === 1 && !panes[0].agent && panes[0].pane_id !== opts.pane;
    if (!empty) {
      warnings.push(`${p.branch}의 워크스페이스 ${ws}는 비어 있지 않아 그대로 뒀습니다.`);
      continue;
    }
    if (!opts.dryRun) await herdr('workspace', 'close', ws);
    closedWorkspaces.push(ws);
  }

  const todo = plan.filter((p) => !p.running);
  const result = {
    repo,
    root,
    worktrees: plan.map((p) => ({ agent: p.suffix, branch: p.branch, path: p.path, worktree: p.worktree })),
    closedWorkspaces,
    skipped: plan.filter((p) => p.running).map((p) => ({ agent: p.suffix, name: p.name, pane: p.running.pane_id, runningAs: p.running.name ?? p.running.agent, reason: '이미 실행 중' })),
    panes: [],
    warnings,
  };
  if (opts.dryRun) {
    result.dryRun = true;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (todo.length === 0) {
    result.tab = await renameTab(opts.pane, opts.tabLabel, warnings);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // 3) 기준 pane 오른쪽을 나눈다. 순서대로 좌상·우상·좌하·우하.
  const split = async (target, direction, cwd) =>
    (await herdr('pane', 'split', '--pane', target, '--direction', direction, '--cwd', cwd, '--no-focus')).result.pane.pane_id;
  const [a, b, c, d] = todo;
  a.pane = await split(opts.pane, 'right', a.path);
  if (todo.length === 2) b.pane = await split(a.pane, 'down', b.path);
  if (todo.length >= 3) {
    c.pane = await split(a.pane, 'down', c.path);
    b.pane = await split(a.pane, 'right', b.path);
    if (d) d.pane = await split(c.pane, 'right', d.path);
  }
  await sleep(800); // 셸 프롬프트가 뜰 시간

  // 4) 에이전트 실행과 시작 창 처리는 네 pane을 동시에 진행한다
  result.panes = await Promise.all(
    todo.map(async (p) => {
      const base = { agent: p.suffix, name: p.name, pane: p.pane, flags: p.args.join(' ') };
      try {
        await herdr('agent', 'start', p.name, '--kind', p.kind, '--pane', p.pane, '--timeout', '90000', '--', ...p.args);
      } catch (e) {
        // agent_not_ready(시작 중 창에 막힘)는 아래 처리로 이어 간다
        if (!/agent_not_ready/.test(e.message)) return { ...base, status: 'start_failed', error: e.message };
      }
      return { ...base, ...(await settle(p.name, p.pane)) };
    }),
  );

  // 5) 마지막으로 에이전트들이 모인 탭 이름을 붙인다(herdr 문서의 탭 용도: agents/logs/server/review)
  result.tab = await renameTab(opts.pane, opts.tabLabel, warnings);

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function renameTab(paneId, label, warnings) {
  try {
    const tabId = (await herdr('pane', 'get', paneId)).result.pane.tab_id;
    await herdr('tab', 'rename', tabId, label);
    return { id: tabId, label };
  } catch (e) {
    warnings.push(`탭 이름을 '${label}'로 바꾸지 못했습니다: ${e.message}`);
    return null;
  }
}

main().catch((e) => fail(e.message));
