#!/usr/bin/env node
// herdr-split-opencode-subagent: 호출한 pane의 오른쪽을 N칸으로 나눠 칸마다 opencode 세션을 띄우고,
// 브리프 파일 경로를 보내 병렬 작업을 사용자가 눈으로 보게 한다(orca-split-claude-subagent의 herdr·opencode판).
//
// 사용:
//   node split.mjs start --panel "<이름>|<브리프 경로>|<역할 한 마디>" [--panel …] [--model <provider/model>]
//                        [--pane <기준 pane>] [--cwd <폴더>] [--start-timeout <초>] [--force] [--dry-run]
//   node split.mjs status <이름…>
//   node split.mjs wait <이름…> [--expect "<이름>=<출력 폴더>:<최소 파일 수>"]… [--interval <초>] [--timeout <분>]
//   node split.mjs close <이름|pane…>
// 출력: 결과 JSON(stdout). 치명 오류는 {"error": ...}와 종료 코드 1.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sleepMs = (ms) => spawnSync('sleep', [String(ms / 1000)]);
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function die(message, extra = {}) { out({ error: message, ...extra }); process.exit(1); }

function parseArgs(argv) {
  const opts = { _: [], panel: [], expect: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    if (['force', 'dry-run'].includes(key)) { opts[key] = true; continue; }
    const v = argv[++i];
    if (v === undefined) die(`${a}에 값이 없습니다.`);
    if (key === 'panel' || key === 'expect') opts[key].push(v);
    else opts[key] = v;
  }
  return opts;
}

// 실패하면 던진다(start가 만든 pane을 치우고 멈추려고).
function herdr(args) {
  const r = spawnSync('herdr', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  if (r.status !== 0 || !json) throw new Error(`herdr ${args.slice(0, 2).join(' ')} 실패: ${(r.stderr || r.stdout || r.error?.message || '').toString().trim().slice(0, 400)}`);
  return json;
}
const agentInfo = (name) => { try { return herdr(['agent', 'get', name]).result.agent; } catch { return null; } };

function screenTail(target, lines = 8, agent = true) {
  const args = agent ? ['agent', 'read', target] : ['pane', 'read', target];
  const r = spawnSync('herdr', [...args, '--source', 'visible'], { encoding: 'utf8' });
  let text = r.stdout || '';
  try { const j = JSON.parse(text).result; text = j.text || j.content || text; } catch {}
  // opencode 화면의 테두리만 있는 줄(┃ ╹▀)은 빼고 센다. 그래야 아래쪽 입력 틀에 오류 줄이 밀려나지 않는다.
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l.replace(/[┃╹▀\s]/g, '')).slice(-lines).join('\n');
}

// 칸 하나에 opencode를 띄운다. 막 나눈 pane은 셸이 프롬프트에 오기 전이라 herdr가 바로 agent_pane_busy를 낸다
// (herdr-council 실측). 그 오류만 1초 간격으로 최대 30초 다시 시도한다. --timeout은 3초 초과·300초 이하만 받는다.
function startAgent(name, pane, args, timeoutMs) {
  for (let tries = 0; ; tries += 1) {
    try {
      return herdr(['agent', 'start', name, '--kind', 'opencode', '--pane', pane, '--timeout', String(timeoutMs), '--', ...args]);
    } catch (err) {
      if (/agent_not_ready/.test(err.message)) return null; // 시작 중 창에 막힘 — 아래 확인으로 넘긴다
      if (!/agent_pane_busy/.test(err.message) || tries >= 30) throw err;
      sleepMs(1000);
    }
  }
}

