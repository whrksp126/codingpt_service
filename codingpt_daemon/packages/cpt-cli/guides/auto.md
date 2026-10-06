# cpt — 자동화(반복·조건 작업)

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 7-3. 자동화 (cpt auto)

**언제 만드나**: 사용자가 "매일 / 매주 / …마다 / …하면 / 자동으로 / 알림 설정" 처럼 **반복·조건**을 말하면
작업 대신(또는 작업과 함께) 자동화를 만든다. 만든 뒤 사용자에게 **id 와 요약을 한 줄로** 알린다.
확신이 없으면 만들지 말고 물어라. 자동화는 이 PC 에 산다(PC 가 꺼져 있거나 잠들면 돌지 않는다).

```
cpt auto schema                         # 이 절(스키마·변수·예시) 출력
cpt auto create --file spec.json        # 또는: cat spec.json | cpt auto create -   → id 출력
cpt auto create --file spec.json --dry-run   # 검증만(정규화 결과·다음 실행·경고)
cpt auto list | get <id> | log [<id>] [--limit n]
cpt auto update <id> --file patch.json  # patch = {name?, trigger?, actions?, guards?, enabled?}
cpt auto pause|resume|run|remove <id>
```

**Draft 스키마** (`auto.create` 입력 — JSON 하나):

```
{ "name": "매일 bug 이슈 정리",                    // ≤ 80자(생략 시 트리거 라벨)
  "trigger": <Trigger>,                             // 정확히 1개
  "actions": [<Action>, …],                         // 1~5개, 순서대로 실행(= 매크로). 한 단계 실패 시 중단
  "guards": { "maxRunsPerDay": 10, "maxConcurrent": 1, "cooldownMs": 300000 } }   // 생략 가능(기본값)

Trigger
  {"type":"schedule","cron":"0 9 * * 1-5","tz":"Asia/Seoul","missed":"once"}   // 5필드 cron, 최소 간격 15분
  {"type":"schedule","at":<ms epoch>,"tz":"Asia/Seoul"}                         // 일회 — 실행 후 꺼짐
  {"type":"git.commits","repo":"work/app","branch":"main","remote":"origin"}   // 원격 새 커밋(5분 폴링)
  {"type":"github.issues","repo":"work/app","labels":["bug"],"state":"open"}   // 새 이슈 1건당 1회(5분 폴링, gh 로그인 필요)
  {"type":"pr.ci_failed","repo":"work/app"|null}                                // 작업 PR 의 CI 실패(null = 이 PC 전체)
  {"type":"pr.review_comments","repo":…}                                        // 작업 PR 에 새 리뷰 코멘트
  {"type":"task.event","event":"review_ready"|"merged"|"failed","repo":…}      // 작업 상태 변화

Action
  {"type":"task.create","repo":"work/app","subdir":"","base":null,"agents":[{"id":"claude","count":1}],
   "title":"{issue.title}","prompt":"…","copyEnv":true}          // 새 worktree 작업(메인 체크아웃은 안 건드린다)
  {"type":"terminal.prompt","target":{"event":true}|{"taskId":"t_…","runId":"r_…"}|{"cwd":"work/app","tid":1000123},
   "text":"…"}                                                    // 에이전트가 붙어 있고 쉬고 있을 때만 지시(작업 중이면 건너뜀)
  {"type":"notify","title":"…","subtitle":"…"}                   // 사용자 폰/PC 알림
```

`repo` 는 홈 기준 상대 경로(`cpt identify` 의 ws 와 같은 형식)이고 git 저장소여야 한다. `base:null` = 저장소의 현재 브랜치.

**템플릿 변수** (`{a.b}` 정확 치환만 — 없는 변수는 빈 문자열):

| 변수 | 언제 |
|---|---|
| `{now}` `{auto.name}` `{repo.name}` `{repo.path}` `{branch}` | 항상(가능하면) |
| `{issue.number}` `{issue.title}` `{issue.body}` `{issue.url}` `{issue.labels}` `{issue.author}` | github.issues |
| `{commits.count}` `{commits.range}` `{commits.subjects}` `{commits.authors}` | git.commits |
| `{pr.number}` `{pr.url}` `{ci.failedChecks}` `{ci.failedLogs}` `{review.comments}` | pr.* |
| `{task.id}` `{task.title}` `{run.id}` `{run.branch}` `{run.agent}` | pr.* / task.event |
| `{prev.taskId}` `{prev.runId}` | 앞 단계가 만든 작업 |

**예시 1 — 매일 아침 이슈 정리** (평일 09:00, 작업 1개):

```
{"name":"평일 아침 bug 이슈 정리",
 "trigger":{"type":"schedule","cron":"0 9 * * 1-5","tz":"Asia/Seoul"},
 "actions":[{"type":"task.create","repo":"work/app","agents":[{"id":"claude","count":1}],
             "title":"bug 이슈 정리","prompt":"gh 로 열린 bug 라벨 이슈를 훑고 중복·해결된 것을 정리해 보고해라."}]}
```

**예시 2 — main 에 커밋될 때마다 테스트 작업**:

```
{"name":"main 커밋마다 테스트",
 "trigger":{"type":"git.commits","repo":"work/app","branch":"main"},
 "actions":[{"type":"task.create","repo":"work/app","base":"main","title":"테스트 {commits.range}",
             "prompt":"새 커밋 {commits.count}개를 받았다:\n{commits.subjects}\n\n테스트를 돌리고 깨진 게 있으면 고쳐라."}]}
```

**예시 3 — CI 가 깨지면 알림만**:

```
{"name":"CI 실패 알림",
 "trigger":{"type":"pr.ci_failed","repo":null},
 "actions":[{"type":"notify","title":"PR #{pr.number} 검사 실패","subtitle":"{ci.failedChecks}"}]}
```

**금지·한계**:
- **자동화 안에서 자동화를 만들지 않는다.** 자동화가 만든 작업의 터미널에서 `cpt auto create` 는 거부된다(`AUTO_LOOP`).
  연쇄는 깊이 2 까지(`AUTO_DEPTH`).
- 하루 실행 상한 기본 10회(최대 50) · 동시 1개 · PC 당 30개. 셸 명령·파일 쓰기·push·merge 액션은 **없다** —
  필요한 일은 `task.create` 로 작업을 만들어 에이전트가 승인 흐름 안에서 하게 표현하라.
- 자동화는 CodingPT 터미널 안에서만 만들 수 있다(`AUTO_OUT_OF_TERMINAL`). 만들면 사용자에게 알림이 간다.
- 사용자가 멈추라고 하면 `cpt auto pause <id>` 또는 `remove <id>`. 전체 일시정지는 사용자만 켜고 끈다.
