#!/usr/bin/env node
// herdr-council: herdr pane을 3x3으로 나눠 조사관 8명을 세우고, 9인 회의(조사 → 의견 → 투표 → 확정)를 굴리는 손발.
// 판단(감독관 의견·투표·final.md·다음 주제)은 감독관 세션이 한다. 이 스크립트는 폴더·pane·프롬프트·집계만 맡는다.
//
// 사용(작업 저장소 안에서, 감독관 pane에서):
//   node council.mjs new [--home <폴더>] [--preset web-platforms-8] [--kind opencode|claude]   회의 집을 만든다
//   node council.mjs init "<주제>" [--force]     라운드 폴더를 만든다(헌장 승인 전에는 거절)
//   node council.mjs preflight                   수집 경로 점검, 결과를 이번 topic.md 끝에 붙인다
//   node council.mjs doctor                      setup 전 점검(저장소·herdr·감독관·조사관 CLI 판), 화면은 나누지 않는다
//   node council.mjs setup [--start-timeout 초]  3x3 pane + 조사관 8명 기동(살아 있으면 그대로, 실패하면 만든 pane을 닫고 멈춤)
//   node council.mjs research | vote             단계 프롬프트를 뿌린다(기다리지 않는다)
//   node council.mjs wait <research|vote> [분]   산출물이 다 나올 때까지 폴링(기본 90분)
//   node council.mjs status                      산출물·final 확인
//   node council.mjs tally                       득표 집계(동점이면 감독관이 정한다)
//   node council.mjs adopt <후보>                final.md의 <!-- ADOPTED-OPINION --> 자리에 채택 의견 전문을 넣는다
//   node council.mjs compact                     조사관 컨텍스트 정리(claude는 /compact, opencode는 자동 압축)
//   node council.mjs wake <start|stop|status> [--interval 20]   감독관이 쉬면 루프 지시를 넣는 트리거
//   node council.mjs research|vote --only <역할,…>   그 조사관에게만 다시 보낸다
//   node council.mjs revive [역할,…]             죽은 조사관만 제자리 pane에 다시 띄운다
//   node council.mjs teardown                    조사관 pane을 닫는다(감독관 pane은 남긴다)
//
// 회의 집(<home>): README.md(운영 규칙), charter.md(헌장), cumulative.md(누적 답), council.json(조사관·점검),
//   researcher.md(조사관 경계), collection.md(수집 경로, 프리셋이 줄 때), <YYMMDD-HHMM>/(라운드)
// 상태: <git-path agent-operate/council>/current.json — 워크트리마다 따로.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(SCRIPT), '..');

// ---------------------------------------------------------------- 인자

const argv = process.argv.slice(2);
const cmd = argv[0];
const opts = {};
const pos = [];
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--force') opts.force = true;
  else if (a.startsWith('--')) { opts[a.slice(2)] = argv[i + 1]; i += 1; }
  else pos.push(a);
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- 저장소·상태

function gitIn(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const ROOT = gitIn(opts.repo || process.cwd(), ['rev-parse', '--show-toplevel']) || (() => {
  const dir = opts.repo || process.cwd();
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((n) => n !== '.DS_Store'); } catch {}
  die(entries.length
    ? `git 저장소 안에서 실행하세요(회의 기록과 상태를 저장소에 둡니다): ${dir}`
    : `git 저장소가 아닙니다: ${dir} — 회의 전용 빈 폴더라면 먼저 \`git init\`을 한 뒤 다시 부르세요.`);
})();
function gitPath(rel) {
  const out = gitIn(ROOT, ['rev-parse', '--git-path', rel]);
  return path.isAbsolute(out) ? out : path.join(ROOT, out);
}
const STATE_DIR = gitPath('agent-operate/council');
const STATE_FILE = path.join(STATE_DIR, 'current.json');

function readState({ need = true } = {}) {
  if (!fs.existsSync(STATE_FILE)) {
    if (need) die('회의 상태가 없습니다. 먼저 `new`로 회의 집을 만드세요.');
    return {};
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}
const homeAbs = (state) => path.join(ROOT, state.home);
const roundAbs = (state) => path.join(ROOT, state.dir);

function readConfig(state) {
  const file = path.join(homeAbs(state), 'council.json');
  if (!fs.existsSync(file)) die(`council.json이 없습니다: ${path.relative(ROOT, file)}`);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(config.roles) || config.roles.length !== 8) {
    die(`council.json의 roles는 8개여야 합니다(3x3 = 감독관 1 + 조사관 8). 지금 ${config.roles?.length ?? 0}개.`);
  }
  for (const r of config.roles) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(r.name || '')) die(`조사관 이름이 herdr 규칙([a-z][a-z0-9_-]{0,31})에 맞지 않습니다: ${r.name}`);
  }
  return config;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// 라운드 원자료(facts·opinions·votes·tabs·errors·topic)는 커밋하지 않는다. 커밋 대상은 charter·cumulative·final뿐이다.
// 원자료에는 수집한 글의 인용과 작업 맥락이 그대로 들어가서, `git add -A`로 담는 커밋 습관이 있으면 섞여 나간다.
// 추적되는 .gitignore는 건드리지 않고 저장소의 .git/info/exclude에 넣는다(워크트리끼리 공유).
function ensureExcludes(homeRel) {
  return addExcludes([`/${homeRel}/*/*`, `!/${homeRel}/*/final.md`, '/.opencode/agents/council-researcher.md']);
}

function addExcludes(want) {
  const exclude = path.resolve(ROOT, gitIn(ROOT, ['rev-parse', '--git-common-dir']), 'info', 'exclude');
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const missing = want.filter((line) => !cur.split('\n').includes(line));
  if (missing.length) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}# herdr-council: 라운드 원자료와 생성한 조사관 설정은 커밋하지 않음\n${missing.join('\n')}\n`);
  }
  return exclude;
}

// ---------------------------------------------------------------- herdr