// 보내기 전에 쉬는 상태가 될 때까지 기다린다. 막힘·꺼짐·업데이트 창이면 보내지 않는다.
// (herdr-council 실측: opencode "Update Complete" 창이 첫 프롬프트를 삼키고, Esc로 닫으면 opencode가 꺼져 다음 글이 셸에 들어갔다.)
function waitReady(name, seconds = 30) {
  for (let i = 0; i < seconds; i++) {
    const a = agentInfo(name);
    if (!a) return 'exited';
    if (a.agent_status === 'blocked') return 'needs_user';
    if (/Update Complete|Please restart the application/i.test(screenTail(name, 20))) return 'needs_user';
    if (a.agent_status === 'idle' || a.agent_status === 'done') return 'ready';
    sleepMs(1000);
  }
  return 'timeout';
}

// 보낸 뒤 실제로 일을 시작했는지(working·blocked가 보이는지) 확인한다. 보낸 직후의 idle은 아직 시작 전일 수 있어 믿지 않는다.
function waitStarted(name, seconds = 30) {
  for (let i = 0; i < seconds; i++) {
    const a = agentInfo(name);
    if (!a) return 'exited';
    if (a.agent_status === 'working') return 'working';
    if (a.agent_status === 'blocked') return 'needs_user';
    sleepMs(1000);
  }
  return 'not_seen';
}

function parsePanels(list) {
  if (!list.length) die('--panel "<이름>|<브리프 경로>|<역할 한 마디>"를 하나 이상 주세요.');
  const panels = list.map((spec) => {
    const [name, brief, ...rest] = spec.split('|').map((s) => s.trim());
    if (!name || !brief) die(`--panel 형식이 틀렸습니다: ${spec} ("<이름>|<브리프 경로>|<역할 한 마디>")`);
    if (!NAME_RE.test(name)) die(`이름 ${name}이(가) herdr 규칙([a-z][a-z0-9_-]{0,31})에 맞지 않습니다.`);
    const abs = path.resolve(brief);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) die(`브리프 파일이 없습니다: ${abs}`);
    return { name, brief: abs, role: rest.join('|') };
  });
  const dup = panels.map((p) => p.name).find((n, i, a) => a.indexOf(n) !== i);
  if (dup) die(`이름 ${dup}이(가) 두 번 나왔습니다.`);
  return panels;
}

// opencode 실행 플래그. 권한은 orca-split-claude-subagent와 같게 자동 승인으로 둔다.
// opencode에는 --dangerously-skip-permissions가 없고 같은 역할이 --auto다(herdr-worktree-quad와 같음).
// 이 판에 --auto가 없으면 플래그 없이 띄우고 알린다(승인 창에서 멈출 수 있다).
function opencodeArgs(model, warnings) {
  const help = spawnSync('opencode', ['--help'], { encoding: 'utf8' });
  if (help.error || help.status !== 0) die('opencode 명령을 찾지 못했습니다(opencode --help 실패).');
  const text = `${help.stdout || ''}${help.stderr || ''}`;
  const args = [];
  if (/--auto\b/.test(text)) args.push('--auto');
  else warnings.push('이 opencode에는 --auto(권한 자동 승인)가 없어 플래그 없이 띄웠다. 칸이 승인 창에서 멈출 수 있다 — 그때는 화면을 보고 사용자에게 묻는다.');
  if (model) {
    if (!/--model\b/.test(text)) die('이 opencode에는 --model 플래그가 없습니다. --model 없이 다시 돌리거나 opencode 기본 모델을 쓰세요.');
    args.push('--model', model);
  }
  return args;
}

