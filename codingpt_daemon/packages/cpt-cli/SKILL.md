---
name: cpt-cli
description: >-
  Operate the CodingPT workspace this terminal lives in — ONLY when this is a
  CodingPT terminal, i.e. the CPT_WS environment variable is set here. If
  CPT_WS is not set in this environment, this skill does not apply: never run
  `cpt`, and use the plain `open` command and your normal tools instead.
  Inside a CodingPT terminal, use the `cpt` CLI for the in-app preview
  browser, the IDE (open a file and jump to a line), shared terminals, screen
  layout, and notifications — whenever the user asks to "show this", "open
  the preview", "프리뷰 열어줘", "IDE로 열어", "이 파일 열어줘", "화면 보여줘",
  "스크린샷 찍어줘", "변경사항 보여줘", "diff 보여줘", "show the diff",
  "이 요소 어디서 왔어", "디자인 모드", "요소 선택", or whenever you want the
  user — who may be watching from a phone or tablet — to see a URL, a running
  dev server, a source file, or your code changes; there, prefer
  `cpt preview open <url>` and `cpt ide open <path> --line <n>`.
---

# CodingPT cpt CLI

**먼저 컨텍스트를 확인하라.** 이 터미널 환경에 `CPT_WS` 가 없으면 여기는 CodingPT 터미널이
아니다 — `cpt` 를 실행하지 말고 이 스킬 전체를 무시하라. (데몬도 CodingPT 워크스페이스 밖에서 온
조작 요청은 거부한다.) 무관한 프로젝트·다른 도구의 터미널에서 `cpt` 를 쓰는 것은 사용자가 보고
있는 다른 화면을 건드리는 일이다.

이 파일은 **발견용 스텁**이다. 명령 목록은 일부러 넣지 않는다(릴리스마다 바뀌어 문서가 어긋나므로).
전체·버전일치 가이드는 **실행할 바로 그 바이너리**가 서빙한다. 먼저 이걸 읽어라:

```
cpt skills get cpt-cli
```

- 서브커맨드/플래그를 이 스텁이나 기억으로 추측하지 말 것. 지원 여부는 `cpt capabilities` 로 확인.
- `CPT_WS` / `TMUX_PANE` 가 있는 CodingPT 터미널이면 자기 워크스페이스·터미널을 자동 인지한다.
- 데몬이 꺼져 있어도 `cpt skills get cpt-cli` 는 동작한다(순수 파일 읽기).
- 에이전트 호출은 `--json` 을 붙이면 기계가독 출력을 얻는다.
