# 외부 연동 — 다른 프로젝트·서비스를 이 PC 의 에이전트에 연결하기

> CodingPT 터미널 전용. 명령·플래그의 정본은 `cpt help` 다. 다른 주제: `cpt skills list`

사용자가 "이 PC 구독으로 에이전트 연결해 줘", "이 앱이 CodingPT 를 쓰게 해 줘", "AI API 대신 내 PC 에이전트로" 처럼 말하면 이 기능이다.
그 프로젝트의 서비스나 에이전트가 이 PC 의 에이전트에게 일을 맡기고 답을 받게 된다. **묻지 말고 네가 연결한다.**

## 연결하기

```sh
cpt external connect --dir <프로젝트 폴더>      # 생략하면 지금 폴더
node codingpt.mjs workspaces                 # 그 폴더에서 실행해 연결 확인
```

이 한 번으로 끝난다.

- 그 폴더만 허용하는 API 키를 만들어 `~/.codingpt/keys/` 에 저장한다(0600).
- 프로젝트에 `.codingpt.json`(키 **파일 경로**만, 커밋해도 된다) · `codingpt.mjs`(SDK·CLI·MCP) · `.claude/skills/codingpt` · `.agents/skills/codingpt` 를 만든다.
- 같은 폴더에서 다시 실행하면 기존 키를 다시 쓴다. 새 키가 필요하면 `--new`(기존 키는 폐기된다).

`codingpt.mjs` 는 `.codingpt.json` 을 찾아 키를 스스로 읽는다. **환경변수도 키 값도 필요 없다.** 그 프로젝트의 에이전트는 스킬을 보고 바로 쓴다.

```
--name <이름>       키 이름(기본: 폴더 이름)
--paths a,b         허용 폴더 직접 지정(기본: 그 프로젝트 폴더)
--mcp               프로젝트 .mcp.json 에 MCP 서버 추가
--allow-bypass      승인 없이 실행 허용. 사용자가 그렇게 하라고 했을 때만 쓴다
```

## 키 관리

```sh
cpt external key list
cpt external key create <이름> [--paths a,b] [--allow-bypass]   # 응답은 파일 경로뿐이다
cpt external key revoke <이름|id>                              # 폐기 + 키 파일 삭제
```

## 규칙

- ★ **키 값을 읽거나 출력하지 마라.** `cat` 하지 말고 대화·로그·커밋에 남기지 마라. 파일 경로만 다룬다.
- 키를 만들고 폐기하면 사용자에게 알림이 간다. 사용자는 설정 > 외부 연동에서도 보고 폐기할 수 있다.
- 허용 폴더는 좁게 둔다. 홈 전체(`--paths ~`)는 사용자가 원할 때만.

## 다른 서버에 배포된 서비스일 때

그 서버에는 키 파일이 없으니 환경변수가 필요하다. 값을 화면에 찍지 말고 파일째 옮긴다:

```sh
printf 'CODINGPT_API_KEY=%s\n' "$(cat <keyFile>)" >> .env.local   # .env* 는 커밋 금지
```

API 계약 전체: https://codingpt-back.ghmate.com/api/v1/docs
이 터미널 안에서 다른 PC 나 다른 에이전트를 부를 때는 이 기능이 아니라 `cpt agent` 를 쓴다.
