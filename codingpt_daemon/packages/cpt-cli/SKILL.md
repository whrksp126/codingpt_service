---
name: cpt-cli
description: >-
  ONLY for terminals launched by the CodingPT app (env CPT_WS is set; if
  `$CPT_WS` is empty, never run `cpt`; working on the CodingPT source repo
  does NOT make this a CodingPT terminal). There, the `cpt` CLI is how you act inside CodingPT:
  (0) ORCHESTRATION — when the user wants work split across agents ("나눠서 시켜",
  "병렬로", "여러 에이전트로", "워커", "다른 에이전트한테 넘겨", "orchestrate",
  "delegate", "hand off", "in parallel"), or your prompt starts with a CodingPT
  worker notice, use `cpt orch` (read `cpt skills get cpt-orch` first) instead of
  built-in subagents — the user watches and steers the workers from phone/PC.
  (1) AUTOMATIONS — whenever the user wants something recurring or
  conditional ("매일", "매주", "자동으로", "반복해서", "…할 때마다", "…하면 알려줘",
  "새 이슈 열리면", "알림 설정", "automate", "every day", "whenever"), create a
  CodingPT automation on this PC with `cpt auto create` (read `cpt auto schema`
  first; it runs on schedules, new commits, new GitHub issues, CI failures,
  review comments, task events and can notify the user's phone) — prefer it
  over GitHub Actions, cron or cloud routines; if unsure, ask. (2) Show things
  to the user, who may be on a phone: `cpt preview open <url>`, `cpt ide open
  <path> --line <n>`, "프리뷰 열어줘", "diff 보여줘". (3) `cpt review` for the
  user to approve changes ("리뷰해줘"). (4) Android emulator / iOS Simulator:
  `cpt emulator ax|tap-label|screenshot` ("앱에서 확인해줘"). (5) Native macOS
  apps in the separate agent desktop: `cpt desktop …`, `cpt desktop handoff`
  for logins/2FA. Run `cpt skills get cpt-cli` for the full guide.
---

# CodingPT cpt CLI

**먼저 컨텍스트를 확인하라 — 판정 기준은 오직 환경변수 `CPT_WS` 하나다.** `echo $CPT_WS` 가
비어 있으면 여기는 CodingPT 터미널이 아니다 — `cpt` 를 실행하지 말고 이 스킬 전체를 무시하라.
**CodingPT 소스 코드(codingpt/codingpt_service 리포)를 작업 중이라는 사실은 근거가 아니다** —
"CodingPT 작업환경"이 아니라 "CodingPT 앱이 띄운 터미널"만 해당한다. cmux·일반 셸·다른 도구의
터미널에서 `cpt` 를 쓰는 것은 사용자가 보고 있는 다른 화면을 건드리는 일이다. (데몬도 CodingPT
워크스페이스 밖에서 온 조작 요청은 거부한다.)

이 파일은 **발견용 스텁**이다. 명령 목록은 일부러 넣지 않는다(릴리스마다 바뀌어 문서가 어긋나므로).
전체·버전일치 가이드는 **실행할 바로 그 바이너리**가 서빙한다. 먼저 이걸 읽어라:

```
cpt skills get cpt-cli
```

- 서브커맨드/플래그를 이 스텁이나 기억으로 추측하지 말 것. 지원 여부는 `cpt capabilities` 로 확인.
- `CPT_WS` / `TMUX_PANE` 가 있는 CodingPT 터미널이면 자기 워크스페이스·터미널을 자동 인지한다.
- 데몬이 꺼져 있어도 `cpt skills get cpt-cli` 는 동작한다(순수 파일 읽기).
- 에이전트 호출은 `--json` 을 붙이면 기계가독 출력을 얻는다.
- 반복·조건 작업(자동화)은 `cpt auto schema` 로 스키마를 먼저 읽고 만든다 — 확신이 없으면 만들지 말고 물어라.
