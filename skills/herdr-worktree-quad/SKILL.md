---
name: herdr-worktree-quad
description: herdr 안에서 현재 레포에 `<레포>-claude/-codex/-opencode/-hermes` git 워크트리 4개를 만들고, 현재 pane 오른쪽을 2x2로 나눠 각 워크트리에서 claude·codex·opencode·hermes를 권한 우회 모드로 띄운다. 시작 창 중 업데이트는 건너뛰고 디렉터리 신뢰는 승인한다. 사용자가 `/agent-operate:herdr-worktree-quad` 슬래시 커맨드로 직접 부를 때만 실행한다.
disable-model-invocation: true
---

# herdr 워크트리 쿼드

현재 레포에서 에이전트 4개를 각자의 git 워크트리에 띄워, **한 화면(현재 탭)** 에서 나란히 본다.

```
┌──────────────┬──────────┬──────────┐
│              │ claude   │ codex    │
│  호출한 pane  ├──────────┼──────────┤
│              │ opencode │ hermes   │
└──────────────┴──────────┴──────────┘
```

**사용자가 `/agent-operate:herdr-worktree-quad`로 직접 부른 경우에만 실행한다.** 비슷한 요청("워크트리 만들고 에이전트 띄워" 등)만으로는 이 스킬을 쓰지 않는다 — frontmatter의 `disable-model-invocation: true`가 자동 호출을 막는다.

**믿을 수 있는 레포에서만 부른다.** 에이전트는 권한 확인 없이 명령을 실행하고, 디렉터리 신뢰 창에는 자동으로 Yes를 누른다(codex는 원래 저장소 루트 전체를 신뢰 목록에 올린다).

## 설계 결정 (바꾸기 전에 읽을 것)

- **워크트리는 `git worktree add`로 만든다. `herdr worktree create`는 쓰지 않는다.** herdr 것은 워크트리마다 사이드바 워크스페이스를 항상 따로 열어, 쓰이지 않는 셸이 워크트리 수만큼 생긴다(열지 않는 옵션이 없다). 경로는 herdr 규칙 `<worktrees.directory>/<레포>/<브랜치>`(기본 `~/.herdr/worktrees`)와 같게 두므로 `herdr worktree list`에 그대로 나오고, 필요하면 `herdr worktree open`으로 열 수 있다.
- **사이드바의 워크트리 트리(├└로 묶인 항목)는 포기한다.** 대신 에이전트 상태와 알림은 사이드바 **Agents 패널**에서 에이전트별로 본다. herdr 알림은 pane 단위로 동작하므로 한 탭에 모여 있어도 온다(단, 지금 보고 있는 탭의 팝업은 herdr가 띄우지 않는다).
- **예전 방식으로 열려 있던 빈 워크트리 워크스페이스**(셸 pane 하나, 에이전트 없음)는 스크립트가 닫는다. 워크트리 폴더·브랜치는 남는다. 비어 있지 않은 워크스페이스는 건드리지 않고 경고만 한다.
- 플래그: claude `--dangerously-skip-permissions`, codex `--yolo`, opencode `--auto`(opencode에는 `--dangerously-skip-permissions`가 없다 — 고정), hermes `--yolo`.
- 모든 에이전트 처리가 끝난 뒤 **마지막으로** 호출한 pane이 있는 탭 이름을 `agents`로 바꾼다.
- 에이전트 이름은 브랜치 이름(`<레포>-claude` 등)이다. herdr 이름 규칙(`[a-z][a-z0-9_-]{0,31}`)에 맞게 소문자화·32자 자르기를 한다.

## 절차