function cmdStart(opts) {
  if (process.env.HERDR_ENV !== '1') die('herdr pane 안에서 실행되지 않았습니다(HERDR_ENV=1 아님).');
  const base = opts.pane || process.env.HERDR_PANE_ID || die('기준 pane을 알 수 없습니다(HERDR_PANE_ID 없음, --pane 필요).');
  const panels = parsePanels(opts.panel);
  if (panels.length > 4 && !opts.force) die(`칸이 ${panels.length}개입니다. 4개를 넘기면 화면이 좁아지니 사용자에게 먼저 묻고, 그래도 원하면 --force.`);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const warnings = [];
  const args = opencodeArgs(opts.model, warnings);

  // herdr 에이전트 이름은 서버 전체에서 하나뿐이다(다른 작업 공간 포함). 겹치면 나누기 전에 멈춘다.
  const live = herdr(['agent', 'list']).result.agents;
  const taken = panels.filter((p) => live.some((a) => a.name === p.name));
  if (taken.length) die(`이미 쓰이는 에이전트 이름: ${taken.map((p) => p.name).join(', ')}. 다른 이름을 주거나 그 에이전트를 먼저 정리하세요.`);
  if (!live.some((a) => a.pane_id === base) && !opts.force) die(`기준 pane(${base})에 에이전트가 없습니다. 이 스킬을 부른 Claude Code·opencode 세션에서 돌리세요(셸에서 일부러 돌리려면 --force).`);

  const plan = { base, cwd, flags: args.join(' '), panels: panels.map((p) => ({ name: p.name, brief: p.brief, role: p.role })) };
  if (opts['dry-run']) return out({ dryRun: true, ...plan, warnings });

  // 오른쪽으로 한 번, 그다음은 직전 칸에서 아래로 N-1번. 높이를 고르게 하려고 남는 칸 수로 비율을 준다
  // (--ratio는 나뉘는 쪽 pane이 갖는 몫). 자동 업데이트 창이 첫 프롬프트를 삼키지 않게 칸마다 끈다.
  const timeoutMs = Math.min(300, Math.max(4, Number(opts['start-timeout']) || 90)) * 1000;
  const env = ['--env', 'OPENCODE_DISABLE_AUTOUPDATE=1'];
  const created = [];
  try {
    let prev = null;
    panels.forEach((p, i) => {
      const split = i === 0
        ? ['pane', 'split', '--pane', base, '--direction', 'right']
        : ['pane', 'split', '--pane', prev, '--direction', 'down', '--ratio', String(1 / (panels.length - i + 1))];
      p.pane = herdr([...split, '--cwd', cwd, '--no-focus', ...env]).result.pane.pane_id;
      created.push(p.pane);
      prev = p.pane;
    });
    for (const p of panels) {
      try {
        startAgent(p.name, p.pane, args, timeoutMs);
      } catch (err) {
        const tail = screenTail(p.pane, 6, false);
        throw new Error(`${p.name} 기동 실패(${p.pane}): ${err.message}${tail ? `\n그 칸의 마지막 화면:\n${tail}` : ''}`);
      }
    }
  } catch (err) {
    // 중간에 실패하면 이번에 만든 칸을 모두 닫는다. 남겨 두면 다시 돌릴 때 빈 칸이 쌓인다.
    for (const pane of created) spawnSync('herdr', ['pane', 'close', pane], { encoding: 'utf8' });
    die(`${err.message}\n→ 이번에 만든 칸 ${created.length}개를 닫았다(기준 pane은 그대로).`);
  }

  // 일 맡기기: 실제 지시는 브리프에 있고, 칸에는 경로와 역할 한 마디만 보낸다.
  const results = panels.map((p) => {
    const ready = waitReady(p.name);
    const row = { name: p.name, pane: p.pane, brief: p.brief };
    if (ready !== 'ready') return { ...row, status: ready, screen: screenTail(p.pane, 12, false) };
    const text = `${p.brief} 를 읽고 그대로 수행해.${p.role ? ` ${p.role}.` : ''}`;
    try { herdr(['agent', 'prompt', p.name, text]); } catch (err) { return { ...row, status: 'prompt_failed', error: err.message }; }
    const started = waitStarted(p.name);
    return { ...row, status: started, ...(started === 'working' ? {} : { screen: screenTail(p.pane, 12, false) }) };
  });
  out({ ...plan, panes: results, warnings });
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

function snapshot(names, expects) {
  return names.map((name) => {
    const a = agentInfo(name);
    const row = { name, pane: a?.pane_id ?? null, status: a ? a.agent_status : 'exited', title: a?.terminal_title_stripped };
    const e = expects[name];
    if (e) Object.assign(row, { dir: e.dir, files: countFiles(e.dir), min: e.min });
    return row;
  });
}

function parseExpects(list) {
  const expects = {};
  for (const spec of list) {
    const m = spec.match(/^([^=]+)=(.+):(\d+)$/);
    if (!m) die(`--expect 형식이 틀렸습니다: ${spec} ("<이름>=<출력 폴더>:<최소 파일 수>")`);
    expects[m[1].trim()] = { dir: path.resolve(m[2]), min: Number(m[3]) };
  }
  return expects;
}

function cmdStatus(opts) {
  if (!opts._.length) die('이름을 하나 이상 주세요.');
  out({ agents: snapshot(opts._, {}).map((r) => ({ ...r, screen: r.status === 'exited' ? undefined : screenTail(r.name, 8) })) });
}

// 완료 감시. 백그라운드로 돌린다. 모두 쉬는 상태(idle·done)가 두 번 잇달아 보이고 출력 폴더가 최소 파일 수를 채우면 끝난다.
// 하나라도 막히거나(blocked) 꺼지면(exited) 바로 끝내고 알린다 — 대신 누르지 않는다.
function cmdWait(opts) {
  const names = opts._;
  if (!names.length) die('이름을 하나 이상 주세요.');
  const expects = parseExpects(opts.expect);
  const interval = Math.max(5, Number(opts.interval) || 30) * 1000;
  const deadline = Date.now() + Math.max(1, Number(opts.timeout) || 120) * 60 * 1000;
  let calm = 0;
  for (;;) {
    const rows = snapshot(names, expects);
    const stuck = rows.filter((r) => r.status === 'blocked' || r.status === 'exited');
    if (stuck.length) return out({ done: false, reason: 'needs_attention', agents: rows.map((r) => (stuck.includes(r) && r.status === 'blocked' ? { ...r, screen: screenTail(r.name, 12) } : r)) });
    const settled = rows.every((r) => r.status === 'idle' || r.status === 'done');
    const filled = rows.every((r) => r.min === undefined || r.files >= r.min);
    calm = settled ? calm + 1 : 0;
    if (calm >= 2 && filled) return out({ done: true, agents: rows });
    // 쉬는데 파일이 모자라면 모델 오류(키 만료·잔액 부족 등)로 끝났을 때가 많다(실측) — 화면 끝을 같이 싣는다.
    const short = (r) => (r.min !== undefined && r.files < r.min ? { ...r, screen: screenTail(r.name, 12) } : r);
    if (calm >= 2 && !filled) return out({ done: false, reason: 'idle_but_short', agents: rows.map(short) });
    if (Date.now() > deadline) return out({ done: false, reason: 'timeout', agents: rows.map(short) });
    sleepMs(interval);
  }
}

// 사용자가 닫기로 했을 때만 부른다. 에이전트가 이미 꺼져 이름이 풀렸으면 pane ID(start 결과의 pane)로 닫는다.
function cmdClose(opts) {
  if (!opts._.length) die('닫을 이름이나 pane을 하나 이상 주세요.');
  const results = opts._.map((t) => {
    const pane = /^w[^:]+:p\d+$/.test(t) ? t : agentInfo(t)?.pane_id;
    if (!pane) return { target: t, closed: false, reason: '그 이름의 에이전트가 없다(꺼졌으면 start 결과의 pane ID로 닫는다)' };
    if (pane === process.env.HERDR_PANE_ID) return { target: t, closed: false, reason: '스킬을 부른 pane은 닫지 않는다' };
    try { herdr(['pane', 'close', pane]); return { target: t, pane, closed: true }; } catch (err) { return { target: t, pane, closed: false, reason: err.message }; }
  });
  out({ closed: results });
}

const opts = parseArgs(process.argv.slice(3));
const cmd = process.argv[2];
if (cmd === 'start') cmdStart(opts);
else if (cmd === 'status') cmdStatus(opts);
else if (cmd === 'wait') cmdWait(opts);
else if (cmd === 'close') cmdClose(opts);
else die('명령: start | status | wait | close');
