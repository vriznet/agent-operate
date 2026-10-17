---
name: herdr-council
description: herdr 안에서 현재 pane을 3x3으로 나눠 조사관 8명(opencode 또는 Claude Code)을 세우고, 감독관(이 세션)까지 9명이 라운드마다 조사 → 의견 → 투표 → final.md 확정 → 다음 주제를 반복하는 회의(카운슬)를 열고 굴리고 닫는다. 원 질문에서 멀어지지 않게 헌장·주제 관문·복귀 라운드·누적 답을 지킨다. "/agent-operate:herdr-council", "카운슬 열어", "9명 회의 돌려", "회의 재개해/멈춰", "다음 라운드", "카운슬 상태" 같은 요청에 사용한다. 이미 열린 에이전트 한두 명에게 일을 맡기거나 대화시킬 거면 `orca-agent-talk`, 워크트리마다 에이전트 4개를 띄울 거면 `herdr-worktree-quad`를 쓴다.
---

# herdr 카운슬 (9인 회의)

주제 하나를 조사관 8명이 저마다 다른 자리(기본 프리셋은 웹 플랫폼 8개)에서 조사하고, 감독관까지 9명이 의견을 내 투표로 하나를 고른다. 그 결과를 헌장에 비추어 다음 주제를 만들고, 사용자가 멈출 때까지 반복한다.

**이 세션이 감독관이다.** 판단(주제, 감독관 의견, 투표, `final.md`, 다음 주제, 막힘 판단)은 감독관이 하고, 스크립트는 폴더·pane·프롬프트·집계(손발)만 맡는다. 감독관은 조사하지 않고 조사관 대신 답을 만들지 않는다.

```
┌──────────┬──────────┬──────────┐
│ 감독관   │ 조사관 1 │ 조사관 2 │
├──────────┼──────────┼──────────┤
│ 조사관 3 │ 조사관 4 │ 조사관 5 │
├──────────┼──────────┼──────────┤
│ 조사관 6 │ 조사관 7 │ 조사관 8 │
└──────────┴──────────┴──────────┘
```

명령은 모두 `node "${CLAUDE_SKILL_DIR}/scripts/council.mjs" <명령>`이다. 아래에서는 `council <명령>`으로 줄여 쓴다. 작업 저장소 루트(감독관 pane)에서 돌린다.
`${CLAUDE_SKILL_DIR}`는 이 SKILL.md가 있는 폴더다. Claude Code가 아닌 에이전트(opencode·Codex 등)에서 글자 그대로 보이면 이 SKILL.md 파일이 있는 폴더의 절대 경로로 바꿔 쓴다.

## 전제 확인

1. herdr pane 안인지: `test "$HERDR_ENV" = 1`. 아니면 사용자에게 알리고 멈춘다.
2. git 저장소 안인지(회의 기록과 상태를 저장소에 둔다).
3. 조사관 에이전트 CLI가 깔려 있는지: 기본은 `opencode`, `council.json`의 `kind`가 `claude`면 `claude`.
4. 기본 프리셋(`web-platforms-8`)의 수집 도구: Aside 브라우저와 aside-browser 스킬, `opencli`, `curl`. 없으면 `preflight`가 죽은 길로 적고, 조사관은 다음 길로 간다.
5. 화면이 9분할을 견딜 만큼 넓은지. 좁으면 사용자에게 한 번 묻는다.

## 처음 열 때

```bash
council new [--home <폴더>] [--preset web-platforms-8] [--kind opencode|claude]
```

- 회의 집(`<home>`)을 만든다. 기본 위치는 orbit 하네스가 있으면 `<문서 볼트>/council/`, 없으면 저장소 루트의 `council/`. 이미 있으면 그대로 쓴다.
- 안에 생기는 것: `README.md`(운영 규칙 — 감독관과 조사관이 모두 따른다), `charter.md`(헌장), `cumulative.md`(누적 답), `council.json`(조사관 8명·점검 명령·제출 간격), `researcher.md`(조사관 경계), `collection.md`(프리셋의 수집 경로).
- **라운드 원자료(facts·opinions·votes·tabs·errors·topic)는 저장소의 git 무시 목록(`.git/info/exclude`)에 넣는다.** 커밋 대상은 `charter.md`·`cumulative.md`·각 라운드 `final.md`뿐이다. 원자료에는 수집한 글의 인용과 작업 맥락이 그대로 들어간다.
- 그다음 **헌장을 사용자와 함께 채운다**(최초 질문·범위·답의 형태·종료 조건). 사용자가 승인하면 `상태: \`승인됨\``으로 바꾼다. 승인 전에는 `init`이 라운드를 열지 않는다. 승인 뒤에는 헌장을 고치지 않는다.
- 조사관 구성을 바꾸려면 `council.json`의 `roles`(8개 — `name`은 herdr 이름 규칙 `[a-z][a-z0-9_-]{0,31}`, `label`, `strength`)를 고친다. 그때는 `collection.md`도 그 자리에 맞게 고친다.

## 한 라운드 (감독관이 판단하는 지점)