function herdr(args) {
  let out;
  try {
    out = execFileSync('herdr', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    die(`herdr ${args.slice(0, 2).join(' ')} 실패: ${(err.stderr || '').toString().trim() || err.message}`);
  }
  try { return JSON.parse(out); } catch { die(`herdr 출력을 JSON으로 읽지 못했습니다: ${out.slice(0, 400)}`); }
}
const needHerdr = () => { if (process.env.HERDR_ENV !== '1') die('herdr pane 안에서 실행하세요(HERDR_ENV=1이 아닙니다).'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 역할 이름 → 이 회의가 띄운 herdr 에이전트 이름(이름이 겹치면 저장소 이름이 붙는다).
const agentOf = (state, role) => state.agentNames?.[role.name] || role.name;

// ---------------------------------------------------------------- new

function defaultHome() {
  // orbit 하네스가 깔린 저장소면 그 문서 볼트 안에 둔다.
  const manifest = path.join(ROOT, '.claude', 'orbit-manifest.json');
  if (fs.existsSync(manifest)) {
    try {
      const docs = JSON.parse(fs.readFileSync(manifest, 'utf8')).docsDir;
      if (docs) return path.join(docs, 'council');
    } catch {}
  }
  return 'council';
}

function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function cmdNew() {
  const presetName = opts.preset || 'web-platforms-8';
  const presetDir = path.join(SKILL_DIR, 'presets', presetName);
  if (!fs.existsSync(path.join(presetDir, 'council.json'))) {
    const have = fs.readdirSync(path.join(SKILL_DIR, 'presets')).join(', ');
    die(`프리셋이 없습니다: ${presetName} (있는 것: ${have})`);
  }
  const home = (opts.home || defaultHome()).replace(/\/+$/, '');
  const abs = path.join(ROOT, home);
  const vars = { HOME: home, SCRIPT, PRESET: presetName };

  if (fs.existsSync(path.join(abs, 'council.json'))) {
    console.log(`이미 회의 집이 있습니다: ${home} — 그대로 씁니다.`);
  } else {
    fs.mkdirSync(abs, { recursive: true });
    for (const f of ['README.md', 'charter.md', 'cumulative.md', 'researcher.md']) {
      const dest = path.join(abs, f);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, fill(fs.readFileSync(path.join(SKILL_DIR, 'templates', f), 'utf8'), vars));
    }
    const collection = path.join(presetDir, 'collection.md');
    if (fs.existsSync(collection) && !fs.existsSync(path.join(abs, 'collection.md'))) {
      fs.writeFileSync(path.join(abs, 'collection.md'), fill(fs.readFileSync(collection, 'utf8'), vars));
    }
    const config = JSON.parse(fs.readFileSync(path.join(presetDir, 'council.json'), 'utf8'));
    config.preset = presetName;
    if (opts.kind) config.kind = opts.kind;
    fs.writeFileSync(path.join(abs, 'council.json'), `${JSON.stringify(config, null, 2)}\n`);
    console.log(`회의 집 생성: ${home} (프리셋 ${presetName}, 조사관 ${config.kind || 'opencode'})`);
  }
  const exclude = ensureExcludes(home);
  const prev = readState({ need: false });
  writeState({ ...prev, home, panes: prev.panes || {}, history: prev.history || [] });
  console.log(`git 무시 목록: ${path.relative(ROOT, exclude) || exclude} (라운드 원자료 제외, final.md만 남김)`);
  console.log('다음: charter.md를 사용자와 함께 채우고 "상태: `승인됨`"으로 바꾼 뒤 init "<주제>".');
}

// ---------------------------------------------------------------- init

function cmdInit() {
  const topic = pos.join(' ').trim();
  if (!topic) die('주제를 넘겨주세요: init "<주제>"');
  const state = readState();
  const charter = path.join(homeAbs(state), 'charter.md');
  const approved = fs.existsSync(charter) && /상태:\s*`?승인됨`?/.test(fs.readFileSync(charter, 'utf8'));
  if (!approved && !opts.force) die(`헌장이 승인되지 않았습니다: ${path.relative(ROOT, charter)} — 사용자 승인 뒤 "상태: \`승인됨\`"으로 바꾸세요.`);

  const round = stamp();
  const dir = path.join(state.home, round);
  const abs = path.join(ROOT, dir);
  if (fs.existsSync(abs)) die(`이미 있습니다: ${dir} (1분 뒤 다시)`);
  for (const sub of ['facts', 'opinions', 'votes', 'tabs', 'errors']) fs.mkdirSync(path.join(abs, sub), { recursive: true });
  fs.writeFileSync(path.join(abs, 'topic.md'), [
    `# 라운드 ${round} 주제`,
    '',
    `> 던진 시각: ${new Date().toISOString()}`,
    '',
    topic,
    '',
    '## 원 질문 연결 (감독관이 채운다 — 약하면 주제를 다시 잡는다)',
    '',
    '1. 채우는 부분: 이 라운드가 헌장의 질문에서 어느 부분을 채우는가.',
    '2. 바뀌는 점: 이 라운드가 답하면 헌장의 질문이 어떻게 바뀌는가.',
    '3. 거리: 직전 라운드에서 원 질문까지 몇 홉인가(4홉을 넘으면 주제를 다시 잡는다).',
    '',
    '## 하위 질문',
    '',
    '- 문헌 질문: ',
    '- 플랫폼 질문: ',
    '',
  ].join('\n'));
  writeState({
    ...state,
    round,
    dir,
    topic,
    supervisorPane: process.env.HERDR_PANE_ID || state.supervisorPane || null,
    history: [...(state.history || []), state.round].filter(Boolean),
  });
  console.log(`라운드 생성: ${dir}`);
  console.log('다음: topic.md의 원 질문 연결 3칸을 채우고 preflight → setup → research.');
}

// ---------------------------------------------------------------- preflight

function cmdPreflight() {
  const state = readState();
  const config = readConfig(state);
  const checks = config.preflight || [];
  if (!checks.length) { console.log('council.json에 preflight 점검이 없습니다.'); return; }
  const lines = [];
  for (const c of checks) {
    const r = spawnSync(c.cmd, c.args || [], { cwd: ROOT, encoding: 'utf8', timeout: (c.timeoutS || 60) * 1000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = r.status === 0 && (!c.expect || new RegExp(c.expect, 'i').test(r.stdout || ''));
    const detail = ((ok ? r.stdout : (r.stderr || r.stdout || r.error?.message || '')) || '').toString().replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n')[0]?.slice(0, 120) || '';
    const line = `- ${ok ? '산 길' : '죽은 길'}: ${c.label} — ${detail}`;
    lines.push(line);
    console.log(line);
  }
  if (state.dir && fs.existsSync(path.join(roundAbs(state), 'topic.md'))) {
    fs.appendFileSync(path.join(roundAbs(state), 'topic.md'), `\n## 경로 점검 (${new Date().toLocaleString('ko-KR')})\n\n${lines.join('\n')}\n\n죽은 길은 조사관이 시도하지 않는다.\n`);
    console.log(`→ ${path.join(state.dir, 'topic.md')} 끝에 붙임`);
  }
}

// ---------------------------------------------------------------- setup

// 실패해도 끝까지 가지 않고 던진다(setup이 만든 pane을 치우고 멈추려고). herdr()는 바로 die한다.
function herdrTry(args) {
  const r = spawnSync('herdr', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  if (r.status !== 0 || !json) throw new Error(`herdr ${args.slice(0, 2).join(' ')} 실패: ${(r.stderr || r.stdout || r.error?.message || '').toString().trim().slice(0, 400)}`);
  return json;
}

// 조사관 하나를 띄운다. 막 나눈 pane은 셸이 아직 프롬프트에 오기 전이라 herdr가 바로 agent_pane_busy("not an available shell")를
// 낸다(실측: 새 작업 공간에서 첫 조사관이 즉시 실패). 그 오류만 1초 간격으로 최대 30초 다시 시도한다.
// herdr agent start는 대기 시간을 3초 초과·300초 이하만 받는다(실측) — 그 범위로 맞춘다.
const startTimeoutMs = () => Math.min(300, Math.max(4, Number(opts['start-timeout']) || 90)) * 1000;

function startResearcher(name, kind, pane, args, timeoutMs) {
  for (let tries = 0; ; tries += 1) {
    try {
      return herdrTry(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', String(timeoutMs), '--', ...args]);
    } catch (err) {
      if (!/agent_pane_busy/.test(err.message) || tries >= 30) throw err;
      spawnSync('sleep', ['1']);
    }
  }
}

// 3x3 격자. 감독관 pane(현재 pane)이 좌상단에 남는다. 새로 만든 pane은 created에 바로 적는다(실패 때 치우려고).
function buildGrid(rootPane, env = {}, created = []) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const split = (pane, direction, ratio) => {
    const id = herdrTry(['pane', 'split', '--pane', pane, '--direction', direction, '--ratio', String(ratio), '--cwd', ROOT, '--no-focus', ...envArgs]).result.pane.pane_id;
    created.push(id);
    return id;
  };
  const row2 = split(rootPane, 'down', 1 / 3);
  const row3 = split(row2, 'down', 0.5);
  const panes = [];
  for (const rowRoot of [rootPane, row2, row3]) {
    const mid = split(rowRoot, 'right', 1 / 3);
    const last = split(mid, 'right', 0.5);
    panes.push(rowRoot, mid, last);
  }
  return panes;
}

const OPENCODE_AGENT_FILE = () => path.join(ROOT, '.opencode', 'agents', 'council-researcher.md');
const OPENCODE_MARK = '<!-- herdr-council가 만든 파일 -->';

// opencode v1은 TUI 실행 플래그 --agent가 있고, v2는 없다. 톱레벨 --help로 가린다.
// --help가 실패하면(못 찾음 등) 예전 방식(v1)으로 둔다 — 그때는 agent start가 원인을 화면에 남긴다.
function opencodeHasAgentFlag() {
  const help = spawnSync('opencode', ['--help'], { encoding: 'utf8' });
  if (help.status !== 0) return true;
  return /--agent\b/.test(`${help.stdout || ''}${help.stderr || ''}`);
}
function opencodeHasFlag(flag) {
  const help = spawnSync('opencode', ['--help'], { encoding: 'utf8' });
  return new RegExp(`${flag}\\b`).test(`${help.stdout || ''}${help.stderr || ''}`);
}

// 0.4.1이 v2에서 만든 .opencode/opencode.json(내용이 $schema와 default_agent=council-researcher뿐)을 지운다.
// 사용자가 다른 설정을 함께 둔 파일은 고치지 않고 알리기만 한다.
const LEGACY_CFG = () => path.join(ROOT, '.opencode', 'opencode.json');
function legacyDefaultAgent() {
  const cfg = LEGACY_CFG();
  if (!fs.existsSync(cfg)) return null;
  let json = null;
  try { json = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { return null; }
  if (json?.default_agent !== 'council-researcher') return null;
  const ours = Object.keys(json).every((k) => k === '$schema' || k === 'default_agent');
  return { cfg, ours };
}
function cleanLegacyDefaultAgent() {
  const legacy = legacyDefaultAgent();
  if (!legacy) return;
  const rel = path.relative(ROOT, legacy.cfg);
  if (legacy.ours) {
    fs.rmSync(legacy.cfg);
    console.log(`예전 판(0.4.1)이 만든 ${rel}(default_agent=council-researcher)를 지웠다. 이제 이 저장소의 새 opencode 세션은 원래 기본 에이전트로 뜬다.`);
  } else {
    console.log(`주의: ${rel}에 "default_agent": "council-researcher"가 있다. 이 저장소의 새 opencode 세션이 조사관으로 뜬다 — 그 줄은 이제 필요 없으니 손으로 지우세요(다른 설정이 섞여 있어 자동으로 고치지 않음).`);
  }
}

// 조사관 경계(researcher.md)를 에이전트 종류에 맞게 싣는다.
function researcherArgs(state, config) {
  const kind = config.kind || 'opencode';
  const text = fs.readFileSync(path.join(homeAbs(state), 'researcher.md'), 'utf8');
  if (kind === 'opencode') {
    const file = OPENCODE_AGENT_FILE();
    const body = `---\ndescription: herdr-council 조사관 — 자기 플랫폼을 조사해 facts·opinions·votes를 쓰는 전용 세션\nmode: primary\npermission:\n  edit: allow\n  bash: allow\n  webfetch: allow\n  websearch: allow\n  task: deny\n  question: deny\n---\n${OPENCODE_MARK}\n\n${text}`;
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(OPENCODE_MARK)) {
      console.log(`주의: ${path.relative(ROOT, file)}가 이미 있고 이 스킬이 만든 것이 아니라 그대로 씁니다.`);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    if (opencodeHasAgentFlag()) return { kind, args: ['--agent', 'council-researcher'], env: {} };
    // opencode v2 TUI(2.0.32 실측)에는 --agent 플래그가 없어 `opencode --agent …`가 즉시 끝난다(Unrecognized flag).
    // 0.4.1은 저장소 .opencode/opencode.json에 default_agent를 심었는데, 회의가 끝나도 그 저장소의 새 opencode 세션이
    // 모두 조사관으로 떴다. 그래서 파일을 쓰지 않고 조사관 pane에만 설정을 준다: --standalone(그 pane 전용 서버)
    // + OPENCODE_CONFIG_CONTENT. 공유 백그라운드 서버는 pane별 환경변수를 무시하지만(실측: Build로 뜸),
    // standalone에서는 먹고 저장소 config의 default_agent보다 앞선다(실측: plan을 이기고 Council-Researcher).
    if (!opencodeHasFlag('--standalone')) die('이 opencode에는 --agent도 --standalone도 없어 조사관 에이전트를 고를 수 없습니다. opencode --help를 확인하세요.');
    return { kind, args: ['--standalone'], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: 'council-researcher' }) } };
  }
  if (kind === 'claude') {
    // 조사관이 저장소 훅(worklog 강제 등)에 걸리지 않게 훅을 끄고, 경계를 시스템 프롬프트로 싣는다.
    return { kind, args: ['--settings', '{"disableAllHooks":true}', '--append-system-prompt', text, '--dangerously-skip-permissions'] };
  }
  die(`council.json의 kind는 opencode 또는 claude: ${kind}`);
}

function cmdSetup() {
  needHerdr();
  const state = readState();
  const config = readConfig(state);
  const supervisorPane = process.env.HERDR_PANE_ID || die('HERDR_PANE_ID를 읽지 못했습니다.');
  // 감독관은 이 스크립트를 부른 세션이다. 그 pane에 에이전트가 없으면(셸에서 직접 돌림) 격자의 왼쪽 위가 빈 셸로 남는다(실측) — 막는다.
  const supervisorAgent = herdr(['agent', 'list']).result.agents.find((a) => a.pane_id === supervisorPane);
  if (!supervisorAgent && !opts.force) die(`감독관 pane(${supervisorPane})에 에이전트가 없습니다. Claude Code·opencode 세션에서 herdr-council 스킬로 부르세요(그 세션이 감독관이 됩니다). 셸에서 일부러 돌리려면 --force.`);
  // herdr 에이전트 이름은 서버 전체에서 하나뿐이다. 다른 저장소의 회의가 같은 이름(reddit-agent 등)을 쓰고 있을 수 있어서,
  // "살아 있다"는 이 회의가 기록한 pane에 그 이름이 있을 때만 믿는다(실측: 다른 작업 공간의 조사관을 제 것으로 착각했다).
  const liveByName = new Map(herdr(['agent', 'list']).result.agents.filter((a) => a.name).map((a) => [a.name, a.pane_id]));
  const prevPanes = state.panes || {};
  const prevNames = state.agentNames || {};
  const ours = (r) => prevNames[r.name] && prevPanes[r.name] && liveByName.get(prevNames[r.name]) === prevPanes[r.name];
  const alive = config.roles.filter(ours);
  if (alive.length === config.roles.length) {
    console.log(`조사관 ${alive.length}명이 이미 살아 있다. 다시 만들지 않는다.`);
    return;
  }
  if (alive.length) die(`조사관이 일부만 살아 있다(${alive.map((r) => prevNames[r.name]).join(', ')}). 정리(teardown)한 뒤 다시 setup.`);

  // 이름이 이미 쓰이고 있으면 저장소 이름을 붙인다. 파일 이름(facts/<역할>.md)은 역할 이름 그대로다.
  const slug = path.basename(ROOT).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'council';
  const agentNames = {};
  for (const r of config.roles) {
    let n = r.name;
    if (liveByName.has(n)) n = `${r.name.slice(0, 31 - Math.min(slug.length, 12))}-${slug.slice(0, 12)}`.replace(/-+$/, '');
    if (liveByName.has(n) || Object.values(agentNames).includes(n)) die(`에이전트 이름 ${n}이(가) 이미 쓰이고 있다. council.json의 roles 이름을 바꾸세요.`);
    agentNames[r.name] = n;
  }

  const { kind, args, env: extraEnv = {} } = researcherArgs(state, config);
  if (args.includes('--standalone')) cleanLegacyDefaultAgent();
  // opencode는 뜨면서 스스로 업데이트하고 "Update Complete — restart" 창을 띄워 첫 프롬프트를 삼킨다(실측 1.18.34→1.19.3). 조사관 pane에서는 끈다.
  // 중간에 실패하면(조사관 하나가 안 뜸 등) 이번에 만든 pane을 모두 닫고 멈춘다. 그대로 두면 상태에는 pane이 없는데
  // 화면에는 8개가 남아, 다시 setup하면 격자가 겹쳐 생긴다(실측). 실패한 pane의 마지막 화면은 원인으로 보여 준다.
  const created = [];
  const startTimeout = startTimeoutMs();
  const panes = {};
  try {
    const grid = buildGrid(supervisorPane, kind === 'opencode' ? { OPENCODE_DISABLE_AUTOUPDATE: '1', ...extraEnv } : {}, created);
    if (grid.length !== 9) throw new Error(`pane이 9개가 아니라 ${grid.length}개입니다.`);
    const agentPanes = grid.filter((p) => p !== supervisorPane);
    for (let i = 0; i < config.roles.length; i += 1) {
      const role = config.roles[i].name;
      try {
        startResearcher(agentNames[role], kind, agentPanes[i], args, startTimeout);
      } catch (err) {
        const screen = spawnSync('herdr', ['pane', 'read', agentPanes[i], '--source', 'recent-unwrapped', '--lines', '15'], { encoding: 'utf8' }).stdout || '';
        let text = screen;
        try { text = JSON.parse(screen).result.text || screen; } catch {}
        const tail = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-6).join('\n    ');
        throw new Error(`${agentNames[role]} 기동 실패(${agentPanes[i]}): ${err.message}${tail ? `\n  그 pane의 마지막 화면:\n    ${tail}` : ''}`);
      }
      panes[role] = agentPanes[i];
      console.log(`기동: ${agentNames[role]} → ${agentPanes[i]}`);
    }
  } catch (err) {
    for (const pane of created) spawnSync('herdr', ['pane', 'close', pane], { encoding: 'utf8' });
    die(`${err.message}\n→ 이번에 만든 pane ${created.length}개를 닫았다(감독관 pane은 그대로). 원인을 고친 뒤 setup을 다시 돌린다.`);
  }
  writeState({ ...state, panes, agentNames, supervisorPane });
  console.log(`조사관 ${config.roles.length}명 기동 완료(${kind}).`);
}

function screenOf(agent) {
  const r = spawnSync('herdr', ['agent', 'read', agent, '--source', 'visible'], { encoding: 'utf8' });
  try { const j = JSON.parse(r.stdout).result; return j.text || j.content || ''; } catch { return r.stdout || ''; }
}
// 보내기 직전 확인. 에이전트가 없거나(셸로 돌아감) 시작 창이 떠 있으면 보내지 않는다.
// 실측: opencode의 "Update Complete — restart" 창을 Esc로 닫으면 opencode가 꺼지고, 그 직후 보낸 프롬프트가 셸(zsh)에 그대로 입력됐다.
// 그래서 시작 창은 건드리지 않고(대신 누르지 않는다) revive로 다시 띄우게 한다.
function readyToPrompt(agent) {
  // opencode v2는 판이 바뀐 뒤 처음 뜰 때 "What's new in <판>" 소개 창을 띄워 첫 프롬프트를 삼킨다. Esc로 닫아도 opencode는 산다(2.0.32 실측).
  if (/What's new in \d/.test(screenOf(agent))) { spawnSync('herdr', ['agent', 'send-keys', agent, 'esc'], { encoding: 'utf8' }); spawnSync('sleep', ['1']); }
  const got = spawnSync('herdr', ['agent', 'get', agent], { encoding: 'utf8' });
  let status = null;
  try { status = JSON.parse(got.stdout).result.agent.agent_status; } catch {}
  if (!status) return `에이전트가 없다(셸로 돌아갔을 수 있다) — revive로 다시 띄운다`;
  if (/Update Complete|Please restart the application/i.test(screenOf(agent))) return '업데이트 완료 창이 떠 있다 — 그 pane의 opencode를 끄고 revive로 다시 띄운다';
  if (status === 'blocked') return '승인·질문 창에 막혀 있다 — 화면을 보고 사용자에게 묻는다';
  return null;
}

// ---------------------------------------------------------------- dispatch

// 프롬프트를 던지기만 한다(--wait 없음). 완료 판정은 파일이 생겼는지로 한다.
function submitAgent(name, text) {
  return new Promise((resolve) => {
    const child = spawn('herdr', ['agent', 'prompt', name, text], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ name, code, out: out.trim(), err: err.trim() }));
  });
}

async function dispatchAll(state, config, buildPrompt, label) {
  // 한꺼번에 던지면 조사관들이 브라우저 하나를 두고 경쟁해 다 같이 느려진다(실측). 사이를 둔다.
  const staggerMs = Number(config.staggerS ?? 8) * 1000;
  // --only reddit-agent,quora-agent: 그 역할에만 다시 보낸다(일하는 중인 조사관에게 같은 지시가 또 쌓이지 않게).
  const only = opts.only ? new Set(opts.only.split(',').map((s) => s.trim())) : null;
  const targets = config.roles.filter((r) => !only || only.has(r.name));
  if (only && targets.length !== only.size) die(`--only에 모르는 역할이 있다: ${[...only].filter((n) => !config.roles.some((r) => r.name === n)).join(', ')}`);
  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    if (i > 0 && staggerMs) await sleep(staggerMs);
    const agent = agentOf(state, targets[i]);
    const why = readyToPrompt(agent);
    if (why) { results.push({ name: agent, code: 1, out: '', err: `보내지 않음: ${why}` }); continue; }
    results.push(await submitAgent(agent, buildPrompt(targets[i])));
  }
  let failed = 0;
  for (const r of results) {
    if (r.code === 0) console.log(`  제출 ok   ${r.name}`);
    else {
      failed += 1;
      let why = r.err.slice(0, 120);
      try { why = JSON.parse(r.err).error?.code || why; } catch {}
      console.log(`  제출 FAIL ${r.name} — ${why}`);
    }
  }
  console.log(`${label}: 제출 ${results.length - failed} / 실패 ${failed}`);
  if (failed) console.log('실패한 조사관만 같은 명령을 다시 돌리면 된다(이미 쓴 파일은 조사관이 다시 쓰지 않는다).');
  console.log('제출 성공은 완료가 아니다. `wait`로 파일이 생기길 기다린다.');
}

