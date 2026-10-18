# 수집 경로 — 웹 플랫폼 8개 프리셋

> 조사관 8명이 Reddit, X, 티스토리, Threads, 블라인드, 클리앙, Quora, LinkedIn을 하나씩 맡는다. 이 표는 처음 잡은 값이다. 감독관이 라운드 끝마다 막힘 기록(`<라운드>/errors/`)을 보고 고친다.
> 필요한 도구: Aside 브라우저와 aside-browser 스킬(기본 수집), `opencli`, `curl`(Jina 읽기). 없는 도구의 길은 `council preflight`가 죽은 길로 적는다.

## 1. 기본은 Aside 브라우저다

Aside 안에서 로그인해 둔 사이트는 그 상태로 검색할 수 있다. 로그인은 사이트마다 따로이고 사용자만 한다. 구글·duckduckgo 같은 검색엔진을 거치지 않는 것이 요점이다(봇 확인 화면으로 자주 막힌다).

조사관이 처음 할 일:

1. aside-browser 스킬을 읽고 `aside guide`를 실행해 사용법을 읽는다.
2. 조사는 `aside exec "<할 일>"`로 맡긴다. 화면이나 DOM을 직접 봐야 할 때만 `aside repl`(그 전에 `aside guide repl`).
3. 출력에는 브라우저 에이전트의 생각 과정까지 섞여 길게 나온다. 파일로 받아 끝부분만 읽는다.

```
aside exec "<할 일>" < /dev/null > "$SCRATCH/aside-01.txt" 2>&1
tail -60 "$SCRATCH/aside-01.txt"
```

과제문에 적을 것:

- 어느 사이트 안에서 무엇을 검색할지. 검색어는 그 플랫폼 사람들이 쓰는 말로 3~5개(문장보다 낱말 2~3개, 따옴표 구절이나 `OR`는 질의 하나에 하나만).
- 돌려받을 것: 글마다 URL, 제목, 글쓴이, 날짜, 본문에서 그대로 옮긴 인용, 반응 수. 댓글은 "전체 M개 중 N개를 봤다"까지.
- "읽기만 하라. 글쓰기·댓글·좋아요·팔로우·메시지·설정 변경·결제·로그아웃을 하지 마라."
- "봇 확인 화면이나 로그인 요구가 나오면 풀려고 하지 말고 그 사실만 보고하라."
- "사람 검색·프로필 조회 도구를 쓰지 마라", "투표 결과 보기 같은 로그인 창을 부르는 단추를 누르지 마라."
- 끝에 아래 [탭 규칙] 묶음을 그대로.

사용 규칙:

- 조사관 한 명이 Aside 과제를 한 번에 하나만 돌린다. 과제 하나는 검색 3~5개와 글 5~10개 읽기 정도. 한 플랫폼에 라운드당 과제 8개를 넘기지 않는다.
- 과제 하나는 보통 5~10분, 출력은 100~400KB다. 출력 파일 크기가 3분 넘게 안 자라면 `aside session list`로 보고, 멈춰 있으면 `aside session stop <id>` 뒤 다른 길로 간다. 오래 걸리는 과제는 `nohup` 백그라운드로 보내고 크기를 폴링한다.
- `--permission full-access`를 쓰지 않는다.

### 1-1. 연 탭은 적어 두었다가 닫는다 (탭 장부)

`aside exec`로 연 탭은 그 Aside 에이전트가 닫지 않으면 과제가 끝난 뒤에도 남는다. 다른 세션에서는 그 탭을 닫을 수 없고, 연 세션을 다시 불러야 닫힌다. 그래서 세션 id와 탭 id를 둘 다 적는다. 8명이 같은 브라우저를 쓰므로 targetId는 openTab 직후 바로 적는다.

**(1) 모든 `aside exec` 과제문 끝에 이 묶음을 그대로 붙인다.**

