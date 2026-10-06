# cpt orch — 오케스트레이션 가이드 (AI 용)

**컨텍스트 규칙**: `cpt` 는 CodingPT 터미널 안에서만 쓴다(`$CPT_WS` 가 있어야 한다). 없으면 이 문서를 무시하라.
확인은 `cpt orch status --json` 한 번이면 된다 — 되면 CodingPT 터미널이고 네 역할도 같이 나온다. 환경변수를 `echo` 로 찍어 보지 마라(승인 창만 뜬다).

오케스트레이션은 **한 에이전트(코디네이터)가 다른 에이전트(워커)에게 일을 나눠 맡기고 결과를 받는** 층이다.
누가 무엇을 맡았는지, 어느 시도가 유효한지, 언제 끝났는지를 CodingPT 가 기록한다. 사용자는 폰·PC 의
사이드바에서 묶음과 워커의 상태를 실시간으로 본다.

- **묶음(Run)** — 조율 한 건 + 코디네이터의 수신함.
- **일(Task)** — 할 일 하나(명세·선행 관계·결과).
- **시도(Dispatch)** — 그 일을 워커 터미널 하나가 맡은 한 번. 다시 시키면 새 시도다.

너는 **터미널 좌표로 식별된다** — `--from` 같은 인자를 만들 필요가 없다. `cpt orch status --json` 이 네 역할을 알려 준다.

## 0. 지금 무엇을 해야 하나

| 상황 | 역할 | 할 일 |
|---|---|---|
| 사용자가 `/orch <할 일>` 을 입력했다(codex 는 `$orch`) | 코디네이터 | 아래 §1 — 물어보지 말고 바로 조율로 처리한다 |
| 사용자가 "나눠서 시켜", "병렬로", "여러 에이전트로", "오케스트레이션으로", "지켜보다가 결과 모아줘" 라고 했다 | 코디네이터 | 아래 §1 |
| 사용자는 그냥 일을 시켰는데, **나눠 맡기는 편이 더 빠르다**(아래 "스스로 고를 때") | 코디네이터 | 한 줄로 "워커 N개로 나눠서 진행합니다" 라고 알리고 §1 |
| 프롬프트 맨 위에 "당신은 CodingPT 오케스트레이션의 워커입니다" 안내와 시도 ID 가 있다 | 워커 | 그 안내를 그대로 따른다(§3) |
| "다른 에이전트한테 넘겨", "새 작업으로 따로 해 줘" — 지켜볼 필요는 없다 | 인계 | `cpt task create --prompt "…"` 한 번으로 끝(§4). 묶음을 만들지 않는다 |
| 위 어느 것도 아니다 | 보통 에이전트 | 오케스트레이션 명령을 쓰지 않는다 |

내장 서브에이전트(Task/Agent 도구)로 대신하지 마라 — 사용자가 CodingPT 에서 보고 조종할 수 없다.

### 스스로 고를 때

사용자가 조율을 말하지 않았어도, **셋을 모두** 만족하면 네가 먼저 오케스트레이션을 고른다:

1. 일이 **서로 독립인 덩어리 둘 이상**으로 쪼개진다(다른 모듈·다른 화면·다른 조사 주제 — 한쪽 결과를 기다릴 필요가 없다).
2. 덩어리 하나가 혼자 해도 **몇 분 이상** 걸린다(파일 여러 개를 읽고 고치거나, 테스트·빌드를 돌린다).
3. 덩어리마다 **끝났다는 증거**를 명세로 적을 수 있다.

고르지 않는 경우: 파일 한두 개를 고치는 작은 일 · 앞 단계 결과가 있어야 다음을 정할 수 있는 탐색 · 같은 줄을 여럿이 만져야 하는 일 ·
사용자가 "네가 직접 해" 라고 한 일. 애매하면 혼자 한다 — 워커를 띄우는 데도 시간이 든다.
워커 수는 덩어리 수만큼만(보통 2~4). 상한에 맞추려고 일을 억지로 쪼개지 않는다.

## 1. 코디네이터의 한 바퀴

```sh
cpt orch run-create --objective "<전체 목표 한두 문장>" --json
# 서로 독립인 일은 전부 먼저 띄운 뒤에 기다린다
cpt orch worker-start --title "<짧은 제목>" --spec "<일 A 명세>" --agent claude --json
cpt orch worker-start --title "<짧은 제목>" --spec "<일 B 명세>" --agent codex --json
# 결과·질문·막힘이 올 때까지 기다린다(기본 100초)
cpt orch check --wait --types worker_done,escalation,question --json
```

