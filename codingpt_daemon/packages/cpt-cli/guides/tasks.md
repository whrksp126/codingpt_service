# cpt — 작업(전용 작업 폴더에서 다른 에이전트가 맡는 일)

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 작업(Agent Tasks) — 전용 작업 폴더에서 다른 에이전트가 맡는 일

**작업**은 저장소의 git worktree(`~/.codingpt/worktrees/…`)마다 에이전트 1개를 돌린다. 사용자가 폰/PC 에서
만들 수도 있고, 네가 **인계**로 만들 수도 있다("다른 에이전트한테 넘겨", "따로 해 줘").

```
cpt task get                 # 이 터미널이 속한 작업(프롬프트 전문 포함)
cpt task list [--all]        # 이 PC 의 작업 목록(* = 이 터미널의 실행)
cpt task create --prompt "<맡길 일>" [--agent claude|codex|gemini] [--model <id>] [--base <branch>]
cpt task commit <taskId> --message "…"      # 작업 폴더의 변경을 커밋
cpt task merge <taskId> [--message "…"]     # base 브랜치로 머지하고 작업 폴더 정리(미커밋 변경은 --message 로 커밋 후)
cpt task discard <taskId> [--force]         # 머지하지 않고 폐기(30일 복구 가능)
```

규율: 인계는 **결과를 기다리지 않는다** — 작업 ID 를 사용자에게 알리고 끝낸다. 결과를 받아서 이어 가야 하면
인계가 아니라 오케스트레이션이다(아래 6-3). 네가 작업 터미널 안의 에이전트라면 작업 브랜치(`cpt/…`)에서
평소처럼 고치고 커밋한 뒤 멈춘다 — 자기 작업을 스스로 머지하거나 worktree 를 지우지 마라(맡긴 쪽이 한다).