```
[탭 규칙 — 반드시 지켜라]
1. 이미 열려 있는 탭은 건드리지 마라. 붙지도, 다른 주소로 보내지도, 닫지도 마라. 새 탭은 openTab()으로만 연다.
2. 탭을 열 때마다 그 탭의 targetId를 네 목록에 적어라.
3. 다 읽은 탭은 바로 closeTab()으로 닫아라. 동시에 열어 두는 탭은 3개를 넘기지 마라.
4. 로그인 요구나 봇 확인 화면이 뜬 탭도 닫아라. 사용자를 위해 남겨 두지 마라.
5. 끝내기 전에 네 목록의 탭을 전부 닫고, listBrowserTabs()로 네 id가 하나도 남지 않았는지 확인해라.
6. 보고 맨 끝에 아래 세 줄을 적어라.
TABS_OPENED=<연 탭 id들, 쉼표로>
TABS_CLOSED=<닫은 탭 id들>
TABS_REMAINING=<남은 탭 id들, 없으면 none>
```

**(2) 과제마다 장부 `<라운드>/tabs/<조사관>.md`에 한 줄을 적는다.** 세션 id는 출력 첫 줄의 `created new session: <id>`에 있다.

```
SID=$(grep -a -o "created new session: [A-Za-z0-9]*" "$SCRATCH/aside-01.txt" | awk '{print $4}')
grep -a "TABS_OPENED=\|TABS_CLOSED=\|TABS_REMAINING=" "$SCRATCH/aside-01.txt" | tail -3
```

| 과제 | 세션 id | 연 탭 | 닫은 탭 | 남은 탭 | 처리 |
|---|---|---|---|---|---|

**(3) 남은 탭이 있으면**(`TABS_REMAINING`이 `none`이 아님, 세 줄이 없음, `session stop`으로 끊음) 그 세션을 다시 불러 닫고 직접 확인한다.

```
aside session resume "$SID" "네가 이 세션에서 연 탭을 전부 closeTab()으로 닫아라. 다른 탭은 건드리지 마라. 닫은 뒤 listBrowserTabs()로 확인하고 TABS_REMAINING 한 줄로 답해라." < /dev/null | tail -3
aside repl "const ids=['<id1>','<id2>']; const t=await listBrowserTabs(); console.log('남은 것=' + ids.filter(i=>t.some(x=>x.targetId===i)).join(','));" < /dev/null | tail -2
```

**(4) 장부에 없는 탭은 닫지 않는다.** 사용자가 직접 연 탭일 수 있다. 막힘 기록에 "주인 모를 탭"으로만 적는다.

**(5) 라운드가 끝나면 감독관이** 장부 8개의 탭 id를 모아 (3)의 확인 명령으로 남은 것이 없는지 보고, 결과를 `final.md`에 한 줄로 적는다.

## 2. 플랫폼별 경로

앞에서부터 쓴다. 표에 없는 길을 찾았으면 써도 된다. 썼으면 facts 맨 앞과 막힘 기록에 적는다.