`check` 가 돌려준 메시지를 **전부** 처리한다:

```sh
cpt orch reply --id <messageId> --body "<답>"                 # question 에는 답한다
cpt orch worker-release --dispatch <dispatchId>               # 끝난 워커는 정리한다(아래 §2)
cpt orch check --ack <deliveryId> --wait --types worker_done,escalation,question --json   # 처리 끝 → 다음 것
```

- `--ack` 를 하기 전까지 같은 배달이 다시 온다. **다 처리한 뒤에만** ack 한다.
- **시간 초과와 빈 결과는 실패가 아니다.** 응답에 붙어 오는 `workers[]` 를 보고 계속 기다린다.
- 기다리는 시간은 `--timeout-ms` 로 정한다(기본 100초 — 셸 도구의 기본 제한 시간 2분 안쪽). 오래 걸리는 일이면
  `--timeout-ms 540000` 과 함께 **셸 도구의 제한 시간을 10분으로** 주면 덜 자주 깨어난다. 도구 제한 시간이 대기보다 짧으면
  명령이 중간에 끊긴다(메시지는 잃지 않는다 — 다시 `check` 하면 온다).
- 모든 시도가 끝날 때까지 돈다. 끝나면 일마다 결과·근거·남은 문제를 사용자에게 보고한다.
- 다 끝났으면 `cpt orch run-close` (정리 안 된 워커 터미널도 같이 정리된다).

`--title` 은 사용자의 사이드바에 보이는 워커 이름이다(20자 안팎, 예: "로그인 폼 검증"). 생략하면 명세 첫 줄이 잘려서 보인다.

### 명세는 혼자서 읽혀야 한다

워커는 네 대화를 모른다. 명세마다 다섯 가지를 적는다:

- **대상** — 어느 파일·컴포넌트·환경인가
- **바꿀 것** — 만들어야 하는 결과
- **제약** — 지켜야 할 것, 건드리면 안 되는 것
- **담당 범위** — 이 워커가 고쳐도 되는 파일(다른 워커와 겹치지 않게)
- **끝났다는 증거** — 통과해야 하는 테스트·나와야 하는 출력

### 어디서 돌릴까 (`--worktree`)

| 값 | 워커가 도는 곳 | 언제 |
|---|---|---|
| `current`(기본) | 너와 **같은 폴더**의 새 터미널 | 조사·리뷰·서로 다른 파일을 고치는 일. 빠르다 |
| `new` | 그 일 전용 **git worktree + 전용 브랜치** | 같은 파일을 건드릴 수 있거나, 결과를 골라서 머지하고 싶을 때 |

사용자가 말했으면 그대로 따른다 — "브랜치 나눠서", "워크트리로", "독립된 공간에서", "따로따로" → `new` · "같은 폴더에서", "여기서", "탭으로" → `current`.
말하지 않았으면 **일마다** 네가 고른다(한 묶음 안에 둘을 섞어도 된다): 읽기만 하거나 담당 파일이 확실히 갈리면 `current`,
같은 파일을 건드릴 가능성이 있거나 실패하면 통째로 버리고 싶은 일이면 `new`.

- `current` 워커는 네 터미널 옆에 **탭으로** 바로 뜨고, 정리하면 탭이 사라진다. `new` 워커는 사이드바의 묶음 아래에 뜬다.
- `current` 워커끼리는 파일이 겹치면 서로 덮어쓴다 — 명세에 담당 범위를 나눠 적어라.
- `new` 는 **커밋된 상태**에서 갈라진다. 네가 아직 커밋하지 않은 변경은 워커에게 보이지 않는다(필요하면 먼저 커밋).

### 순서가 있는 일 (DAG)

진짜 선행 관계만 건다. 서너 단계보다 깊은 사슬 대신 병렬 묶음을 여러 번 돌려라.

```sh
cpt orch task-create --spec "<스키마 설계>" --json                       # → task_a
cpt orch task-create --spec "<API 구현>" --deps task_a --json            # task_a 가 끝나야 시작 가능
cpt orch task-list --ready --brief --json                                # 지금 시작할 수 있는 일
cpt orch worker-start --task <taskId> --agent claude --json
```