function prevFinal(state) {
  const prev = (state.history || []).filter((r) => r && r !== state.round).reverse();
  for (const r of prev) {
    const f = path.join(state.home, r, 'final.md');
    if (fs.existsSync(path.join(ROOT, f))) return f;
  }
  return null;
}

async function cmdResearch() {
  needHerdr();
  const state = readState();
  if (!state.dir) die('라운드가 없습니다. init "<주제>"부터.');
  const config = readConfig(state);
  const home = state.home;
  const dir = state.dir;
  const collection = fs.existsSync(path.join(homeAbs(state), 'collection.md')) ? `${home}/collection.md` : null;
  const last = prevFinal(state);
  await dispatchAll(state, config, (role) => [
    `너는 이 회의(herdr-council)의 ${role.label} 조사관이다. 이름은 ${role.name}.`,
    `규칙: ${home}/README.md`,
    `원 주제 헌장: ${home}/charter.md`,
    `누적 답: ${home}/cumulative.md`,
    `이번 라운드 폴더: ${dir}/ — 주제는 ${dir}/topic.md (끝에 경로 점검 결과가 있으면 죽은 길은 시도하지 않는다)`,
    ...(collection ? [`수집 방법: ${collection}에서 ${role.label} 줄과 공통 규칙을 따른다.`] : []),
    ...(role.strength ? [`이 자리가 잘 주는 것: ${role.strength}`] : []),
    ...(last ? ['', `맥락이 필요하면 직전 라운드 확정만 보라: ${last} — 통째로 읽지 말고 주제와 관련된 절만. 이전 라운드 final.md를 전부 읽지 마라(컨텍스트가 넘친다).`] : []),
    '',
    '할 일 — 1단계(조사).',
    `1) ${role.label}에서 주제를 조사한다. 플랫폼 질문은 그곳 사람들이 쓰는 말로 옮겨 검색하고, 어떤 말로 옮겼는지 적는다. 문헌 질문은 원문을 연 것만 쓴다.`,
    `   막히면 그 자리에서 ${dir}/errors/${role.name}.md 에 시도한 것·받은 응답·다음 길을 적는다.`,
    `2) ${dir}/facts/${role.name}.md — "## 수집 경로 상태 / ## 플랫폼에서 나온 것 / ## 문헌에서 나온 것" 순서로, 출처 URL과 함께. "없다"는 README의 '없다고 쓰는 조건'을 통과한 것만.`,
    `3) ${dir}/opinions/${role.name}.md — 네 조사에서 나온 네 의견을 주장·근거·반대 근거·결론 순으로.`,
    '',
    `쓰는 곳은 ${dir}/ 아래뿐이다. 그 밖의 파일은 읽기만 하고 커밋·git 조작을 하지 마라. 저장소의 작업 일지·할일·ADR·위키 규칙은 이 세션에 적용하지 않는다.`,
    `이미 ${dir}/opinions/${role.name}.md 가 있으면 다시 쓰지 마라. 큰 파일은 필요한 부분만 읽어라. 못 찾은 것은 "못 찾음"이라고 써라.`,
    `끝나면 "DONE ${role.name}" 한 줄만 답하라.`,
  ].join('\n'), '조사 단계');
}

