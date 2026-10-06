---
name: cpt-cli
description: >-
  ONLY for terminals launched by the CodingPT app (env CPT_WS is set; if empty never
  run `cpt`; working on the CodingPT source repo does NOT make this a CodingPT terminal).
  There, use CodingPT's own features first via the `cpt` CLI:
  web pages → `cpt preview` / `cpt browser` (open, click, type, console, network,
  screenshot; "브라우저로 확인해줘", "프리뷰 열어줘", "페이지 테스트"); files/diffs/review →
  `cpt ide`, `cpt review`
  ("diff 보여줘", "리뷰해줘"); mobile apps → `cpt emulator` ("앱에서 확인해줘"); native
  desktop apps and logins/2FA → `cpt desktop`; splitting work across agents → `cpt orch`
  ("병렬로", "나눠서 시켜", `/orch`); recurring or conditional work → `cpt auto`
  ("매일", "자동으로", "…하면 알려줘"); issues → `cpt issue`;
  progress and notifications → `cpt notify`, `cpt ws set`. Run `cpt skills get index`
  first, then `cpt skills get <topic>` for the feature you need.
---

# CodingPT cpt CLI

**먼저 컨텍스트를 확인하라 — 판정 기준은 오직 환경변수 `CPT_WS` 하나다.** `CPT_WS` 가 비어 있으면 여기는
CodingPT 터미널이 아니다 — `cpt` 를 실행하지 말고 이 스킬 전체를 무시하라.
**CodingPT 소스 코드(codingpt/codingpt_service 리포)를 작업 중이라는 사실은 근거가 아니다** —
"CodingPT 작업환경"이 아니라 "CodingPT 앱이 띄운 터미널"만 해당한다. cmux·일반 셸·다른 도구의
터미널에서 `cpt` 를 쓰는 것은 사용자가 보고 있는 다른 화면을 건드리는 일이다. (데몬도 CodingPT
워크스페이스 밖에서 온 조작 요청은 거부한다.)

이 파일은 **발견용 스텁**이다. 안내서는 기능별로 나뉘어 있고 **실행할 바로 그 바이너리**가 서빙한다
(릴리스마다 바뀌어도 어긋나지 않는다). 먼저 인덱스를 읽고, 쓸 기능의 안내서만 골라 읽어라:

```
cpt skills get index        # 무엇을 할 수 있는가 — 할 일 → 주제 표
cpt skills list             # 주제 목록(한 줄 설명)
cpt skills get <주제>        # preview · browser · ide · emulator · desktop · orch · tasks · issue · auto · workspace · terminal · layout · basics
```

- **CodingPT 안에서는 CodingPT 기능을 먼저 쓴다** — 웹 페이지는 `cpt preview`/`cpt browser`, 나눠 맡기기는 `cpt orch`,
  반복 작업은 `cpt auto`. 사용자는 폰·다른 PC 에서 보고 있을 수 있고, 거기서도 같이 보인다.
- 서브커맨드/플래그를 이 스텁이나 기억으로 추측하지 말 것. 지원 여부는 `cpt capabilities` 로 확인.
- `CPT_WS` / `TMUX_PANE` 가 있는 CodingPT 터미널이면 자기 워크스페이스·터미널을 자동 인지한다.
- 데몬이 꺼져 있어도 `cpt skills get …` 은 동작한다(순수 파일 읽기).
- 에이전트 호출은 `--json` 을 붙이면 기계가독 출력을 얻는다.
- 반복·조건 작업(자동화)은 `cpt auto schema` 로 스키마를 먼저 읽고 만든다 — 확신이 없으면 만들지 말고 물어라.
