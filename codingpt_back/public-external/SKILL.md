---
name: codingpt
description: 사용자 PC 의 에이전트(CodingPT)에게 코드 수정·데이터 고도화 같은 일을 맡기고 답을 받는다. "CodingPT 로", "PC 에이전트에게 시켜", "앱이 스스로 고치게", 서비스 안에서 에이전트 작업을 실시간으로 요청하는 기능을 만들 때 쓴다. 세션 만들기·이어 가기·worktree·승인 처리·서비스 연동 코드 작성을 다룬다.
---

# CodingPT 연동

이 프로젝트에서 사용자 PC 의 에이전트를 세션 단위로 부른다. 에이전트는 PC 의 실제 폴더에서 일한다.
전체 계약: https://codingpt.ghmate.com/api/v1/docs (모르는 필드는 추측하지 말고 이 문서를 읽는다)

## 준비

1. `CODINGPT_API_KEY` 가 환경변수에 있는지 본다. 없으면 사용자에게 CodingPT PC 앱 > 설정 > 외부 연동에서 키를 만들어 **서버 측 환경변수**에 넣어 달라고 한다. `.env` 는 커밋하지 않는다.
2. 도구 파일이 없으면 받는다: `curl -fsSL https://codingpt.ghmate.com/api/v1/sdk/codingpt.mjs -o codingpt.mjs`

## 지금 일을 맡길 때 (CLI)

```sh
node codingpt.mjs workspaces                                  # 쓸 수 있는 폴더
node codingpt.mjs new <폴더> "<지시>" --mode acceptEdits --wait   # 새 세션 → 답 출력(id 를 기억한다)
node codingpt.mjs new <폴더> "<지시>" --worktree --wait           # 전용 브랜치에서
node codingpt.mjs send <세션> "<이어서>" --wait                   # 같은 대화 이어 가기
node codingpt.mjs sessions                                    # 이 키로 만든 세션
```

`--wait` 결과의 `pending` 이 비어 있지 않으면 에이전트가 승인·질문을 기다리는 것이다:
네가 정해도 되는 범위면 `allow <세션> <요청>` / `deny <세션> <요청> "이유"` / `answer <세션> <요청> '{"질문":"라벨"}'`, 아니면 사용자에게 묻는다. 그 뒤 `wait <세션>` 으로 이어 받는다.

## 서비스 코드에 붙일 때 (SDK)

```js
import { CodingPT } from './codingpt.mjs';
const cp = new CodingPT();
const s = await cp.createSession({ cwd, prompt, title, mode: 'default', clientId: requestId });
for await (const ev of cp.stream(s.id)) sendToClient(ev);   // settled 이벤트의 pending 을 화면에 보여 주고
await cp.respond(s.id, req.id, { decision: 'allow' });       // 사용자가 고른 답을 돌려보낸다
await cp.send(s.id, nextPrompt);                             // 같은 세션으로 대화를 이어 간다
```

언어가 Node 가 아니면 문서의 HTTP API 를 그대로 쓴다.

## 규칙

- 세션 id 를 저장해 두고 이어 간다. 다른 키의 세션이나 사람이 CodingPT 에서 하던 대화는 볼 수 없다.
- API 키를 브라우저·앱 번들에 넣지 않는다. 호출은 서버에서 한다. 이 키는 사용자 PC 에서 명령을 실행하는 권한이다.
- 최종 사용자의 입력을 프롬프트에 그대로 잇지 않는다. 시킬 수 있는 일을 서비스 코드에서 정해 두고, 사용자 값은 데이터로 넘긴다.
- 프롬프트에 비밀값을 넣지 않는다(CodingPT 서버를 TLS 로 지난다).
- 재시도는 같은 `clientId` 로 한다. `TIMEOUT` 은 PC 에서 이미 처리됐을 수 있다.
- `DAEMON_OFFLINE` 은 PC 가 꺼진 것이다. 재시도로 해결되지 않으니 사용자에게 알린다.
- 승인 없이 실행(`bypassPermissions`)은 사용자가 키에서 허용했고 위험이 없는 일에만 쓴다.