async function cmdVote() {
  needHerdr();
  const state = readState();
  if (!state.dir) die('라운드가 없습니다.');
  const config = readConfig(state);
  const dir = state.dir;
  const candidates = [...config.roles.map((r) => r.name), 'supervisor'];
  await dispatchAll(state, config, (role) => {
    const others = candidates.filter((c) => c !== role.name);
    return [
      `너는 이 회의의 ${role.name} 조사관이다. 이제 2단계, 투표다. 규칙: ${state.home}/README.md`,
      '',
      `아래 ${others.length}개 의견을 읽어라. 네 의견은 뺐다. 자기 의견에는 투표할 수 없다.`,
      ...others.map((c) => `- ${dir}/opinions/${c}.md`),
      '각 파일을 통째로 읽지 말고 주장·결론 절만 골라 읽어라. 다른 파일은 읽지 마라.',
      '',
      `${dir}/votes/${role.name}.md 를 써라. 첫 줄은 정확히 "투표: <후보이름>" (기권은 "투표: 기권"과 이유).`,
      '그다음 왜 그 의견이 가장 타당한지, 나머지는 왜 덜한지 쓴다. "이 의견이 논제의 물음에 답한 부분"과 "논제를 바꾼 부분"을 나눠 적는다.',
      `이미 ${dir}/votes/${role.name}.md 가 있으면 다시 쓰지 마라. 끝나면 "DONE ${role.name}" 한 줄만 답하라.`,
    ].join('\n');
  }, '투표 단계');
}

