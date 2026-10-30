# cpt agent — 이름으로 부르는 에이전트 (같은 PC · 다른 PC)

> CodingPT 터미널 전용. 명령·플래그의 정본은 `cpt help` 다.

다른 에이전트를 **탭으로 띄워 일을 시키고 답을 받는다.** claude 가 codex 를, 맥의 claude 가 다른 PC 의 claude 를 부려도 명령은 같다.
사용자는 그 에이전트를 사이드바·탭에서 그대로 보고 끼어들 수 있다.

| 언제 | 무엇 |
|---|---|
| 하나에게 묻고 답을 받는다 · 리뷰/2차 의견 · 다른 PC 에서 돌린다 | **`cpt agent`** |
| 여러 일을 나눠 병렬로, 기록·머지까지 | `cpt orch` |
| 넘기고 잊는다(전용 브랜치) | `cpt task create` |

## 한 바퀴

```sh
cpt agent start reviewer --kind codex           # 이 워크스페이스에 새 탭으로 띄우고, 준비될 때까지 기다린다
cpt agent prompt reviewer "지금 diff 리뷰. 고칠 것만" --wait --timeout 600000   # 넣고 → 끝날 때까지
cpt agent result reviewer                       # 마지막 답(대화 기록에서 읽는다)
cpt agent stop reviewer                         # 다 썼으면 닫는다
```

## 다른 PC

`cpt machine` 으로 이름을 보고, **앞에** `--machine <이름>` 을 붙인다(부분 일치). 나머지는 똑같다.

```sh
cpt machine
cpt --machine "Mac Studio" agent list
cpt --machine "Mac Studio" agent start builder --kind claude --cwd other/project/app   # 다른 PC 는 --cwd 필수(홈 기준 또는 ~/…)
cpt --machine "Mac Studio" agent prompt builder "릴리스 빌드 돌리고 결과 알려줘" --wait --timeout 1800000
cpt --machine "Mac Studio" agent result builder
```

- 같은 계정의 켜진 PC 만 된다. 프롬프트와 화면은 계정 열쇠로 봉인되어 서버가 못 본다.
- 이름은 그 PC 안에서만 유일하다. 내 터미널 좌표·`$CPT_WS` 는 다른 PC 에서 의미가 없다.
- 끊겨도 저쪽 일은 계속된다. 실패가 "안 들어갔다" 는 뜻이 아니다 — **다시 보내기 전에 `agent get`/`read` 로 확인**한다.

## 상태

`working` 일하는 중 · `blocked` 승인·질문이 사람을 기다림 · `idle` 입력 대기 · `starting` · `gone` 종료 · `unknown` 판단 근거 없음(끝났다는 뜻 아님).

- `--wait` 와 `agent wait` 는 기본으로 `idle`/`blocked`/`gone` 에서 끝난다. `--until blocked` 처럼 좁힐 수 있다.
- `AGENT_BLOCKED`: 승인 창에 글이 들어가지 않게 막은 것이다. `agent read` 로 내용을 보고, 네가 정해도 되는 범위면 `agent send-keys`(esc·enter·1·2), 아니면 사용자에게 묻는다.
- `AGENT_PROMPT_STALLED`: 들어갔는데 5초 안에 시작 신호가 없다. **다시 보내지 마라**(이중 지시). `agent read` 로 본다.
- `TIMEOUT` 은 저쪽이 아직 일한다는 뜻이다. `agent wait` 로 이어서 기다린다. 도구 제한 시간보다 `--timeout` 을 짧게 준다.
- `agent start` 가 `AGENT_NOT_READY` 면 신뢰·로그인 화면일 수 있다. `agent read` 로 본다.

`--skip-permissions` 는 승인 창 없이 돌린다. 사용자가 그렇게 하라고 했거나 위험 없는 일일 때만 쓴다.
네가 띄우지 않은 에이전트를 멋대로 닫지 않는다(`agent stop` 은 이름 없는 대상에 `--force` 를 요구한다).
