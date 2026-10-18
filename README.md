# agent-operate

herdr·Orca 같은 터미널 멀티플렉서 안에서 코딩 에이전트(Claude Code·Codex·OpenCode·Hermes)를 띄우고 다루는 Claude Code 스킬 모음이다. Claude Code 플러그인 마켓플레이스 형식이라 명령 두 줄로 다른 맥에 설치한다.

## 들어 있는 스킬

| 스킬 | 부르는 이름 | 하는 일 | 필요한 도구 |
|---|---|---|---|
| herdr-worktree-quad | `/agent-operate:herdr-worktree-quad` | 현재 레포에 워크트리 4개(`<레포>-claude/-codex/-opencode/-hermes`)를 만들고, 현재 pane 오른쪽을 2×2로 나눠 각 워크트리에서 에이전트를 권한 우회 모드로 띄운다. 직접 불러야만 실행된다. | herdr, git, Node.js, claude·codex·opencode·hermes CLI |
| orca-split-claude-subagent | `/agent-operate:orca-split-claude-subagent` | Orca 터미널 오른쪽을 패널 N개로 갈라 각 패널에 Claude 세션을 띄우고 브리프 파일로 일을 맡긴다. 진행 과정을 눈으로 본다. | Orca, claude CLI |
| herdr-split-opencode-subagent | `/agent-operate:herdr-split-opencode-subagent` | herdr pane 오른쪽을 칸 N개로 갈라 각 칸에 opencode 세션(권한 자동 승인 `--auto`)을 띄우고 브리프 파일로 일을 맡긴다. orca-split-claude-subagent의 herdr·opencode판. 완료 감시·닫기 명령이 있다. | herdr, Node.js, opencode CLI |
| orca-split-codex-image | `/agent-operate:orca-split-codex-image` | Orca 패널에 Codex를 띄워 대화 맥락으로 쓴 이미지 브리프를 넘기고, Codex 내장 이미지 생성으로 그림을 만든 뒤 Claude가 검수한다. | Orca, codex CLI(0.149 이상) |
| orca-split-codex-review | `/agent-operate:orca-split-codex-review` | Orca 패널에 Codex를 띄워 적대적 코드 검증을 왕복한다. 오가는 원문이 패널에 그대로 보인다. | Orca, codex CLI |
| orca-agent-talk | `/agent-operate:orca-agent-talk` | Orca에 이미 열린 에이전트 패널(Claude·Codex 등)에 `orca terminal send`로 일을 맡기거나, 에이전트끼리 대화를 시킨다. 한 번 맡기고 답을 받거나, 합의·완료·사용자 멈춤까지 계속 주고받는다. 메시지와 답은 작업 저장소의 `.orca-talk/`에 파일로 남기고, 이 폴더는 그 저장소의 git 무시 목록(`.git/info/exclude`)에 넣어 커밋에 섞이지 않게 한다. | Orca, Node.js |
| herdr-council | `/agent-operate:herdr-council` | herdr pane을 3x3으로 나눠 조사관 8명(opencode 또는 Claude Code)을 세우고, 감독관까지 9명이 조사 → 의견 → 투표 → `final.md` 확정 → 다음 주제를 반복한다. 헌장·주제 관문·복귀 라운드·누적 답으로 원 질문에서 멀어지지 않게 한다. 기본 프리셋은 웹 플랫폼 8개(Reddit·X·티스토리·Threads·블라인드·클리앙·Quora·LinkedIn). 라운드 원자료는 git 무시 목록에 넣고 헌장·누적 답·final만 커밋한다. | herdr, Node.js, git, opencode 또는 claude CLI(기본 프리셋은 Aside·aside-browser 스킬·opencli·curl) |
| update | `/agent-operate:update` | 이 맥에 깔린 agent-operate를 최신 판으로 올린다. Claude Code 플러그인이면 마켓플레이스와 플러그인을, skills CLI로 opencode·Codex 등에 깔렸으면 그 스킬들을 갱신하고, 전·후 판과 재시작 필요 여부를 알린다. 직접 불러야만 실행된다. | Node.js, claude CLI 또는 npx |

플러그인 스킬은 앞에 플러그인 이름(`agent-operate:`)이 붙는다. 이 접두어는 뺄 수 없다.

## 설치

Claude Code 세션 안에서:

```
/plugin marketplace add vriznet/agent-operate
/plugin install agent-operate@agent-operate
```

셸에서:

```bash
claude plugin marketplace add vriznet/agent-operate
claude plugin install agent-operate@agent-operate
```

설치한 뒤 Claude Code를 다시 시작하면 스킬이 보인다.

### opencode·Codex 등 다른 에이전트