| 조사관 | 찾기 | 읽기 | 쓰지 않는다 |
|---|---|---|---|
| reddit | Aside로 reddit.com 안 검색 → `opencli reddit search`(전역, 그다음 `--subreddit`) | Aside 또는 `opencli reddit read <post-id> -f json` | Jina(403) |
| twitter | Aside로 x.com 안 검색(최신·인기 탭) → `opencli twitter search` 라운드당 20건 안쪽 | Aside로 글과 답글. 긴 글은 `opencli twitter article <id>` | 논문 어휘 질의, Jina, `opencli twitter thread`, `profile`의 숫자 |
| tistory | Aside로 다음(search.daum.net) 블로그 탭에서 질의 끝에 `site:tistory.com`(한 페이지 10~15건) → 웹 검색 | Aside 또는 Jina | 티스토리에는 통합 검색이 없다 |
| threads | Aside로 threads.com 검색·태그 페이지(로그아웃이면 앞쪽 몇 건만 오고 여러 낱말 질의는 자주 빈다 — 이때의 0건은 "없다"가 아니다. 낱말 하나·태그 페이지를 쓴다) → 웹 검색 | Aside로 글과 답글(스크롤해서 더 불러오기) | Jina로 검색·태그 페이지, 직접 curl |
| blind | Aside로 teamblind.com 안 검색(검색창에 입력하고 Enter를 눌러야 결과가 렌더된다) → 토픽·태그 페이지 | Aside. 댓글과 투표 집계까지 | 결과 주소 직접 열기(빈 화면) |
| clien | Aside로 clien.net 통합 검색 → Jina: `https://r.jina.ai/https://www.clien.net/service/search?q=<질의>&sort=accuracy` | Aside 또는 Jina(댓글 전부 옴, 50KB 안팎) | 논제의 개념어 그대로 질의 |
| quora | Aside로 quora.com 안 검색(로그인 필요) → 웹 검색에 "Quora: <질문 문장>" 꼴로 물어 질문 URL 받기(`site:quora.com`) | Aside로 질문 페이지 | Jina로 Quora 검색 페이지(로그인 벽), 회원가입 벽 글 |
| linkedin | Aside로 linkedin.com 게시물 검색(콘텐츠 탭, 로그인 필요) → 웹 검색 | Aside 또는 Jina로 개별 포스트·pulse 글 | `opencli linkedin search`(채용공고 검색), `timeline`, `posts`, `people-search`(계정의 월 한도를 쓴다), `opencli web read` |

공통:

- 논문·실험·수치는 쓸 수 있는 웹 검색(exa 등, 결과 수는 6 아래로)으로 찾고, 인용 전에 원문을 연다.
- opencode v2의 내장 웹검색은 처음 쓸 때 동의 창("Allow OpenCode to search the web?")을 띄우고 그동안 멈춘다. 조사관은 그 창에 답하지 않는다(감독관이 사용자에게 알린다).
- 구글·duckduckgo·brave 검색은 마지막 수단이다. 조사관 한 명당 라운드에 5건을 넘기지 않는다.
- `opencli web read`는 `--url`을 붙여야 돌고, 로그인 벽이 있는 사이트에서는 로그인 페이지를 성공으로 돌려주니 쓰지 않는다. PDF는 거부한다.
- 출판사 403·CAPTCHA(science.org·tandfonline·wiley·dl.acm·informs·ssrn·ScienceDirect): PMC·arXiv·저자 공개 PDF·기관 리포지토리로 대체한다. 5MB가 넘는 PDF는 `curl`+`pdftotext`.
- X 검색은 라운드당 20건 안쪽. 한도를 떠보는 연속 호출을 하지 않는다. `opencli linkedin people-search`를 쓰지 않는다.

## 3. 실패를 읽는 법

| 받은 것 | 읽는 법 | 다음 행동 |
|---|---|---|
| Aside가 봇 확인·로그인 요구를 보고 | 그 사이트의 그 길이 막혔다 | 풀려고 하지 않는다. 막힘 기록에 적고 표의 다음 길로 간다 |
| `opencli google search`의 `NOT_FOUND` | 알 수 없음. 차단일 때도 이 코드가 온다 | 질의를 바꾸지 않는다. `"test"`로 대조한다. 대조도 실패하면 그 길은 닫혔다 |
| `TIMEOUT` | 차단으로 넘어가는 중간 단계로 보인다 | 대기 시간을 늘리지 않는다 |
| brave·duckduckgo `EMPTY_RESULT` | `site:` 조건이 안 먹었을 수 있다 | `site:`를 빼고 한 번 대조한다 |
| X `HTTP 429` | 계정 할당량이 찼다 | 그 라운드의 X 검색을 멈춘다 |
| Jina 응답의 `Warning: ... CAPTCHA`, `Title: Just a moment...`, `Title: Error`, `Sign in` | 본문이 아니다 | 인용하지 않는다 |
| `opencli doctor`가 정상 | 검색이 산다는 뜻이 아니다 | 근거로 쓰지 않는다 |