// ---------------------------------------------------------------- wait / status / tally / adopt

function expectedFiles(kind, config) {
  const names = config.roles.map((r) => r.name);
  if (kind === 'research') return [...names.map((n) => `facts/${n}.md`), ...names.map((n) => `opinions/${n}.md`), 'opinions/supervisor.md'];
  // 감독관 표는 조사관 표가 다 온 뒤 감독관이 쓴다. 여기서 기다리면 감독관이 자기 표를 기다리며 시간 초과까지 멈춘다(실측).
  if (kind === 'vote') return names.map((n) => `votes/${n}.md`);
  die(`wait: 알 수 없는 단계 "${kind}" (research|vote)`);
}

async function cmdWait() {
  const state = readState();
  const config = readConfig(state);
  const kind = pos[0];
  const minutes = Number(pos[1]) || 90;
  const want = expectedFiles(kind, config);
  const deadline = Date.now() + minutes * 60 * 1000;
  let lastCount = -1;
  for (;;) {
    const missing = want.filter((f) => !fs.existsSync(path.join(roundAbs(state), f)));
    const line = `[${new Date().toLocaleTimeString('ko-KR')}] ${kind}: ${want.length - missing.length}/${want.length}`;
    if (!missing.length) { console.log(`${line} — 전부 도착.`); return; }
    // 개수가 바뀔 때만 적는다(30초마다 같은 줄이 쌓이지 않게).
    if (missing.length !== lastCount) { console.log(`${line} — 대기: ${missing.join(', ')}`); lastCount = missing.length; }
    if (Date.now() > deadline) {
      console.log(`시간 초과(${minutes}분). 아직 없는 것: ${missing.join(', ')}`);
      console.log('조사관이 죽은 것이 아닐 수 있다. herdr agent read <이름>으로 화면을 보고 README의 막힘 판단표대로 정한다.');
      return;
    }
    await sleep(30000);
  }
}

