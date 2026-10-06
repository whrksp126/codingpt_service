# cpt — 다른 터미널 조작

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 다른 터미널 조작

```
cpt terminal list
cpt terminal new --name build
cpt read-screen 2 --lines 100          # 2번 터미널 화면 읽기
cpt send 2 "npm test" --enter          # 2번 터미널에 명령 입력
cpt terminal wait 2                     # 2번 터미널의 에이전트가 유휴가 될 때까지 대기(기본 600s)
cpt terminal wait 2 --for permission    # 승인 대기 상태가 될 때까지 (any = idle 또는 permission)
```

주의: **자기 자신 터미널**에 `send`/`send-key`/`terminal wait` 하려면 `--force` 가 필요하다(자기루프 방지).

정직성 계약(terminal wait): 대기는 tmux 관찰(agent-watch) 기반이라 실제 상태보다 최대 2초쯤
늦게 감지된다. 에이전트가 아직 시작 전이면 즉시 idle 로 판정될 수 있으니, `send` 직후라면 한두 초
띄우고 걸어라. 타임아웃이면 `{ timeout: true, state }` 를 돌려준다(에러 아님).