1. **주제** — `council init "<주제>"` 뒤 `topic.md`의 원 질문 연결 3칸(채우는 부분·바뀌는 점·거리)과 하위 질문(문헌·플랫폼)을 채운다. 약하면 주제를 다시 잡는다(관문).
2. **조사** — `council preflight` → `council setup`(첫 라운드만, 살아 있으면 그대로) → `council research` → `council wait research 20`(백그라운드로 걸고 끝나면 이어 간다).
3. **감독관 의견** — 조사 결과를 **보기 전에** `<라운드>/opinions/supervisor.md`를 쓴다.
4. **투표** — `council vote` → `council wait vote 20`(조사관 8명의 표만 기다린다) → 감독관도 의견을 전부 읽고 `votes/supervisor.md`(첫 줄 `투표: <후보>`) → `council tally`. 동점이면 감독관이 이유를 적고 고른다.
5. **확정** — `final.md`를 쓴다(README 3절: 결과표, 근거, 투표자별 근거, 예외, 드러난 것·못 본 것, **원 주제 세 줄**). 채택 의견 전문은 `<!-- ADOPTED-OPINION -->` 자리를 두고 `council adopt <후보>`.
6. **마감** — `cumulative.md`를 갱신하고, 막힘 기록(`<라운드>/errors/`)을 보고 `collection.md`를 고친다. 프로젝트의 커밋 관례가 있으면 따르되 커밋 대상은 헌장·누적 답·final뿐이다.
7. **다음 주제** — `final.md`의 풀린 곳 + 헌장·누적 답으로 후보를 만들고, "원 질문에 더하는 것" 한 줄이 약한 후보는 버린다. 3라운드마다, 또는 원 질문 연결이 두 라운드 연속 약하면 복귀 라운드(헌장의 질문 그대로)를 연다. 사용자에게 묻지 않고 1로 돌아간다.

결과 보고는 표로 한다(원시 출력을 그대로 보이지 않는다): 라운드, 주제, 모인 의견 수, 득표, 채택, 원 질문에 더한 것, 다음 주제.

## 반복과 정지

- 사용자가 계속 돌리라고 하면 `council wake start [--interval 20]`. 감독관 pane이 쉬고 있을 때마다 README 7절 지시를 넣는다. 사용자 지시 없이 반복하는 것이 이 회의의 원칙이다.
- 사용자가 "멈춰"라고 하면: `council wake stop`, 라운드를 새로 열지 않는다. 진행 중인 조사관 턴은 끊지 않는다(끊으라고 하지 않는 한).
- 정리: `council teardown`으로 조사관 pane을 닫는다. 감독관 pane은 남긴다. 회의 집과 상태는 남아서 다음에 `setup`으로 다시 세울 수 있다.
- 상태: `council status`(라운드·산출물·final·pane), `council wake status`.

## 막혔을 때 (요약 — 상세는 README 5절)

- 조사관이 멈추거나 산출물이 20분 넘게 없으면 `herdr agent read <이름> --source recent-unwrapped --lines 80`으로 화면을 본다. 그 조사관에게만 `council research --only <역할,…>`(투표면 `vote --only`)로 다시 보내고, 같은 곳에서 또 멈추면 그 라운드는 기권시킨다. 전원에게 다시 던지지 않는다(일하는 중인 조사관에게 같은 지시가 또 쌓인다).
- 조사관이 꺼져 셸로 돌아갔으면 `council revive [역할,…]`로 제자리 pane에 다시 띄운 뒤 `--only`로 보낸다. 스크립트는 보내기 직전마다 에이전트가 살아 있는지·시작 창(업데이트 완료 등)이 없는지 보고, 아니면 보내지 않는다 — 꺼진 pane에 보내면 지시가 셸에 그대로 입력된다(실측).
- 조사관 pane의 시작 창(업데이트 완료·승인·신뢰)은 대신 누르지 않는다. opencode의 "Update Complete — restart" 창을 Esc로 닫으면 opencode가 꺼진다(실측). 그래서 `setup`·`revive`는 opencode 조사관 pane에서 자동 업데이트를 끈다(`OPENCODE_DISABLE_AUTOUPDATE=1`).
- 같은 herdr 서버에서 다른 회의가 같은 조사관 이름을 쓰고 있으면 `setup`이 이름 뒤에 `-<저장소 이름>`을 붙인다(파일 이름은 역할 이름 그대로). `herdr agent read`에는 붙은 이름을 쓴다(`council status`·`setup` 출력에 나온다).
- 조사관 컨텍스트가 넘치면 `council compact`(claude는 `/compact`, opencode는 자동 압축).
- 의견이 5개 이상이면 투표로 넘어간다. 5개 미만이면 같은 주제로 한 번 더, 그래도 안 되면 모인 것으로 끝낸다.
- 조사관 pane에 권한 승인·폴더 신뢰 질문이 보이면 대신 답하지 않고 사용자에게 알린다.

## 하지 않는 것

- 주제·기준·판정의 내용을 스크립트에 맡기지 않는다. 감독관이 정하고 이유를 남긴다.
- 회의 결과를 위키·ADR 같은 프로젝트 문서로 올리기, 원격 푸시, 기록 삭제 — 사용자가 말할 때만.
- 사용자 계정으로 글·댓글·좋아요·팔로우·메시지 남기기, 계정 설정 변경, 결제 — 조사관에게도 금지(`researcher.md`).
- 감독관 자신의 작업 일지는 저장소 규칙대로 남긴다. 조사관은 작업 일지·할일·ADR·위키를 건드리지 않는다.
- 이 스킬이 띄우지 않은 pane·에이전트는 닫지 않는다.