function cmdStatus() {
  const state = readState();
  console.log(`회의 집: ${state.home}${state.dir ? ` · 라운드: ${state.dir}` : ' · 라운드 없음'}`);
  if (!state.dir) return;
  const config = readConfig(state);
  const names = config.roles.map((r) => `${r.name}.md`);
  const want = { facts: names, opinions: [...names, 'supervisor.md'], votes: [...names, 'supervisor.md'] };
  for (const [sub, files] of Object.entries(want)) {
    const d = path.join(roundAbs(state), sub);
    const have = fs.existsSync(d) ? fs.readdirSync(d) : [];
    const missing = files.filter((f) => !have.includes(f));
    console.log(`${sub}: ${files.length - missing.length}/${files.length}${missing.length ? ` — 빠짐: ${missing.join(', ')}` : ''}`);
  }
  console.log(`final.md: ${fs.existsSync(path.join(roundAbs(state), 'final.md')) ? '있음' : '없음'}`);
  const panes = Object.keys(state.panes || {}).length;
  console.log(`조사관 pane: ${panes ? `${panes}개 기록됨` : '없음(setup 전 또는 teardown 뒤)'}`);
  if (panes) console.log(`  ${config.roles.map((r) => `${agentOf(state, r)}@${state.panes[r.name] || '?'}`).join(' ')}`);
}

