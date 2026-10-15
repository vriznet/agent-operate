#!/usr/bin/env node
// orca-agent-talk 도우미: Orca 패널의 에이전트(claude·codex 등)를 찾고, 말을 보내고, 답이 끝날 때까지 기다린다.
//   node talk.mjs list [--worktree <경로>]
//   node talk.mjs status --terminal <핸들>
//   node talk.mjs send --terminal <핸들> (--text "<한 줄>" | --file <메시지 파일>) [--queue]
//   node talk.mjs wait --terminal <핸들> [--reply <답 파일>] [--timeout-s 1800] [--poll-s 10]
// 메시지 본문은 길면 파일로 쓰고 경로만 보낸다(셸 이스케이프·TUI 붙여넣기 깨짐을 피한다).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const sleep = (s) => spawnSync('sleep', [String(s)]);
const ORCA = process.env.ORCA_BIN || 'orca';

function orca(args) {
  const r = spawnSync(ORCA, [...args, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  if (!j || j.ok === false) throw new Error(`orca ${args.join(' ')} 실패: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  return j.result;
}
const terminals = () => orca(['terminal', 'list']).terminals;
const find = (h) => { const t = terminals().find((x) => x.handle === h); if (!t) throw new Error(`터미널 없음: ${h} (terminal list로 다시 찾을 것)`); return t; };
const screen = (h) => (orca(['terminal', 'read', '--terminal', h, '--screen']).terminal?.tail || []);

// 바쁨 신호(실측 2026-10-15, Orca·Claude Code 2.1·Codex 0.162):
// - 패널 제목 맨 앞이 점자 스피너(⠋⠙⠹…, Codex)나 ◐◓◑◒(Claude)면 일하는 중, ✳ 또는 없음이면 쉼.
// - 화면 아래쪽에 "esc to interrupt"가 보이면 일하는 중(둘 다).
const SPIN = /^[⠀-⣿◐◓◑◒]/;
function busy(h) {
  const t = find(h);
  const tail = screen(h).slice(-12).join('\n');
  // Codex 앱 서버가 끊기면 화면에 이 글이 남고 입력이 처리되지 않는다(실측). 다시 열어야 한다.
  const dead = /Server connection could not be restored|Reconnect failed/i.test(tail);
  return { busy: !dead && (SPIN.test(t.title || '') || /esc to interrupt/i.test(tail)), dead, title: t.title, agent: t.agentIdentity || null, tail };
}

if (cmd === 'list') {
  const wt = opt('worktree');
  for (const t of terminals().filter((x) => !wt || x.worktreePath === wt)) {
    console.log(JSON.stringify({ handle: t.handle, agent: t.agentIdentity || null, title: t.title, busy: SPIN.test(t.title || ''), worktree: t.worktreePath, writable: t.writable }));
  }
} else if (cmd === 'status') {
  const s = busy(opt('terminal'));
  console.log(JSON.stringify({ busy: s.busy, dead: s.dead, agent: s.agent, title: s.title }));
  console.log(s.tail);
} else if (cmd === 'send') {
  const h = opt('terminal');
  let text = opt('text');
  const file = opt('file');
  if (file) {
    if (!fs.existsSync(file)) throw new Error(`메시지 파일 없음: ${file}`);
    text = `${fs.realpathSync(file)} 파일을 읽고 그 안의 요청을 따라라.`;
  }
  if (!text || /\n/.test(text)) throw new Error('--text는 한 줄로. 여러 줄이나 긴 글은 --file로 보낸다');
  const s = busy(h);
  // 일하는 중에 보내면 큐에 쌓이거나(Codex) 진행 중인 턴에 끼어든다(Claude). 기본은 거절.
  if (s.dead) { console.error(`보내지 않음: ${h}의 에이전트가 서버 연결을 잃었다. 다시 열어야 한다(Codex: Ctrl+C 뒤 화면에 나온 codex resume <id>)`); process.exit(6); }
  if (s.busy && !flag('queue')) { console.error(`보내지 않음: ${h}가 일하는 중이다(${s.title}). 끝나길 기다리거나 --queue`); process.exit(3); }
  const r = spawnSync(ORCA, ['terminal', 'send', '--terminal', h, '--text', text, '--enter', '--wait-submit', '20'], { encoding: 'utf8' });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  if (s.busy && flag('queue')) { console.log('큐에 넣음: 상대가 일하는 중이라 지금 턴이 끝난 뒤 읽는다(턴 시작이 관측되지 않는 것이 정상)'); process.exit(0); }
  if (!/turn_started|submitted/.test(r.stdout)) {
    // Enter가 먹혔는지 모를 때 Orca가 요청 번호를 준다. 같은 번호로 다시 부르면 글을 또 넣지 않고 영수증만 다시 받는다.
    const id = (r.stdout + r.stderr).match(/--retry-request\s+([0-9a-f-]{36})/)?.[1];
    console.error(`시작을 관측하지 못함 — status로 확인할 것. 같은 글을 새로 보내지 말고${id ? `, 확인하려면 orca terminal send --terminal ${h} --text <같은 글> --enter --retry-request ${id} --wait-submit 20` : ''}`);
    process.exit(4);
  }
} else if (cmd === 'wait') {
  // 끝 판정: (답 파일을 정했으면 그 파일이 생김) + 연속 두 번 쉼. send 직후 '쉼'은 아직 시작 전일 수 있어 한 번은 바쁨을 보거나 답 파일을 본 뒤에만 믿는다.
  const h = opt('terminal'), reply = opt('reply'), timeout = Number(opt('timeout-s', 1800)), poll = Number(opt('poll-s', 10));
  const t0 = Date.now(); let sawBusy = false, idle = 0, s;
  while ((Date.now() - t0) / 1000 < timeout) {
    s = busy(h);
    if (s.busy) { sawBusy = true; idle = 0; } else idle++;
    const replied = !reply || fs.existsSync(reply);
    if (replied && idle >= 2 && (sawBusy || (reply && fs.existsSync(reply)))) {
      console.log(JSON.stringify({ done: true, seconds: Math.round((Date.now() - t0) / 1000), reply: reply || null }));
      console.log(s.tail); process.exit(0);
    }
    sleep(poll);
  }
  console.log(JSON.stringify({ done: false, timeout: true, sawBusy, reply: reply || null, replyExists: reply ? fs.existsSync(reply) : null }));
  console.log(s?.tail || ''); process.exit(5);
} else {
  console.error('명령: list | status | send | wait'); process.exit(2);
}