선행 일이 실패하면 뒤따르는 일은 `blocked` 가 된다. 실패한 일은 `worker-start --task <id>` 로 다시 시킨다(새 시도).

### 모델 고르기

사용자가 모델을 **이름으로 말했을 때만** `--model <id>` 를 준다(추론 강도는 `--effort`, 모델과 함께).
말하지 않았으면 생략 — 워커는 사용자의 기본 설정을 따른다.

### 사용자에게 결정을 맡길 때

네가 정하면 안 되는 갈림길이면 게이트를 만든다. 사용자 폰·PC 에 알림이 가고, 고르면 수신함으로 온다.

```sh
cpt orch gate-create --question "<무엇을 정해야 하나>" --options "<선택지1>,<선택지2>" [--task <taskId>] --json
cpt orch check --wait --types decision_gate --json
```

`--task` 를 주면 그 일은 결정이 날 때까지 시작할 수 없다. 워커의 질문에 답하려고 게이트를 만들지는 마라(그건 `reply`).

## 2. 끝난 워커 정리

결과(`worker_done`)를 받은 워커 터미널은 셋 중 하나로 처리한다. 그대로 두지 마라 — 끝난 워커 탭이 사용자 화면에 계속 쌓인다.
**결과를 받은 그 자리에서** 정리하고(다 모일 때까지 미루지 않는다), 네 턴은 모든 워커를 넘기거나·남기거나·정리한 뒤에만 끝난다.
정리해도 결과와 기록은 묶음에 남는다.

| 하려는 것 | 명령 |
|---|---|
| 같은 에이전트에게 바로 다음 일을 맡긴다 | `cpt orch worker-start --task <다음 taskId> --terminal <터미널 번호>` |
| 사용자가 남겨 두라고 했다 | `cpt orch worker-retain --dispatch <id>` |
| 끝 | `cpt orch worker-release --dispatch <id>` |

`--worktree new` 워커는 release 할 때 변경을 어떻게 할지 고른다:

```sh
cpt orch worker-release --dispatch <id> --merge              # 워커 브랜치를 base 로 머지하고 작업 폴더를 지운다
cpt orch worker-release --dispatch <id> --merge squash --message "<커밋 메시지>"
cpt orch worker-release --dispatch <id>                      # 머지하지 않고 폐기(30일 동안 복구 가능)
```

머지가 실패하면 `MERGE_FAILED` 이고 **아무것도 지워지지 않는다**(작업 폴더·브랜치 그대로, 다시 시도할 수 있다):

- base 브랜치가 열려 있는 폴더(보통 네 폴더)에 **커밋 안 된 변경**이 있으면 거부된다 — 먼저 커밋하고 다시 release 한다.
  (같은 폴더 워커가 만든 파일도 여기에 포함된다. 머지는 한 워커씩, 커밋 → 머지 순으로.)
- 충돌이면 충돌을 풀 워커를 다시 시키거나 사용자에게 알린다.
- 직접 합치고 싶으면 워커 브랜치(`worker-show` 의 `branch`)를 네 폴더에서 `git merge` 한 뒤 `--merge` 없이 release 한다.

아직 정리 안 된 터미널 보기: `cpt orch worker-list --terminal-state reclaimable --json` (비어야 끝난 것이다).

### 조용한 워커를 어떻게 볼까

```sh
cpt orch worker-list --json                       # 워커마다 liveness · attention · nextAction
cpt orch worker-read --dispatch <id> --limit 80   # 그 터미널 화면
```

- `liveness` 는 `live`(에이전트가 떠 있다) / `exited`(터미널이 없거나 셸로 돌아왔다) / `unverifiable`(모른다).
- **`unverifiable` 은 "죽었다" 가 아니다.** 이걸 근거로 멈추거나 다시 띄우지 마라. 기다리거나 화면을 읽어라.
- 멈추려면 `worker-stop`(살아 있는 워커), 끝난 것이 확인됐는데 보고가 없으면 `worker-abandon`(`exited` 일 때만 받아 준다).
- 실패·멈춤·포기한 일은 `worker-start --task <id>` 로 다시 시킨다. 같은 일에 워커를 두 개 띄우지 마라.
- `attention` 에 `needs_user_input` 이 있으면 그 워커는 권한 승인 같은 **사용자 입력**을 기다리는 중이다 — 사용자에게 알려라.

### 워커에게 추가 지시

