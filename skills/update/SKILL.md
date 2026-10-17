---
name: update
description: 이 맥에 깔린 agent-operate(herdr·Orca 에이전트 운용 스킬 모음)를 최신 판으로 올린다. Claude Code 플러그인으로 깔렸으면 마켓플레이스와 플러그인을, skills CLI로 opencode·Codex 등에 깔렸으면 그 스킬들을 갱신하고, 몇 판에서 몇 판이 됐는지와 재시작이 필요한지 알린다. 사용자가 "/agent-operate:update" 또는 "agent-operate 업데이트"라고 직접 부를 때만 실행한다.
disable-model-invocation: true
---

# agent-operate 업데이트

이 맥에 agent-operate가 깔린 길을 스스로 찾아, 그 길로 새 판을 받는다. 묻지 않고 진행한다.

| 깔린 길 | 알아보는 곳 | 갱신 명령 |
|---|---|---|
| Claude Code 플러그인 | `~/.claude/plugins/installed_plugins.json`의 `agent-operate@<마켓플레이스>` | `claude plugin marketplace update <마켓플레이스>` → `claude plugin update agent-operate@<마켓플레이스>` |
| skills CLI (opencode·Codex 등) | `~/.agents/.skill-lock.json`에서 source가 `vriznet/agent-operate`인 스킬 | `npx skills update <스킬…> -g -y` |

## 절차

1. 실행한다. `${CLAUDE_SKILL_DIR}`는 이 SKILL.md가 있는 폴더다(Claude Code가 아닌 에이전트에서 글자 그대로 보이면 이 파일이 있는 폴더의 절대 경로로 바꿔 쓴다).

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/update.mjs"
   ```

   무엇을 할지만 보려면 `--dry-run`을 붙인다. 네트워크(GitHub, npm)가 필요하다.

2. 출력의 마지막 줄 JSON을 읽어 쉬운 말로 보고한다. 원시 출력을 그대로 보이지 않는다.
   - `plugin.before` → `plugin.after`: Claude Code 플러그인의 판(`판@커밋`). `changed`가 참이면 **Claude Code를 다시 시작해야 새 스킬이 보인다**고 알린다. 지금 이 세션에는 옛 판이 남아 있다.
   - `skillsCli.changed`: skills CLI로 받은 스킬 중 바뀐 것. 있으면 그 에이전트(opencode·Codex) 세션을 다시 시작해야 반영된다고 알린다.
   - 둘 다 바뀐 것이 없으면 "이미 최신"이라고 한 줄로 끝낸다.
   - 어느 길도 깔려 있지 않으면 출력의 설치 명령을 안내한다. 스스로 깔지 않는다.
   - 실패(`ok: false`)면 출력 끝 몇 줄과 함께 원인을 알리고 같은 명령을 그냥 다시 돌리지 않는다.

## 하지 않는 것

- 새로 깔지 않는다. 깔린 길만 갱신한다.
- Claude Code에는 skills CLI로 깔지 않는다(플러그인과 같은 스킬이 두 벌로 보인다).
- 다른 플러그인·스킬은 건드리지 않는다.
