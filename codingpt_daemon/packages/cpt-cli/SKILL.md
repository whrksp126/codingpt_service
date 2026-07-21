---
name: cpt-cli
description: >-
  Use the `cpt` CLI to operate the CodingPT workspace this terminal lives in:
  the in-app preview browser, the IDE (open a file and jump to a line), shared
  terminals, screen layout, and notifications. Use whenever the user asks to
  "show this", "open the preview", "프리뷰 열어줘", "IDE로 열어", "이 파일 열어줘",
  "화면 보여줘", "스크린샷 찍어줘", or whenever you want the user — who may be
  watching from a phone or tablet — to see a URL, a running dev server, or a
  source file. Prefer `cpt preview open <url>` and `cpt ide open <path> --line <n>`
  over the plain `open` command or asking the user to open things themselves.
---

# CodingPT cpt CLI

이 파일은 **발견용 스텁**이다. 명령 목록은 일부러 넣지 않는다(릴리스마다 바뀌어 문서가 어긋나므로).
전체·버전일치 가이드는 **실행할 바로 그 바이너리**가 서빙한다. 먼저 이걸 읽어라:

```
cpt skills get cpt-cli
```

- 서브커맨드/플래그를 이 스텁이나 기억으로 추측하지 말 것. 지원 여부는 `cpt capabilities` 로 확인.
- `CPT_WS` / `TMUX_PANE` 가 있는 CodingPT 터미널이면 자기 워크스페이스·터미널을 자동 인지한다.
- 데몬이 꺼져 있어도 `cpt skills get cpt-cli` 는 동작한다(순수 파일 읽기).
- 에이전트 호출은 `--json` 을 붙이면 기계가독 출력을 얻는다.
