# CodingPT 알림 채널 — 서비스에서 개발자의 폰으로 알림 보내기

운영 중인 서비스(서버·배치·CI·스크립트)에서 **개발자의 CodingPT 앱으로 알림을 보낸다.**
알림은 앱의 "알림 채널"(대화방)에 쌓이고 폰에 푸시로 온다. 개발자는 그 방에서 바로 PC 의 AI 에이전트에게
"이거 고쳐 줘" 라고 시켜 대응한다(AI 는 채널에 연결된 PC 의 프로젝트 폴더에서 일한다).

- 기본 주소: `https://codingpt-back.ghmate.com/api/v1`
- 무엇을 언제 보낼지는 **보내는 쪽이 정한다.** CodingPT 는 서비스를 감시하지 않는다. 받은 것을 보여 주고 AI 로 잇는다.

## 1. 웹훅 URL 얻기

채널마다 웹훅 URL 이 하나 있다: `https://codingpt-back.ghmate.com/api/v1/hooks/cpth_…`

- 사용자가 CodingPT 앱 > 알림 채널 > 채널 > "웹훅 URL 복사" 로 준다. **사용자에게 받는다.**
- 또는 API 키(`cptx_`, `codingpt.mjs`/`.codingpt.json` 이 있는 프로젝트)로 직접 만든다 — 아래 6절.

**URL 자체가 비밀이다.** 누구든 이 URL 로 그 방에 글을 올릴 수 있다(명령 실행 권한은 없다).
서버 측 환경변수 `CODINGPT_WEBHOOK_URL` 에 넣는다. 코드·저장소·브라우저 번들·로그에 넣지 않는다.
새면 사용자가 앱에서 "URL 다시 만들기" 로 바꾼다.

## 2. 보내기

```sh
curl -X POST "$CODINGPT_WEBHOOK_URL" -H 'Content-Type: application/json' \
  -d '{"title":"결제 실패 급증","text":"5분간 PG 승인 실패 42건","level":"error","source":"payments-api","dedupeKey":"pay-fail"}'
```

평문도 된다: `curl -X POST "$CODINGPT_WEBHOOK_URL" -H 'Content-Type: text/plain' --data-binary '배포 완료'`

| 필드 | 설명 |
|---|---|
| `title` | 한 줄 제목(200자). `title`·`text` 중 하나는 필수 |
| `text` | 본문(8000자, 줄바꿈 유지). 스택 트레이스·로그 일부를 넣는다. 별칭 `body`·`message` |
| `level` | `info`(기본) · `success`(복구·완료) · `warning` · `error` · `critical`. `warn`·`fatal`·`ok`·`resolved` 등도 알아듣는다 |
| `source` | 보낸 곳(서비스·환경·호스트 이름, 60자). 예: `payments-api@prod` |
| `url` | 관련 링크(대시보드·로그·PR·Sentry 이슈). http(s) 만 |
| `fields` | 짧은 키-값 `{ "env": "prod", "count": 42 }` 또는 `[{ "label":"env","value":"prod" }]`(20개) |
| `dedupeKey` | 같은 문제의 반복을 한 줄로 묶는 키(아래) |

응답: `{ "ok": true, "channelId": 3, "messageId": 120, "deduped": false, "repeatCount": 1 }`
실패: `{ "success": false, "message": "...", "detail": { "code": "..." } }` — `CHANNEL_NOT_FOUND` 404(URL 이 틀렸거나 바뀜) · `BAD_REQUEST` 400 · `RATE_LIMITED` 429.

연결 확인: `curl "$CODINGPT_WEBHOOK_URL"` → `{ "ok": true, "channel": { "name": "…" } }` (알림을 만들지 않는다)

## 3. 반복 알림 묶기(dedupeKey) — 꼭 쓴다

같은 오류가 1초에 100번 나도 폰이 100번 울리면 안 된다.
같은 `dedupeKey` 는 **1시간 동안 한 줄**로 묶이고 `repeatCount` 가 오른다. 묶인 알림은 10분이 지났거나 `level` 이 더 심각해졌을 때만 다시 울린다.
키는 "같은 문제"를 가리키게 만든다: `"<서비스>:<오류 종류>:<위치>"` (예: `api:TimeoutError:pay.js:88`). 요청 id·시간처럼 매번 바뀌는 값을 넣지 않는다.
복구되면 같은 계열의 다른 키로 `level:"success"` 를 보낸다(예: `api:health:recovered`).

채널당 분당 120건까지 받는다(넘으면 429). 그 이상이 필요하면 묶어서 보낸다.

## 4. 보내는 코드의 규칙

- **알림 실패가 서비스를 멈추게 하지 않는다.** 짧은 타임아웃(3초), 예외는 삼키고, 요청 경로를 기다리게 하지 않는다(fire-and-forget).
- 비밀값·토큰·개인정보(이메일·전화·카드)를 본문에 넣지 않는다. 사용자 식별은 내부 id 정도로.
- 알림 본문은 나중에 AI 에게 그대로 전달된다. **원인을 찾는 데 필요한 것**을 넣는다: 오류 메시지, 스택 위쪽 20~40줄, 실패한 요청의 경로·메서드, 버전·커밋, 관련 로그 링크.
- `level` 은 사람이 깨어나야 하는 정도로 정한다. `critical` = 지금 장애 · `error` = 고쳐야 할 버그 · `warning` = 지켜볼 것 · `info`/`success` = 기록용.
- 환경을 `source` 에 적는다(`@prod`/`@staging`). 개발 환경에서는 보내지 않거나 다른 채널을 쓴다.

