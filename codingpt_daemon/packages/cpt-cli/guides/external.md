# 외부 연동 — 다른 프로젝트·서비스에서 이 PC 의 에이전트 부르기

> 명령·플래그의 정본은 `cpt help` 다. 다른 주제: `cpt skills list`

사용자의 다른 프로젝트가 CodingPT 를 통해 이 PC 의 에이전트를 쓰게 할 때 읽는다.
계약 정본은 https://codingpt.ghmate.com/api/v1/docs 다. 이 파일은 프로젝트에 연결하는 순서만 다룬다.

## 프로젝트에 연결하기

```sh
mkdir -p .claude/skills/codingpt
curl -fsSL https://codingpt.ghmate.com/api/v1/skill -o .claude/skills/codingpt/SKILL.md
curl -fsSL https://codingpt.ghmate.com/api/v1/sdk/codingpt.mjs -o codingpt.mjs
```

그러면 그 프로젝트의 에이전트가 사용법을 스스로 안다. 코드에 쓰려면 위 `codingpt.mjs` 를 import 하고, MCP 로 쓰려면 문서의 `.mcp.json` 을 넣는다.

★ **API 키는 네가 만들 수 없다.** 사용자가 PC 앱 > 설정 > 외부 연동에서 만들어야 한다. 키 하나가 그 PC 에서 명령을 실행할 권한이기 때문이다. 키가 없으면 사용자에게 만들어 달라고 말하고, 받은 키는 `.env*`(커밋 금지)에 넣는다.

이 터미널 안에서 다른 PC 나 다른 에이전트를 부를 때는 이 API 가 아니라 `cpt agent` 를 쓴다.
