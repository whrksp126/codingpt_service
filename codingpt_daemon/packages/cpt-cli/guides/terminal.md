# cpt — 다른 터미널 조작

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 오래 도는 명령은 CodingPT 터미널 탭에서

개발 서버·감시(watch)·빌드·오래 걸리는 테스트처럼 **계속 돌거나 오래 걸리는 명령**은 숨은 백그라운드 셸 대신
CodingPT 터미널 탭에서 돌린다 — 사용자가 폰·PC 어디서든 그 탭을 보고, 멈추고, 이어서 칠 수 있다.

```
cpt terminal new --name dev                       # 새 탭(전 기기에 나타남) — "터미널 <id> 생성됨" 의 id 를 아래에 그대로 쓴다
cpt send <id> "cd <폴더> && npm run dev" --enter  # 새 탭은 워크스페이스 폴더에서 시작한다 — 다른 폴더면 cd 를 붙인다
cpt read-screen <id> --lines 60                   # 출력 확인(준비됐는지·에러)
cpt send-key <id> C-c                             # 멈추기
```

id 는 1, 2 같은 순번이 아니라 긴 숫자다(`cpt terminal list` 첫 칸). 이미 있는 탭이면 거기서 id 를 찾아 그대로 쓴다. 짧게 끝나는 명령(빌드 확인·`git status`)은 그냥 네 셸에서 돌려도 된다.

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
