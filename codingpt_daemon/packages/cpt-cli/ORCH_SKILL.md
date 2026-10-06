---
name: orch
description: >-
  CodingPT orchestration — ONLY for terminals launched by the CodingPT app (env
  CPT_WS is set; if `$CPT_WS` is empty this skill does not apply). `/orch <할 일>`
  makes you the coordinator: split the work, start CodingPT worker agents with
  `cpt orch` (same folder as new terminal tabs, or separate git worktrees/branches),
  collect their results, merge and clean up — the user watches every worker live
  in the CodingPT sidebar and pane tabs on PC and phone. Use it when the user
  types `/orch`, says "오케스트레이션", "나눠서 시켜", "병렬로", "여러 에이전트로",
  "워커", "orchestrate", "in parallel", "delegate", or when a task is large and
  splits into independent parts that would finish faster in parallel. Never
  substitute built-in subagents for this — they are invisible to the user.
argument-hint: "<할 일> [브랜치 나눠서 | 같은 폴더에서] [codex로] [워커 N개]"
---

# CodingPT 오케스트레이션 (/orch)

**먼저 `cpt orch status --json` 을 실행하라**(읽기 전용 — 네가 누구인지 알려 준다). `cpt` 명령이 없거나
"CodingPT 터미널 안에서만 쓸 수 있습니다" 오류가 나오면 여기는 CodingPT 터미널이 아니다 — 사용자에게
"/orch 는 CodingPT 앱이 띄운 터미널에서만 동작한다" 고 한 줄로 알리고 멈춰라. (CodingPT 소스 리포를
작업 중이라는 사실은 근거가 아니다. 환경변수를 `echo` 로 찍어 보지 마라 — 승인 창만 하나 더 뜬다.)

사용자가 맡긴 일:

$ARGUMENTS

위 자리가 비어 있거나 `$ARGUMENTS` 글자가 그대로 보이면, 사용자가 이 스킬을 부르며 함께 쓴 말이
맡긴 일이다. 그것도 없으면 무엇을 나눠 맡길지 한 번만 묻는다.

이 파일은 **발견용 스텁**이다. 명령과 판단 기준은 실행할 바로 그 바이너리가 서빙한다. 먼저 읽어라:

```
cpt skills get cpt-orch
```

그 가이드대로 **네가 코디네이터**가 되어 끝까지 진행한다 — 일을 쪼개고, 워커를 띄우고, 결과를 기다려
받고, (브랜치를 나눴으면) 합치고, 끝난 워커를 정리하고, 묶음을 닫고, 사용자에게 한 번에 보고한다.

- 이 일에 내장 서브에이전트(Task/Agent 도구 등)를 대신 쓰지 않는다 — 사용자는 CodingPT 사이드바와
  탭에서 워커를 지켜보고 폰에서 답한다. 내장 서브에이전트는 그 화면에 보이지 않는다.
- 사용자가 방식(같은 폴더 / 브랜치 분리 / 에이전트 종류 / 워커 수)을 말했으면 그대로 따르고,
  말하지 않았으면 가이드의 판단 기준으로 네가 고른다.
- 명령·플래그를 이 스텁이나 기억으로 추측하지 않는다.