1. **실행.** 호출한 pane의 작업 디렉터리가 대상 레포 안이어야 한다(링크된 워크트리 안이어도 원래 저장소를 기준으로 삼는다).

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/quad.mjs"
   ```

   `${CLAUDE_SKILL_DIR}`는 이 SKILL.md가 있는 폴더다. Claude Code가 아닌 에이전트(opencode·Codex 등)에서 글자 그대로 보이면 이 SKILL.md 파일이 있는 폴더의 절대 경로로 바꿔 쓴다.

   옵션(사용자가 요청할 때만):
   - `--only claude,codex` — 일부만. 배치는 고른 순서대로 좌상·우상·좌하·우하(2개면 위아래).
   - `--base <ref>` — 새 브랜치의 출발점(기본 `HEAD`). 이미 있는 브랜치는 그대로 체크아웃한다.
   - `--pane <id>` — 호출한 pane 말고 다른 pane을 기준으로 나눌 때.
   - `--tab-label <이름>` — 마지막에 붙일 탭 이름(기본 `agents`).
   - `--dry-run` — 워크트리·분할·실행 없이 무엇을 할지만 JSON으로 본다.

   이 스크립트는 네 에이전트의 시작을 기다리므로 1~2분 걸릴 수 있다. Bash 타임아웃을 넉넉히(예: 300000ms) 준다.

2. **결과 JSON을 읽고 표로 보고한다.** 원시 JSON은 보여주지 않는다.

   | pane | 에이전트 | 플래그 | 상태 | 처리한 창 |
   |---|---|---|---|---|

   - `worktrees[].worktree`: `created`(새로 만듦) / `reused`(이미 있던 것을 씀).
   - `closedWorkspaces`: 닫은 빈 워크스페이스. 있으면 한 줄로 알린다.
   - `skipped`: 같은 이름의 에이전트가 이미 살아 있어 건너뛴 것. 새 pane을 만들지 않았다고 알린다.
   - `warnings`: 그대로 전한다(미커밋 변경 경고 등).
   - `panes[].handled`: 자동으로 누른 창(`trust` → Yes, `update` → Skip 등).
   - `tab`: 마지막 단계로 이름을 붙인 탭(`{id, label}`). 기본 이름은 herdr 문서의 탭 용도 예시(`agents`/`logs`/`server`/`review`)를 따른 `agents`. 에이전트를 새로 띄우지 않은 재실행에서도 붙인다. 실패하면 `null`이고 `warnings`에 이유가 남는다.

3. **`status`가 `idle`/`done`이 아닌 pane만 후속 처리한다.**
   - `needs_user`: 알 수 없는 창에서 멈췄다. `screen`(화면 끝부분)을 보여주고 **무엇을 누를지 사용자에게 묻는다.** 임의로 누르지 않는다. 답을 받으면 `herdr pane send-keys <pane> <키>`로 보낸다.
     새로 알게 된 창이 업데이트·신뢰 창이었다면 `scripts/quad.mjs`의 `classify()`에 그 문구를 추가해 다음부터 자동 처리되게 한다.
   - `exited`: 에이전트가 시작 직후 종료했다. `screen`을 보여주고 원인을 알린다.
   - `start_failed` / `timeout`: `error`나 `herdr agent read <이름> --source recent-unwrapped --lines 80`으로 확인해 보고한다. **같은 명령을 그냥 다시 돌리지 않는다.**

## 알려진 시작 창

| 에이전트 | 창 | 자동 처리 |
|---|---|---|
| codex | "Do you trust the contents of this directory?" (1. Yes, continue / 2. No, quit) | Yes |
| codex | "Update available!" (1. Update now / 2. Skip / 3. Skip until next version) | Skip |
| claude | 폴더 신뢰 확인 (1. Yes, I trust this folder / 2. No, exit) | Yes |
| claude | Bypass Permissions 경고(처음 한 번) | 자동 처리 안 함 → `needs_user` |

판별은 화면의 번호 선택지(`› 1. …`, `❯ 1. …`)와 키워드(`trust`, `update available`/`new version` 등)로 한다. 선택지가 이미 골라져 있으면 Enter, 아니면 그 번호 키를 보낸 뒤 다시 확인한다. `[y/N]` 형식 업데이트 질문에는 `n`을 보낸다.

## 뒷정리 (요청받았을 때만)

- 에이전트 종료: 각 pane에서 에이전트를 끄거나 `herdr pane close <pane>`.
- 워크트리 병합: `worktree-merge` 스킬(orbit 하네스가 있는 레포)이나 일반 git merge.
- 워크트리 삭제: `git worktree remove <경로>`. 브랜치는 따로 `git branch -d`. herdr의 `worktree remove`는 열린 워크스페이스가 있어야 해서 이 스킬 방식에는 git 명령이 맞다.