function tallyVotes(state) {
  const votesDir = path.join(roundAbs(state), 'votes');
  if (!fs.existsSync(votesDir)) die('votes/ 가 없습니다.');
  const counts = new Map();
  const abstain = [];
  for (const file of fs.readdirSync(votesDir).filter((f) => f.endsWith('.md')).sort()) {
    const m = fs.readFileSync(path.join(votesDir, file), 'utf8').match(/^투표:\s*(.+?)\s*$/m);
    if (!m) { abstain.push(`${file}(형식 없음)`); continue; }
    const pick = m[1].replace(/\.md$/, '').trim();
    const voter = file.replace(/\.md$/, '');
    if (pick === '기권') { abstain.push(file); continue; }
    if (pick === voter) { abstain.push(`${file}(자기 투표 — 무효)`); continue; }
    counts.set(pick, (counts.get(pick) || 0) + 1);
  }
  return { ranked: [...counts.entries()].sort((a, b) => b[1] - a[1]), abstain };
}

function cmdTally() {
  const state = readState();
  const { ranked, abstain } = tallyVotes(state);
  console.log('득표:');
  for (const [name, n] of ranked) console.log(`  ${n}표  ${name}`);
  if (abstain.length) console.log(`기권/무효: ${abstain.join(', ')}`);
  if (ranked.length >= 2 && ranked[0][1] === ranked[1][1]) {
    console.log(`동점: ${ranked.filter(([, n]) => n === ranked[0][1]).map(([c]) => c).join(', ')} — 감독관이 근거를 밝히고 고른다.`);
  }
}

function cmdAdopt() {
  const state = readState();
  const pick = (pos[0] || '').replace(/\.md$/, '');
  if (!pick) die('채택할 후보 이름을 주세요: adopt <후보>');
  const final = path.join(roundAbs(state), 'final.md');
  const opinion = path.join(roundAbs(state), 'opinions', `${pick}.md`);
  if (!fs.existsSync(final)) die(`final.md가 없습니다: ${path.relative(ROOT, final)}`);
  if (!fs.existsSync(opinion)) die(`의견 파일이 없습니다: ${path.relative(ROOT, opinion)}`);
  const text = fs.readFileSync(final, 'utf8');
  if (!text.includes('<!-- ADOPTED-OPINION -->')) die('final.md에 <!-- ADOPTED-OPINION --> 자리가 없습니다.');
  fs.writeFileSync(final, text.replace('<!-- ADOPTED-OPINION -->', () => fs.readFileSync(opinion, 'utf8').trim()));
  console.log(`채택 의견 전문을 넣음: opinions/${pick}.md → final.md`);
}

// ---------------------------------------------------------------- compact

async function cmdCompact() {
  needHerdr();
  const state = readState();
  const config = readConfig(state);
  if ((config.kind || 'opencode') !== 'claude') {
    console.log('opencode 조사관은 컨텍스트가 차면 스스로 요약한다. 강제 정리는 하지 않는다.');
    return;
  }
  // Claude Code는 prompt로 보낸 "/compact"를 슬래시 명령으로 실행한다(실측). /clear 대신 요약을 남겨 이전 판단을 이어 쓴다.
  for (const role of config.roles) {
    const name = agentOf(state, role);
    const r = await submitAgent(name, '/compact');
    console.log(`  /compact ${r.code === 0 ? 'ok' : 'FAIL'}  ${name}`);
  }
}

// ---------------------------------------------------------------- wake

const WAKE_PID = path.join(STATE_DIR, 'wake.pid');
const WAKE_LOG = path.join(STATE_DIR, 'wake.log');
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function loopPrompt(state) {
  return `herdr-council 루프를 계속 돌려라. ${state.home}/README.md의 '반복' 절을 따르고, 먼저 node "${SCRIPT}" status로 상태를 본 뒤 다음 단계를 진행한다. 사용자에게 묻지 않는다.`;
}