```sh
cpt orch send --to dispatch:<id> --subject "방향 수정" --body "<지시>"
cpt orch send --to @all --subject "공지" --body "<모두에게>"        # @idle · @claude · @codex 도 된다
```

보냈다는 것은 보관함에 들어갔다는 뜻이지 읽었다는 뜻이 아니다. 워커는 체크포인트마다 확인한다.

## 3. 워커의 의무

프롬프트 맨 위 안내문이 정본이다. 거기 적힌 명령을 그대로 쓴다(시도 ID 포함).

1. 맡은 일만 한다. 물어볼 것이 있으면 `cpt orch ask` — 사용자에게 묻는 화면을 띄우지 마라(코디네이터가 못 본다).
   답이 시간 안에 안 오면 같은 질문을 `--resume <messageId>` 로 이어서 기다린다(새 질문을 만들지 않는다).
2. 일하는 동안 5분마다 `cpt orch heartbeat --phase "…"`. 살아 있다는 표시일 뿐 완료가 아니다.
3. 체크포인트마다(새 파일 시작 전·테스트 뒤·보고 직전) `cpt orch check --json` 으로 추가 지시를 본다.
4. 끝나면 **정확히 한 번** `cpt orch done --outcome succeeded|failed --summary "<한 일 / 알아낸 것 / 남은 것>"`.
   다 못 했으면 `failed` 다. 실패를 문장 속에만 적지 마라.
5. 보고한 뒤에는 턴을 끝내고 기다린다. 새 일을 시작하거나 터미널을 닫지 마라.

일이 커서 더 쪼개야 하면 워커도 자기 묶음을 만들어 하위 워커를 띄울 수 있다(중첩 상한 있음 — `cpt orch status`).

## 4. 인계(지켜보지 않는다)

"넘겨", "따로 해 줘" 는 조율이 아니다. 새 작업 폴더에서 다른 에이전트가 이어받고, 너는 거기서 손을 뗀다.

```sh
cpt task create --prompt "<맡길 일 — 혼자서 읽히게>" --agent codex --json
```

작업 ID 와 브랜치를 사용자에게 알리고 끝낸다. 결과를 기다리지 않는다. 그 작업은 사용자의 "진행 현황" 에 나타난다.
나중에 사용자가 머지하라고 하면 `cpt task merge <taskId>`, 버리라고 하면 `cpt task discard <taskId>`.

## 5. 사이드바에 진행 상황 남기기

워크스페이스 카드에 한 줄 메모와 단계가 보인다. 재현·수정·검증·막힘 같은 **의미 있는 지점마다** 갱신하라.

```sh
cpt ws set --comment "수정 완료, 통합 테스트 돌리는 중" --status in-progress
cpt ws set --status in-review          # todo · in-progress · in-review · completed
cpt ws set --clear
```

짧고 현재형으로. 갱신에 실패해도 사용자에게 알릴 일은 아니다.

## 6. 오류 코드

| 코드 | 뜻 | 할 일 |
|---|---|---|
| `NO_RUN` | 묶음이 없다 | `run-create` 먼저(또는 `worker-start --spec` 은 묶음을 알아서 만든다) |
| `WORKER_LIMIT` | 동시에 도는 워커가 상한이다 | 끝나기를 기다린 뒤 더 띄운다. 상한을 피하려고 묶음을 새로 만들지 마라 |
| `DEPTH_EXCEEDED` | 더 깊이 쪼갤 수 없다 | 직접 한다 |
| `TASK_NOT_READY` | 선행 일이 안 끝났다 | `task-list --ready` 로 확인 |
| `DISPATCH_ACTIVE` | 워커가 아직 일하는 중이다 | 기다리거나 `worker-stop` |
| `NOT_LIVE_PROOF` | 끝났다는 확인이 없다 | `worker-read` 로 화면을 본다. 추측으로 포기하지 않는다 |
| `WORKER_START_FAILED` | 워커를 못 띄웠다 | 응답의 `failedStage`·`residualResources` 를 보고 사용자에게 알린다. 그대로 다시 띄우지 않는다 |
| `MERGE_FAILED` | 머지·정리 실패(충돌 등) | `detail` 을 보고 충돌을 풀 워커를 시키거나 사용자에게 알린다 |

모든 명령은 `--json` 으로 원본을 받는다. 모르는 플래그는 추측하지 말고 `cpt help` 로 확인하라.