## 5. 붙이는 자리(예시)

**Node (의존성 없음)**

```js
// codingpt-notify.js
export function notifyCodingPT(payload) {
  const url = process.env.CODINGPT_WEBHOOK_URL;
  if (!url) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) })
    .catch(() => {});   // 알림 실패는 무시한다
}

// Express 오류 핸들러
app.use((err, req, res, next) => {
  notifyCodingPT({
    title: `${err.name}: ${err.message}`.slice(0, 200), level: 'error', source: 'api@prod',
    text: String(err.stack || '').split('\n').slice(0, 30).join('\n'),
    fields: { route: `${req.method} ${req.route?.path || req.path}`, version: process.env.APP_VERSION },
    dedupeKey: `api:${err.name}:${req.route?.path || req.path}`,
  });
  next(err);
});
process.on('uncaughtException', (e) => notifyCodingPT({ title: `프로세스 종료: ${e.message}`, text: e.stack, level: 'critical', dedupeKey: 'api:crash' }));
```

**Python**

```python
import json, os, threading, urllib.request

def notify_codingpt(payload):
    url = os.environ.get("CODINGPT_WEBHOOK_URL")
    if not url:
        return
    def send():
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass
    threading.Thread(target=send, daemon=True).start()
```

**셸 · cron · 헬스체크**

```sh
# 살아 있는지 확인하고 죽었으면 알림(감시는 보내는 쪽이 한다 — 다른 서버나 cron 에서 돌린다)
curl -fsS --max-time 5 https://api.example.com/health >/dev/null || \
  curl -s --max-time 3 -X POST "$CODINGPT_WEBHOOK_URL" -H 'Content-Type: application/json' \
    -d '{"title":"api 헬스체크 실패","level":"critical","source":"monitor@cron","dedupeKey":"api:health:down"}'
```

**GitHub Actions** — 저장소 Secrets 에 `CODINGPT_WEBHOOK_URL` 을 넣고:

```yaml
- if: failure()
  run: |
    curl -s --max-time 5 -X POST "${{ secrets.CODINGPT_WEBHOOK_URL }}" -H 'Content-Type: application/json' \
      -d "{\"title\":\"CI 실패: ${{ github.workflow }}\",\"level\":\"error\",\"source\":\"${{ github.repository }}\",\"url\":\"${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\",\"dedupeKey\":\"ci:${{ github.workflow }}:${{ github.ref_name }}\"}"
```

다른 도구(모니터링·에러 트래커)의 "커스텀 웹훅" 칸에 URL 을 그대로 넣어도 된다. 모르는 모양의 JSON 이면 `title`/`text`/`message`/`summary`/`description`·`level`/`severity`/`status` 같은 흔한 이름을 찾아 쓰고, 그래도 없으면 400 이다 — 그럴 땐 위 모양으로 바꿔 보내는 작은 함수를 둔다.

## 6. API 키로 채널 만들기·보내기(선택)

이 프로젝트가 CodingPT 에 연결돼 있으면(`.codingpt.json`·`codingpt.mjs` 있음, 또는 `CODINGPT_API_KEY`) 채널을 직접 만든다.
만든 채널은 **이 키의 PC 와 이 프로젝트 폴더**에 묶여, 사용자가 그 방에서 AI 에게 시키면 이 폴더에서 일한다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/channels` | 채널 목록 `{ channels:[{ id, name, webhookUrl, cwd }] }` |
| POST | `/channels` | `{ name, description?, cwd? }` — **같은 이름이 있으면 그것을 돌려준다**(`created:false`). 여러 번 불러도 방은 하나 |
| POST | `/channels/:id/messages` | 키로 보내기(본문은 2절과 같다) |

```sh
node codingpt.mjs channel "shop 운영 알림"          # 만들거나 찾기 → webhookUrl 출력
node codingpt.mjs notify "결제 실패 42건" --title "결제 오류" --level error --dedupe pay-fail
```

```js
import { CodingPT, notify } from './codingpt.mjs';
const ch = await new CodingPT().ensureChannel({ name: 'shop 운영 알림' });   // ch.webhookUrl 을 서버 환경변수로
await notify({ title: '배포 완료', level: 'success' });                        // CODINGPT_WEBHOOK_URL 로 보낸다(키 불필요)
```

**에이전트에게:** 사용자가 "문제 생기면 CodingPT 로 알려 줘" 라고 하면 —
① 웹훅 URL 을 사용자에게 받거나 6절로 만든다 → ② 서버 환경변수 `CODINGPT_WEBHOOK_URL` 로 넣는 자리를 만든다(값은 `.env`·배포 설정에만, 커밋 금지) →
③ 오류 핸들러·크래시·실패한 배치·헬스체크 같은 자리에 4절 규칙대로 보낸다(dedupeKey 필수) →
④ `curl "$CODINGPT_WEBHOOK_URL"` 로 연결을 확인하고 테스트 알림 한 건을 보낸다 → ⑤ 무엇을 언제 보내게 했는지 사용자에게 표로 알려 준다.