async function cmdWake() {
  const sub = pos[0];
  const pid = fs.existsSync(WAKE_PID) ? Number(fs.readFileSync(WAKE_PID, 'utf8')) : null;
  if (sub === 'status') { console.log(pid && alivePid(pid) ? `도는 중 (pid ${pid}, 로그 ${WAKE_LOG})` : '멈춤'); return; }
  if (sub === 'stop') {
    if (pid && alivePid(pid)) { process.kill(pid); console.log(`멈춤 (pid ${pid})`); } else console.log('돌고 있지 않음');
    fs.rmSync(WAKE_PID, { force: true });
    return;
  }
  if (sub === 'start') {
    needHerdr();
    if (pid && alivePid(pid)) { console.log(`이미 도는 중 (pid ${pid})`); return; }
    const state = readState();
    if (!state.supervisorPane && !process.env.HERDR_PANE_ID) die('감독관 pane을 모릅니다. 감독관 pane에서 init 또는 setup을 먼저.');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const out = fs.openSync(WAKE_LOG, 'a');
    const child = spawn(process.execPath, [SCRIPT, 'wake', 'run', '--interval', String(opts.interval || 20), '--repo', ROOT], { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.writeFileSync(WAKE_PID, String(child.pid));
    console.log(`트리거 시작 (pid ${child.pid}, ${opts.interval || 20}분마다, 로그 ${WAKE_LOG}). 멈추기: wake stop`);
    return;
  }
  if (sub === 'run') {
    const minutes = Number(opts.interval || 20);
    for (;;) {
      await sleep(minutes * 60 * 1000);
      const state = readState();
      const pane = state.supervisorPane;
      const got = spawnSync('herdr', ['agent', 'get', pane], { encoding: 'utf8' });
      let status = 'unknown';
      try { status = JSON.parse(got.stdout).result.agent.agent_status; } catch {}
      if (status === 'idle' || status === 'done') {
        const r = spawnSync('herdr', ['agent', 'prompt', pane, loopPrompt(state)], { encoding: 'utf8' });
        console.log(`[${new Date().toLocaleString('ko-KR')}] ${r.status === 0 ? 'prompted' : 'prompt 실패'} (status=${status})`);
      } else console.log(`[${new Date().toLocaleString('ko-KR')}] skip (status=${status})`);
    }
  }
  die('wake <start|stop|status> [--interval 분]');
}

// ---------------------------------------------------------------- doctor

// setup 전에 무엇이 막힐지 본다. 화면은 나누지 않는다. 조사관 설정 파일(opencode)은 setup과 같게 준비한다.
function cmdDoctor() {
  const state = readState();
  const config = readConfig(state);
  const kind = config.kind || 'opencode';
  const line = (ok, msg) => console.log(`${ok ? '  ok ' : '  !! '} ${msg}`);
  line(true, `저장소 ${ROOT} · 회의 집 ${state.home}`);
  line(process.env.HERDR_ENV === '1', process.env.HERDR_ENV === '1' ? `herdr pane 안(${process.env.HERDR_PANE_ID || '?'})` : 'herdr pane 밖 — setup·research는 herdr 안에서');
  if (process.env.HERDR_ENV === '1') {
    const sup = spawnSync('herdr', ['agent', 'list'], { encoding: 'utf8' });
    let hasAgent = false;
    try { hasAgent = JSON.parse(sup.stdout).result.agents.some((a) => a.pane_id === process.env.HERDR_PANE_ID); } catch {}
    line(hasAgent, hasAgent ? '감독관 pane에 에이전트가 있다' : '감독관 pane에 에이전트가 없다 — 에이전트 세션에서 스킬로 부른다');
  }
  const cli = kind === 'claude' ? 'claude' : 'opencode';
  const ver = spawnSync(cli, ['--version'], { encoding: 'utf8' });
  line(ver.status === 0, ver.status === 0 ? `${cli} ${(ver.stdout || '').trim().split('\n')[0]}` : `${cli}를 찾지 못했다`);
  if (ver.status !== 0) return;
  const { args } = researcherArgs(state, config);
  if (kind === 'opencode' && args.includes('--agent')) line(true, 'opencode v1: --agent council-researcher로 띄운다');
  else if (kind === 'opencode') {
    line(true, 'opencode v2: --standalone + OPENCODE_CONFIG_CONTENT(default_agent=council-researcher)로 조사관 pane에만 준다 — 저장소 설정 파일은 쓰지 않는다');
    const legacy = legacyDefaultAgent();
    if (legacy) line(false, `${path.relative(ROOT, legacy.cfg)}에 예전 판이 넣은 default_agent=council-researcher가 남아 있다 — ${legacy.ours ? 'setup·teardown이 지운다' : '다른 설정과 섞여 있어 그 줄만 손으로 지운다'}`);
  }
  else line(true, 'claude: 훅을 끄고 조사관 경계를 시스템 프롬프트로 싣는다');
  console.log('  참고: opencode v2 조사관은 웹검색을 처음 쓸 때 동의 창("Allow OpenCode to search the web?")에서 멈춘다 — README 5절.');
}

// ---------------------------------------------------------------- revive

// 죽은 조사관만 제자리(기록한 pane)에 다시 띄운다. pane이 셸 프롬프트에 있어야 한다.
function cmdRevive() {
  needHerdr();
  const state = readState();
  const config = readConfig(state);
  const want = pos.length ? new Set(pos.join(',').split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const { kind, args, env: extraEnv = {} } = researcherArgs(state, config);
  const live = new Set(herdr(['agent', 'list']).result.agents.map((a) => a.name).filter(Boolean));
  let revived = 0;
  for (const role of config.roles) {
    if (want && !want.has(role.name)) continue;
    const agent = agentOf(state, role);
    const pane = state.panes?.[role.name];
    if (live.has(agent)) { if (want) console.log(`살아 있음: ${agent}`); continue; }
    if (!pane) { console.log(`pane 기록 없음: ${role.name} — setup부터`); continue; }
    // pane run은 JSON을 돌려주지 않으므로 herdr() 대신 직접 부른다.
    if (kind === 'opencode') {
      const env = { OPENCODE_DISABLE_AUTOUPDATE: '1', ...extraEnv };
      const exports = Object.entries(env).map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`).join('; ');
      spawnSync('herdr', ['pane', 'run', pane, exports], { encoding: 'utf8' });
    }
    try { startResearcher(agent, kind, pane, args, startTimeoutMs()); } catch (err) { die(`${agent} 다시 띄우기 실패(${pane}): ${err.message}`); }
    console.log(`다시 띄움: ${agent} → ${pane}`);
    revived += 1;
  }
  console.log(revived ? `${revived}명 다시 띄움. 그 조사관에게만 단계를 다시 보낸다: research|vote --only <역할,…>` : '다시 띄울 조사관이 없다.');
}

// ---------------------------------------------------------------- teardown

function cmdTeardown() {
  needHerdr();
  const state = readState();
  for (const [name, pane] of Object.entries(state.panes || {})) {
    const r = spawnSync('herdr', ['pane', 'close', pane], { encoding: 'utf8' });
    console.log(`${r.status === 0 ? '닫음' : '이미 없음'}: ${name} (${pane})`);
  }
  writeState({ ...state, panes: {} });
  cleanLegacyDefaultAgent();
}

// ---------------------------------------------------------------- main

switch (cmd) {
  case 'new': cmdNew(); break;
  case 'init': cmdInit(); break;
  case 'preflight': cmdPreflight(); break;
  case 'setup': cmdSetup(); break;
  case 'research': await cmdResearch(); break;
  case 'vote': await cmdVote(); break;
  case 'wait': await cmdWait(); break;
  case 'status': cmdStatus(); break;
  case 'tally': cmdTally(); break;
  case 'adopt': cmdAdopt(); break;
  case 'compact': await cmdCompact(); break;
  case 'wake': await cmdWake(); break;
  case 'doctor': cmdDoctor(); break;
  case 'revive': cmdRevive(); break;
  case 'teardown': cmdTeardown(); break;
  default:
    die('명령: new | init "<주제>" | preflight | setup | research | vote | wait <research|vote> [분] | status | tally | adopt <후보> | compact | wake <start|stop|status> | doctor | revive [역할,…] | teardown');
}