Claude Code 플러그인은 Claude Code만 읽는다. opencode·Codex 같은 다른 에이전트에는 같은 저장소를 [skills CLI](https://github.com/vercel-labs/skills)로 깐다(`~/.agents/skills`에 받고 각 에이전트 폴더에 링크한다).

```bash
npx skills add vriznet/agent-operate -g -a opencode -a codex -y          # 스킬 전부
npx skills add vriznet/agent-operate -g -a opencode -s herdr-council -y   # 하나만
npx skills update -g                                                       # 갱신
```

- **Claude Code에는 skills CLI로 깔지 않는다**(`-a claude-code`를 빼고 에이전트를 골라 준다). 플러그인과 함께 깔면 `/herdr-council`과 `/agent-operate:herdr-council`처럼 두 벌로 보인다.
- 스킬 글 속 호출 이름(`/agent-operate:<스킬>`)은 Claude Code 기준이다. 다른 에이전트에서는 스킬 이름(`herdr-council` 등)으로 부른다.
- 스크립트가 있는 스킬은 `${CLAUDE_SKILL_DIR}`로 자기 폴더를 가리킨다. Claude Code만 이 값을 실제 경로로 바꿔 주므로, 다른 에이전트에서는 SKILL.md가 있는 폴더 경로로 바꿔 쓰라고 스킬마다 적어 두었다.
- `herdr-council`의 조사관을 opencode v2로 띄우면, v2 TUI에 `--agent` 플래그가 없어서 조사관 pane만 `--standalone`과 환경변수 `OPENCODE_CONFIG_CONTENT`로 조사관 에이전트를 고른다. 저장소 설정 파일은 쓰지 않아 다른 opencode 세션에는 영향이 없다. 자세한 것은 그 스킬의 SKILL.md.

### 여러 맥에 같은 설정 두기

`~/.claude/settings.json`에 아래 두 항목을 넣어 두면 마켓플레이스와 사용 설정이 함께 따라간다. 처음 한 번은 그 맥에서 `claude plugin install agent-operate@agent-operate`를 실행해야 내려받는다.

```json
{
  "extraKnownMarketplaces": {
    "agent-operate": {
      "source": { "source": "github", "repo": "vriznet/agent-operate" }
    }
  },
  "enabledPlugins": {
    "agent-operate@agent-operate": true
  }
}
```

### 갱신

Claude Code에서 `/agent-operate:update`를 부르면 아래 일을 대신 하고 결과를 알려 준다(skills CLI로 깐 스킬까지 함께 갱신한다).

직접 만든 마켓플레이스는 자동 갱신이 기본으로 꺼져 있다. 새 판을 받으려면:

```bash
claude plugin marketplace update agent-operate
claude plugin update agent-operate@agent-operate
```

자동으로 받고 싶으면 `/plugin` → Marketplaces → agent-operate에서 자동 갱신을 켠다.

### 예전에 `~/.claude/skills`에 직접 넣어 둔 사본

같은 스킬을 `~/.claude/skills/<이름>`에도 두면 `/herdr-worktree-quad`와 `/agent-operate:herdr-worktree-quad`처럼 두 벌로 보인다. 플러그인이 동작하는 것을 확인한 뒤 옛 사본을 지운다.

## 함께 쓰면 좋은 외부 스킬

아래 스킬은 이 저장소에 넣지 않았다. 원저자 저장소에서 [skills CLI](https://github.com/vercel-labs/skills)로 받는다(`-g`는 사용자 전역 설치, `-y`는 확인 생략).

| 스킬 | 원저자 저장소 | 하는 일 | 설치 |
|---|---|---|---|
| herdr | [herdrdev/herdr](https://github.com/herdrdev/herdr) | herdr pane·탭·워크스페이스·에이전트 제어 | `npx skills add herdrdev/herdr@herdr -g -y` |
| orca-cli | [stablyai/orca](https://github.com/stablyai/orca) | Orca 워크트리·터미널·내장 브라우저 제어 | `npx skills add stablyai/orca@orca-cli -g -y` |
| orchestration | [stablyai/orca](https://github.com/stablyai/orca) | Orca 작업자 여러 개를 감독·조율 | `npx skills add stablyai/orca@orchestration -g -y` |
| computer-use | [stablyai/orca](https://github.com/stablyai/orca) | `orca computer`로 데스크톱 앱 창 조작 | `npx skills add stablyai/orca@computer-use -g -y` |

skills CLI는 `~/.agents/skills`에 내려받고 Claude Code가 읽는 `~/.claude/skills`에 링크를 건다. 받은 뒤 `npx skills update`로 갱신한다.

## 개발

- 스킬 하나 = `skills/<이름>/SKILL.md` 폴더 하나. 폴더를 더하면 따로 등록하지 않아도 플러그인에 들어간다.
- 스킬이 자기 폴더의 파일을 부를 때는 `${CLAUDE_SKILL_DIR}`를 쓴다(예: `node "${CLAUDE_SKILL_DIR}/scripts/quad.mjs"`). 설치 위치가 맥마다 달라서 `~/.claude/skills/...`처럼 경로를 박으면 안 된다.
- 내기 전에 형식을 검사한다: `claude plugin validate .`
- 판을 올릴 때는 `.claude-plugin/plugin.json`과 `marketplace.json`의 `version`을 함께 올린다. 다른 맥은 판이 바뀌어야 새 내용을 받는다.
- 로컬에서 시험: `claude --plugin-dir .`로 띄우면 설치하지 않고 이 폴더의 스킬을 읽는다.

## 라이선스

MIT. [LICENSE](./LICENSE) 참고.
