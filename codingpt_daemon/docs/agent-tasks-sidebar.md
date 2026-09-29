# Agent Tasks — 사이드바 저장소 트리 + 「진행 현황」 UI 명세 (2026-09-29)

> **이 문서는 PC·모바일 두 구현자가 동시에 붙는 단일 계약이다.** `agent-tasks-design.md`(이하 설계 §n) 의
> §4·§5·§6 을 전제로 하고, 이 문서가 그것과 충돌하면 **이 문서가 우선**한다(사이드바·진입점에 한해).
> 결정 근거: 사용자가 "작업(worktree 작업) vs 워크스페이스(프로젝트 폴더)" 를 구분하지 못했다(2026-09-29 확정).
> 경쟁 제품(Orca·Superset·Paseo·Conductor·Claude Code desktop·Codex app)의 지배적 패턴 = **저장소 트리(메인
> 체크아웃 + 자식 worktree 작업) + 별도의 상태 개요**. 그대로 채택한다.

---

## 개정 1 (2026-09-29, 시안 확정) — 진행 현황 = **PC 안의 장소**

> 아래 본문의 "맨 위 행 · 모든 PC 합산 · 폰 전체화면 모달 · 헤더 ListChecks 아이콘" 서술은 이 개정으로 **대체**된다.

- **위치**: `내 PC` 목록 **아래**, 고른 PC 이름 머리(`.sb-sec-dev`, 대문자 변환 없음 + 위 구분선) 밑 한 줄. 에이전트는 그 PC 에서 돌기 때문.
- **범위**: 고른 PC 하나(`scopeToHost` — host 0(모름)은 남긴다). 다른 PC 의 입력 대기는 그 **PC 행의 warn 배지**(`needsInputByHost`, 고른 PC 는 생략 — 바로 아래 진행 현황 배지가 말한다). PC·앱 교차 테스트 `tasks-crossimpl` 2-1.
- **장소 규칙**: 선택 배경은 "지금 들어가 있는 곳" 하나(진행 현황 또는 로컬/에이전트 행). 고른 PC 는 배경이 아니라 **체크(✓)** — PC 는 장소가 아니라 필터다.
- **들어가기/나가기**: 진행 현황 행은 토글이 아니다(다시 눌러도 닫히지 않음). 나가는 길 = 워크스페이스(로컬 행)·PC 행을 누르는 것.
- **폰·태블릿**: 모달 폐기 — `TasksDashboardHost` 는 메인 칼럼에서 `WorkspaceView` 바로 위 형제로 덮는 층(zIndex 없음: 시트·드로어가 형제 순서로 위에 뜬다). 헤더 왼쪽 = ✕ 대신 사이드바 버튼(워크스페이스 헤더와 같음), 제목 옆 PC 이름. 2단 판정은 칼럼 폭. 하드웨어 back = 상세→목록→워크스페이스(드로어가 열려 있으면 드로어 먼저).
- **진입점 하나**: PC 제목줄·폰 워크스페이스 헤더의 현황판 아이콘 제거. 알림·딥링크가 다른 PC 의 작업을 가리키면 그 PC 로 옮긴 뒤 연다.

## 0. 결정 요약 (한 페이지)

| # | 결정 | 근거 |
|---|---|---|
| 1 | 사이드바 맨 위 행 `작업` → **`진행 현황`**. 모든 PC·모든 워크스페이스의 에이전트를 **상태별**로 모아 보는 **뷰**다. 여기서 작업을 만들지 않는다(헤더 `[+ 새 작업]` 은 현황판 안에 그대로 남긴다 — "만드는 곳"은 워크스페이스 그룹). | "작업"이 곧 "폴더"처럼 읽히던 혼동을 이름으로 끊는다 |
| 2 | `워크스페이스` 섹션의 각 워크스페이스 = **그룹**. 첫 자식 `로컬 · <branch>`(= 폴더에서 직접 작업 = 오늘의 클릭 동작), 그 아래 **열린 worktree 작업 행**들. | 저장소 트리 패턴 |
| 3 | 그룹 머리 = 펼침/접힘(워크스페이스별 영속) · 호버 `+ 작업`(PC) / 후행 `+`(모바일) → 그 저장소가 미리 선택된 새 작업 시트. 접힘 머리에는 열린 작업 수 칩 `⑂2`. | 만드는 자리가 "무엇에" 만드는지 드러난다 |
| 4 | 클릭: 로컬 행 = 워크스페이스 열기(오늘 그대로) · 작업 행 = 작업 상세(기존 현황판 상세) · 에이전트 자식 행 = 그 run 의 터미널. **그룹 머리 클릭 = 펼침/접힘 토글**(PC 는 더블클릭 = 워크스페이스 열기). | 머리는 폴더, 자식은 "들어갈 곳" |
| 5 | 머지/폐기/닫힘/실패 작업은 워크스페이스 아래 **없다**(진행 현황의 완료 그룹에만). 등록된 워크스페이스가 없는 저장소의 작업은 **진행 현황에만** 보인다(합성 그룹 없음 — §2.3). | 사이드바 = "열 수 있는 곳"의 목록 |
| 6 | 아이콘은 SVG 만. 로컬 행 = folder 글리프, 작업 행 = git-branch 글리프(PC 는 `icons.gitBranch` 신설), 에이전트 자식 = 기존 에이전트 마크. 선택/활성은 무채색 명암, 색은 상태 신호(입력 대기 warn · 실패 error)에만. | 기존 규율(설계 §6.0) |
| 7 | 판정은 **순수 함수 한 벌**(`sidebar-tasks.js` / `sidebarTasks.ts`)로 양쪽이 같게 만들고 픽스처 1개로 교차 검증한다(§2). | "폰과 PC 가 다른 트리를 그리면" 혼동이 더 커진다 |
| 8 | i18n 신규 원문 5개(§8). master.json 은 모바일 구현자, PC 카탈로그 7개 파일은 PC 구현자가 **직접 줄을 끼워 넣는다**(emit 금지 — 기존 PC 항목을 지운다). | 계약 |

---

## 1. 화면 (ASCII)

### 1.1 PC 사이드바 (`.sidebar`, 폭 `--sb-w` 기본 264)

```
┌──────────────────────────────┐
│ [≡] [🔔]                      │  .sb-top (변경 없음)
├──────────────────────────────┤
│ ☑ 진행 현황               [2]│  .pc-row.tasks-row — 라벨만 바뀜(배지 = needs_input 수, warn)
│                              │
│ 내 PC                     ⋯  │  .sb-sec (변경 없음)
│ 🖥 MacBook Pro               │  .pc-row.active
│ 🖥 Mac mini                  │
│                              │
│ 워크스페이스               ⋯  │  .sb-sec (변경 없음)
│ ▾ codingpt          [+ 작업] │  .ws-group > .ws-row.wsg-head  (호버 시 [+ 작업] 노출, 색 inset·핀·unread 그대로)
│     ~/work/codingpt          │  .wsr-path (머리 안, 오늘 그대로)
│   ⌂ 로컬 · main   터미널 3개 │  .wsg-child.wsg-local.active   (활성 = --hover)
│   ⑂ 로그인 폼 유효성 검사    │  .wsg-child.wsg-task   ● warn
│       입력 대기              │  .wsg-sub
│   ⑂ 결제 실패 재시도  ×3  ▸  │  .wsg-child.wsg-task   (팬아웃: ×N 칩 + 캐럿)
│       작업 중                │
│   ⑂ README 정리              │  ○ (무채색 점)
│       리뷰 준비 · +41 −7     │
│ ▸ heyvoca             ⑂1     │  접힘 머리: 열린 작업 수 칩(안에 입력 대기 있으면 칩 앞 점 warn)
│     ~/work/heyvoca           │
│ ▾ blog                       │
│   ⌂ 로컬 · gh-pages          │  작업 0개 = 로컬 행만(빈 문구 없음)
│                              │
├──────────────────────────────┤
│ (●) 홍길동  me@example.com   │  .sb-me (변경 없음)
└──────────────────────────────┘
```

팬아웃 작업 행을 펼치면(캐럿 또는 ×N 칩 클릭):
```
│   ⑂ 결제 실패 재시도  ×3  ▾  │
│       작업 중                │
│     [c] Claude · cpt/x2m1-1  │  .wsg-child.wsg-agent   ● spin(text3 점멸)
│     [x] Codex  · cpt/x2m1-2  │  ● warn(입력 대기)
│     [g] Gemini · cpt/x2m1-3  │  ○
```

### 1.2 폰 드로어 (`SidebarContent overlay`, 폭 = AppDrawer W)

```
┌────────────────────────────┐
│ [≡] [🔔]              [×]   │  44
├────────────────────────────┤
│ ☑ 진행 현황            (2)  │  TasksRow — 라벨만 바뀜
│ 내 PC                  ⋯    │
│ 💻 MacBook Pro              │
│ 워크스페이스            ⋯    │
│ ▾ codingpt             [+]  │  WsGroupHead (롱프레스 = 기존 컨텍스트 메뉴, 후행 + = 새 작업)
│   ~/work/codingpt           │
│   ⌂ 로컬 · main   터미널 3개│  WsLocalRow (활성 = C.elevated2)
│   ⑂ 로그인 폼 유효성 검사 ● │  WsTaskRow (점 = StateDot tone)
│      입력 대기              │
│   ⑂ 결제 실패 재시도 ×3  ▸  │
│      작업 중                │
│ ▸ heyvoca              ⑂1   │
│   ~/work/heyvoca            │
├────────────────────────────┤
│ (●) 홍길동  me@example.com  │
└────────────────────────────┘
```
폰 WorkspaceView 헤더의 `ListChecks` 아이콘은 그대로 두고 `openTasksDashboard()`(= 진행 현황) 를 연다(변경 없음).

### 1.3 태블릿 (≥ 700, 도킹 사이드바)

```
┌───────────────┬──────────────────────────────────────────┐
│ [≡] [🔔]      │ codingpt · main            [🔍] [☑] [+]   │
│ ☑ 진행 현황(2)│                                          │
│ 내 PC      ⋯  │   (워크스페이스 뷰 / 진행 현황 패널)        │
│ 💻 MacBook    │                                          │
│ 워크스페이스 ⋯ │                                          │
│ ▾ codingpt [+]│                                          │
│   ⌂ 로컬·main │                                          │
│   ⑂ 로그인 폼 │                                          │
│      입력 대기│                                          │
│ ▸ heyvoca  ⑂1 │                                          │
└───────────────┴──────────────────────────────────────────┘
```
태블릿은 같은 `SidebarContent`(docked)라 폰과 동일 컴포넌트. 행 탭 후 드로어를 닫지 않는다(`afterNav` 규칙 그대로).

---

## 2. 데이터 파생 (순수 함수 — PC·앱 공용, 교차 테스트)

파일: PC `codingpt_pc/src/js/sidebar-tasks.js`(import 0개, node 에서 그대로 돈다), 앱 `codingpt_app/src/workspace/tasks/sidebarTasks.ts`.
픽스처: `codingpt_daemon/docs/fixtures/agent-tasks/sidebar-01.json`(PC 구현자 소유, 앱은 읽기만). 양쪽 테스트가 같은 파일로 기대 출력을 대조한다(설계 §8.5 와 같은 방식).

### 2.1 입력

```ts
type SidebarInput = {
  host: number;                                 // 지금 사이드바가 보는 PC(activeDeviceId / resolvedDeviceId). 모름 = 0 금지(0 이면 빈 결과)
  workspaces: { id: string; localPath: string }[];   // workspacesForDevice(host) 의 순서 그대로(sortedWorkspaces = isTaskWorkspace 제외·핀 우선)
  tasks: TaskLite[];                            // state.tasks.byHost[host].items / getBucket(host).items — 그 PC 것만
  rows: { k: string; kind: 'run'|'agent'|'task'; group: TaskGroup; reason: string|null; run: { id: string } | null; task: { id: string } | null; sortAt: number }[];
                                                // buildDashboard(modelInput()).groups 를 평탄화한 것(그룹 판정은 §5 정본을 재사용 — 여기서 다시 판정하지 않는다)
};
```
`rows` 는 현황판 모델의 출력이다: PC `dashboard()` 의 `groups` 를 `GROUPS` 순으로 이어 붙인 배열, 앱 `useTasksModel(shell).rows`.
**사이드바가 상태를 새로 판정하지 않는 이유**: 폰과 PC 가 같은 run 을 다른 상태로 그리면 안 된다(설계 §5 규율). 사이드바는 run.id → row 색인만 만든다.

### 2.2 출력

```ts
type SidebarGroup = {
  wsId: string;
  openCount: number;                            // 열린 작업 수(접힘 칩 ⑂n)
  needsInput: boolean;                          // 안에 needs_input 행이 하나라도 있다(접힘 칩 앞 warn 점)
  tasks: SidebarTask[];                         // 정렬 완료
};
type SidebarTask = {
  taskId: string; title: string;
  group: TaskGroup;                             // 집계(§2.5) — 'done' 은 나오지 않는다
  dot: 'warn' | 'error' | 'spin' | 'none';      // 색 신호
  sub: { key: 'groupNeedsInput'|'groupWorking'|'groupReviewReady'|'groupIdle'|'stateCreating'; diff: {a:number,d:number}|null };
                                                // 화면 문구는 tt(key) + (diff ? ' · ' + tt('diffStat',{a,d}) : '')
  fanout: number;                               // 살아 있는 run 수(1 이면 에이전트 자식 행 없음)
  runs: SidebarRun[];                           // fanout ≥ 2 일 때만 채운다(정렬: run.idx 오름차순)
};
type SidebarRun = { runId: string; agent: string; branch: string; workspaceId: string|null; tid: number|null; group: TaskGroup; dot: SidebarTask['dot'] };
type SidebarOutput = { groups: Record<string /*wsId*/, SidebarGroup> };   // 작업이 0개인 워크스페이스도 키가 있다(openCount 0, tasks [])
```

### 2.3 작업 → 워크스페이스 배정 (순서대로 첫 매치, task 하나는 **한 그룹에만**)

1. 대상 작업 = `task.state === 'open'` 인 것만. `merged | closed | failed` 는 **제외**(진행 현황 `완료` 에만 산다).
2. 살아 있는 run = `run.state ∉ {merged, discarded}`. 살아 있는 run 이 0 개인 open 작업은 **제외**(잔존물 없음 — 현황판에도 행이 없다).
3. `task.workspaceId === w.id` 인 워크스페이스가 입력 목록에 있으면 그 그룹(클라가 생성 시 준 값, 설계 §2.2 — 가장 정확).
4. 없으면 경로 매칭: `w.localPath === task.repo.path` **또는** `w.localPath === task.repo.path + '/' + task.repo.subdir`(subdir 가 비어 있지 않을 때). 둘 다 맞으면 **더 긴 localPath** 쪽(하위 폴더 워크스페이스가 더 구체적).
5. 그래도 없으면 **어느 그룹에도 넣지 않는다**(사이드바에 합성 그룹을 만들지 않는다). 그 작업은 진행 현황에만 있고 배지 `[n]` 에는 이미 세어진다.
   - 왜 합성 그룹을 안 만드나: 사이드바는 "열 수 있는 곳"의 목록이다. 합성 그룹에는 열 수 있는 로컬 행이 없고, 기기 우선 구조에서 "어느 PC 의 저장소인지"도 애매해진다. 등록되지 않은 저장소에 작업을 만드는 경로는 이번 라운드에 없다(새 작업 시트는 등록된 워크스페이스만 고른다).
6. `isTaskWorkspace` 워크스페이스는 입력에 오지 않는다(`sortedWorkspaces` 가 이미 거른다). 혹시 오더라도 그룹을 만들지 않는다(방어).
7. host 불일치 방어: `tasks` 는 호출부가 그 PC 버킷만 넣지만, 함수는 `task.runs[].host` 를 보지 않는다(TaskLite 에 host 가 없다). 호출부 계약: `tasks = byHost[String(host)].items`.

### 2.4 run → 상태 행 색인

- 색인 키 = `row.run.id`(kind 'run' 행만). `rows` 에서 `run.id → row` 맵을 만든다.
- 살아 있는 run 인데 색인에 없는 경우(모델이 오프라인 host 로 행을 안 만든 경우 등) → `group:'idle'`, `dot:'none'` 로 취급하되 fanout 수에는 센다.

### 2.5 작업 집계 상태 (run 여러 개 → 작업 1행)

우선순위(첫 매치): `needs_input` > `working` > `review_ready` > `idle`.
- `dot`: needs_input → `reason ∈ {failed, opFailed}` 이면 `error`, 아니면 `warn` · working → `spin` · review_ready → `none` · idle → `none`.
  (리뷰 준비는 색을 쓰지 않는다 — "입력 대기·실패" 만 신호다. PR 머지 가능 cta 점은 현황판 카드의 몫.)
- `sub.key`: needs_input → `groupNeedsInput` · working → run 이 전부 `creating` 이면 `stateCreating`, 아니면 `groupWorking` · review_ready → `groupReviewReady` · idle → `groupIdle`.
- `sub.diff`: 집계가 review_ready 이고 review_ready 인 run 중 **첫 번째(run.idx 오름차순)** 에 `run.diff` 가 있으면 `{a: diff.additions, d: diff.deletions}`, 아니면 null.
- fanout ≥ 2 면 `runs[]` 를 채운다. 각 run 의 `group/dot` 은 그 run 행의 값(§2.4 규칙, 실패 사유 매핑 동일).

### 2.6 정렬

그룹 안 작업 순서 = (1) 집계 group 의 순서 `needs_input → working → review_ready → idle` (2) 같은 그룹이면 그 작업의 run 행 중 **가장 큰 `row.sortAt`** 내림차순(최근 활동) (3) 동률은 `taskId` 코드포인트 오름차순(localeCompare 금지 — 설계 §5 규율).
로컬 행은 언제나 첫 자식(정렬 대상 아님).

### 2.7 로컬 행 값 (순수 함수 밖 — 각 플랫폼 호출부)

- 브랜치 = `w.git?.branch`(서버 신선도 메타, back `workspaceService` 가 100자로 자른 값). 없으면(빈 문자열/undefined) 라벨은 `로컬` 만.
- 터미널 수 = PC: `wsRuntime(w.id).layout` 의 terminal leaf 들의 `tabs` 중 `typeof t.win === 'number'` 인 탭 수. 앱: 같은 규칙(`T.eachLeaf`, `l.kind === 'terminal'` 의 `tabs.filter(t => typeof t.win === 'number')`). 런타임이 없으면(아직 안 연 워크스페이스) **표시하지 않는다**(0 을 그리지 않는다).

---

## 3. 행 해부 · 지표 · 상태

### 3.1 PC (`sidebar.js` + `styles.css` 사이드바 절)

기존 `.ws-row` 지표를 **그대로** 쓴다: padding 9px 10px · margin-bottom 2 · radius `--r-md` · 이름 13.5px/600 `--text2`(활성 `--text`) · 경로 11px mono `--dim` · hover `--elevated` · active `--hover` · 오프라인 `.ws-off` opacity .55.

```
.ws-group                       래퍼(div). data-ws-id. 색 inset(box-shadow inset 3px)·드래그·우클릭·핀은 머리(.wsg-head)에 그대로.
  .ws-row.wsg-head              ← 기존 wsRow() 의 DOM 을 재사용. .active 는 붙이지 않는다(활성은 로컬 행이 갖는다).
    .wsr-name                    [caret 16] [pin] [.wsr-nm 이름] [.wsr-badge unread] [.wsg-cnt ⑂n(접힘일 때만)] [.wsg-add + 작업(호버)]
    .wsr-path / .wsr-missing     오늘 그대로
    (.wsr-meta / .wsr-ports)     오늘 그대로(상태 스트림·포트는 폴더의 것 → 머리에 남는다)
  .wsg-children                  펼침일 때만 존재(접힘 = DOM 제거, 애니메이션 없음 — 사이드바는 통째 재렌더 구조)
    .wsg-child.wsg-local(.active)   [⌂ 15] [로컬 · main] ……… [터미널 3개 .wsg-meta]
    .wsg-child.wsg-task             [⑂ 15] [제목 .wsg-title] [×3 .wsg-fan] [▸ .wsg-caret2]
      .wsg-sub                       [● .tv-dot.{warn|error|spin|''}] [입력 대기 · +41 −7]
    .wsg-child.wsg-agent            [에이전트 마크 14] [Claude · cpt/x2m1-1 .wsg-title] [● .tv-dot]
```

지표(신규 클래스):
- `.wsg-child`: `display:flex; align-items:center; gap:7px; width:100%; min-height:30px; padding:5px 10px 5px 26px; margin-bottom:1px; border-radius:var(--r-md); background:transparent; border:none; color:var(--text2); font-size:12.5px; font-weight:500; text-align:left; cursor:pointer; user-select:none;` hover `--elevated`, `.active` `--hover` + `color:var(--text)`.
- `.wsg-task`: 두 줄(`flex-direction:column; align-items:stretch; gap:2px`). 첫 줄 `.wsg-line`(flex, gap 7). `.wsg-sub`: `padding-left:22px; font-size:11px; color:var(--dim); display:flex; align-items:center; gap:6px;`
- `.wsg-agent`: `padding-left:42px; min-height:26px; font-size:12px;`
- `.wsg-title`: `overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1;`
- `.wsg-meta`: `margin-left:auto; font-size:10.5px; color:var(--dim); white-space:nowrap;`
- `.wsg-fan`: `font-size:10.5px; font-weight:700; color:var(--text3); background:var(--elevated2); border-radius:4px; padding:0 5px; flex:none;`
- `.wsg-cnt`: `.wsg-fan` 과 같은 칩, 안에 `icons.gitBranch({size:11})` + 수. `.wsg-cnt.warn::before` = 6px 원 `--warn`(칩 앞 점). 접힘 + openCount ≥ 1 일 때만 렌더.
- `.wsg-caret`(머리 캐럿): `icons.chevronRight({size:14})`, 펼침이면 `chevronDown`. 16×16 버튼, `--dim`, hover `--text2`. 색 없음.
- `.wsg-add`: `.sb-sec-btn` 과 같은 모양(패딩 3, radius `--r-sm`, `--dim` → hover `--elevated2`/`--text2`), `icons.plus({size:13})` + 텍스트 `작업`(11px/700). 기본 `display:none`; `.wsg-head:hover .wsg-add, .wsg-head:focus-within .wsg-add { display:inline-flex }`. `title` = `작업 추가`.
- 점: 기존 `.tv-dot`(7px · warn/error/spin/기본 hollow) 를 그대로 재사용 — 새 점 클래스를 만들지 않는다.
- 아이콘: 로컬 `icons.folder({size:15})` · 작업 `icons.gitBranch({size:15})`(**신설**, `icons.js` 에 추가 — Feather `git-branch` 경로: `<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`) · 에이전트 `agentMarkHtml(agent,{size:14}) || icons.terminal({size:14})`.

`sbSig` 에 **반드시** 추가할 값(안 넣으면 화면이 안 바뀐다 — sidebar.js:183 규율): 각 워크스페이스마다 `[collapsed, branch, termCount, openCount, needsInput, tasks.map(t => [t.taskId, t.title, t.group, t.dot, t.sub.key, t.sub.diff?.a, t.sub.diff?.d, t.fanout, fanExpanded.has(t.taskId), t.runs.map(r => [r.runId, r.group, r.dot, r.agent, r.branch, r.workspaceId, r.tid])])]` — 에이전트 행 클릭 클로저·`.active` 가 `workspaceId`/`tid` 를 쓰므로 둘도 반드시 넣는다(워크스페이스 등록·tid 도착만으로는 group/dot 이 안 바뀐다). 재구축은 `.sb-list` scrollTop 과 트리 행 포커스를 새 DOM 에 옮겨 심는다(안 하면 토글마다 맨 위로 튄다).

### 3.2 모바일 (`SidebarContent.tsx`)

기존 워크스페이스 행 지표 그대로: `paddingHorizontal 10 · paddingVertical 8 · borderRadius v2.radius.md · marginBottom 2 · 이름 13.5/600 C.text2(활성 C.text) · 경로 10.5 mono C.textDim · 활성 C.elevated2 · 색 borderLeft 3 · 오프라인 opacity .55`.

컴포넌트(모두 `SidebarContent.tsx` 안 로컬 컴포넌트):
- `WsGroup({ w, group, expanded, onToggle, onAdd, ... })` — 래퍼 View.
- `WsGroupHead` — 기존 워크스페이스 `Pressable` 을 그대로 쓰되 `onPress = onToggle`, `onLongPress` = 기존 메뉴. 1행: `[CaretRight/CaretDown 14 C.textDim] [PushPin] [이름] [unread] [⑂n 칩(접힘)] [+ 버튼]`. `+` = `PressableScale`(hitSlop 8, `Plus size 15 C.textDim`, 36×28 터치 영역) — 호버가 없으니 **항상 보인다**. 캐럿 회전은 Reanimated `useAnimatedStyle` + `withTiming(expanded ? 90 : 0, {duration:160})` 로 `CaretRight` 하나를 돌린다(아이콘 교체 금지 — 깜빡임).
- `WsLocalRow` — `PressableScale scaleTo 0.98`. `[Folder 15 weight regular] [로컬 · main] …… [터미널 3개 10.5 C.textDim]`. `paddingLeft 26 · minHeight 34 · fontSize 12.5/500`. 활성 배경 `C.elevated2`, 글자 `C.text`.
- `WsTaskRow` — `PressableScale scaleTo 0.98`. 1행 `[GitBranch 15] [제목 flex] [×3 칩] [CaretRight 12(팬아웃일 때)]`, 2행(paddingLeft 22) `[StateDot tone] [입력 대기 · +41 −7 (11 C.textDim)]`. `StateDot` 은 `TaskCard.tsx` 의 export 를 **재사용**(tone 매핑: warn→'warn', error→'error', spin→'working', none→'none').
- `WsAgentRow` — `paddingLeft 42 · minHeight 30`, `[AgentLogo 14] [Claude · cpt/x2m1-1] [StateDot]`.
- 칩(`×3`, `⑂2`): `paddingHorizontal 5 · borderRadius 4 · backgroundColor C.elevated2 · fontSize 10.5/700 C.text3`. 접힘 칩 앞 warn 점 = 6px `C.warn` 원.
- 펼침/접힘·팬아웃 토글 시 `LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)` 1회(TaskList.tsx 와 같은 방식; Android 구 아키텍처 플래그는 TasksDashboardHost 가 이미 켠다 — 사이드바 마운트에서도 `UIManager.setLayoutAnimationEnabledExperimental?.(true)` 를 1회 호출한다).
- `Pressable` 함수형 style 금지. 색은 `C.*` 토큰만(StyleSheet 굳히기 금지 — 테마 전환).
- `TasksRow` 는 라벨을 `TASKS_TX.overview` 로 바꾸고 나머지 그대로(배지 warn).
- 성능: 작업 파생은 `useTasksModel(shellSlice)` 를 **한 번**(사이드바 상위에서) 호출해 `rows` 를 얻고, `buildSidebarTasks()` 결과를 `useMemo` 로 그룹에 나눠 준다. TasksRow 가 따로 부르던 `useTasksModel` 은 상위 결과를 prop 으로 받게 바꾼다(모델 두 번 계산 금지).

### 3.3 상태 어휘 (기존 §9 원문만)

| 집계 group | 점 | 부제(`sub.key`) |
|---|---|---|
| needs_input | warn(실패·op 실패는 error) | `groupNeedsInput` "입력 대기" |
| working | spin(text3 점멸) | `groupWorking` "작업 중" / 전부 creating 이면 `stateCreating` "준비 중" |
| review_ready | 없음(hollow) | `groupReviewReady` "리뷰 준비" + ` · ` + `diffStat` "+{a} −{d}" |
| idle | 없음 | `groupIdle` "대기 중" |

에이전트 자식 행 라벨 = `agentName(run.agent) + ' · ' + run.branch`(구분자 ` · ` 만 코드가 붙인다).
팬아웃 칩 = `'×' + fanout`(언어 중립 — 번역 없음).

---

## 4. 펼침/접힘 · 팬아웃 영속

| 항목 | PC | 모바일 | 기본 |
|---|---|---|---|
| 그룹 접힘 | `localStorage['cpt.sbGroupCollapsed.v1']` = JSON `{ [wsId]: 1 }`(접힌 것만 저장) | `AsyncStorage['cpt.sbGroupCollapsed.v1']` 같은 모양(메모리 정본 `useRef` + 쓰기 비동기, `ACTIVE_DEVICE_KEY` 패턴) | 펼침 |
| 팬아웃 펼침(작업 행 아래 에이전트 행) | 모듈 메모리 `Set<taskId>`(세션 한정, 영속 X) | 컴포넌트 state `Set<taskId>` | 접힘 |

- 워크스페이스가 목록에서 사라져도 키를 지우지 않아도 된다(무해). 삭제된 워크스페이스 id 는 `loadWorkspaces` 후 정합화 때 함께 걷어내면 좋지만 필수 아님.
- 접힌 그룹 안의 작업이 `needs_input` 으로 바뀌어도 **자동으로 펼치지 않는다**(사용자 선택 존중). 칩 앞 warn 점과 상단 `진행 현황 [n]` 배지가 신호다.

---

## 5. 클릭 대상 (전부)

| 대상 | PC | 모바일 |
|---|---|---|
| 그룹 머리(이름/경로 영역) | 펼침/접힘 토글. **더블클릭** = 로컬 행과 동일(워크스페이스 열기). 우클릭 = 기존 메뉴. 드래그 = 기존 순서 변경(머리끼리만; 자식 행은 draggable 아님) | 탭 = 토글(haptic.select). 롱프레스 = 기존 메뉴 |
| 머리 캐럿 | 토글(머리 클릭과 동일 — `stopPropagation` 불필요) | 동일 |
| `+ 작업` / `+` | `openNewTaskSheet({ host: Number(w.hostDeviceId ?? state.daemon?.deviceId), wsId: w.id })`(prefill 필드는 이미 있다 — new-task-sheet.js:29). `S.blockedOffline(tt('newTask'))` 가드 후, 시트가 받을 수 없는 host(기기 오프라인·`hostHasTasks===false`·서버 킬스위치에서 원격 PC)면 시트를 열지 않고 `hostOffline`/`pcNeedsUpdate`/`serverNeedsUpdate` 토스트(시트는 조용히 이 PC·첫 저장소로 바꿔 열기 때문). `e.stopPropagation()` 필수(머리 토글 방지) | `openNewTask({ host: Number(w.hostDeviceId ?? activeDev), workspaceId: w.id })`(tasksUi `NewTaskPrefill` 그대로). overlay 면 `closeDrawer()` 먼저. 그룹 호스트 오프라인이면 시트 대신 `hostOffline` 안내(시트가 다른 PC 로 조용히 바꾸기 때문). `+` 는 머리 Pressable **밖** 형제(VoiceOver 가 머리를 한 요소로 합쳐 `+` 에 못 닿는다) |
| 로컬 행 | 기존 `wsRow` 클릭 핸들러 본문 그대로(유령 다이얼로그 → wsStale 가드 → `S.setActive(w.id)`) | 기존 `onSelect(w)` 그대로(afterNav + rAF + activateNotifTerminal) |
| 작업 행 | `openTasksDashboard({ taskId, host })` — 현황판이 열리며 그 작업 상세 선택(기존) | `afterNav(); openTasksDashboard({ taskId, host })` |
| `×N` 칩 / 작업 행 캐럿 | 팬아웃 토글(`stopPropagation`) | 동일 |
| 에이전트 자식 행 | `run.workspaceId` 있으면 `openRunTerminal(run.workspaceId, run.tid, { task: true })`(tasks-view.js:201 — 목록에 없으면 새로고침까지 해 준다). 없으면 `openTasksDashboard({ taskId, runId, host })` | `run.workspaceId` 있으면 TaskCard `'terminal'` 액션과 **같은 경로**(TasksDashboardHost `onAction` 의 terminal 분기 = `setActive(run.workspaceId, {allowTask:true})` + `activateNotifTerminal(run.workspaceId, run.tid)`) 를 셸 함수로 뽑아 호출. 없으면 `openTasksDashboard({ taskId, runId, host })` |
| 상단 `진행 현황` 행 | 기존 토글(열려 있으면 닫기) | 기존 `openTasksDashboard()` |

**변경 없음 확인**: 팔레트 `tasks.dashboard`/`tasks.new`/`tasks.open` 의 라벨(`작업 현황판`/`새 작업`)은 이번 라운드에 **손대지 않는다**(palette-crossimpl 이 양쪽 표를 대조한다). 워크스페이스 뷰 헤더 `+` 메뉴의 `새 작업` 도 그대로.

**현황판 제목**: PC `tasks-view.js` 의 `tv-title` 과 뒤로 버튼 라벨(`tt("title")` 3곳: 374·375·380), 앱 `TasksDashboardHost.tsx:250` 의 `TX.title` 을 `overview` 로 바꾼다. **카드 폴백 제목(`task.title || tt("title")`)·`taskBadge` 는 `title`("작업") 유지.**

---

## 6. 빈 상태 · 오프라인 · 예외

| 상황 | 표시 |
|---|---|
| 워크스페이스에 열린 작업 0 | 로컬 행만. 빈 문구 없음(잡음 금지) |
| 접힘 + 열린 작업 0 | 칩 없음 |
| 호스트 오프라인 | 그룹 전체 `.ws-off`/opacity .55(오늘 그대로). 작업 행은 **마지막으로 본 버킷**으로 그대로 그린다(버킷은 지우지 않는다 — 설계 §5.4). 로컬 행 클릭은 오늘의 오프라인 규칙 그대로 |
| `wsStale`(서버 미가용 캐시 목록) | 그룹은 그리되 작업 행은 로컬 호스트 버킷만(다른 PC 버킷은 조회 불가). `+ 작업` 은 `blockedOffline` 이 막는다 |
| 유령(폴더 소실) | 머리에 `wsr-missing` 라벨(오늘 그대로). 로컬 행 클릭 = 소실 다이얼로그. 작업 행은 그대로 동작(worktree 는 별도 폴더) |
| 작업 `run.workspaceId == null`(등록 중/실패) | 작업 행은 보인다(`stateCreating`/해당 상태). 에이전트 행 클릭은 현황판 상세로 폴백(§5) |
| 작업 버킷 로딩/에러 | 사이드바에는 아무 표시 없음(현황판이 배너로 말한다). 직전 목록 유지 |
| 워크스페이스 0개 | 기존 안내 문구 그대로 |

---

## 7. 파일 소유권 (겹치지 않는다)

### 7.1 PC 구현자 (`codingpt_service/codingpt_pc`)
- 신규: `src/js/sidebar-tasks.js`(§2 순수 함수 `buildSidebarTasks(input)` + `summarizeSidebar(out)`), `../codingpt_daemon/docs/fixtures/agent-tasks/sidebar-01.json`(입력 + 기대 출력 — 케이스: workspaceId 매치 · repo.path 매치 · subdir 매치(긴 경로 우선) · 미등록 저장소 제외 · merged 제외 · 잔존 run 0 제외 · 팬아웃 ×3 집계(needs_input 우선) · review_ready diff · 정렬 · 접힘 칩 needsInput).
- 수정: `src/js/sidebar.js`(그룹 렌더·클릭·영속·sbSig), `src/styles.css` 사이드바 절(`.wsg-*` 신설, 기존 `.ws-row/.pc-row` 지표 불변), `src/js/icons.js`(`gitBranch` 추가 전용), `src/js/text/tasks.js`(`overview`·`local`·`addTask`·`terminalsN`·`openTasksN` 필드 추가), `src/js/tasks-view.js`(제목·뒤로 라벨 `overview`; `export function dashboardRows()` = groups 평탄화 헬퍼 추가 전용), `src/js/state.js`(`export function wsTerminalCount(id)` 추가 전용), `test/tasks-crossimpl.mjs`(sidebar-01 픽스처 대조 + 소스 계약: `tasks-row` 라벨이 `tt("overview")`, `.wsg-add` 가 `openNewTaskSheet` 에 `wsId` 를 준다), `src/js/i18n/{ko,en,ja,zh-CN,de,es,fr}.js`(§8 의 5줄을 **`"작업 현황판"` 항목 바로 아래**에 직접 삽입 — 파일 머리의 "직접 고치지 말 것" 주석은 이번 라운드 예외, emit 금지).
- 금지: `codingpt_app/**`, `master.json`, `new-task-sheet.js`(변경 불필요 — prefill 이 이미 `wsId/host` 를 받는다), `tasks-model.js`.

### 7.2 모바일 구현자 (`codingpt_app`)
- 신규: `src/workspace/tasks/sidebarTasks.ts`(PC 와 같은 입출력·같은 규칙), `__tests__/sidebarTasks.test.ts`(`sidebar-01.json` 을 경로 계약 §7.4 방식으로 읽어 대조).
- 수정: `src/components/SidebarContent.tsx`(그룹·행·영속·TasksRow 라벨), `src/workspace/tasks/TasksDashboardHost.tsx`(헤더 `TX.overview`; `'terminal'` 액션 분기를 `openRunTerminal(host, task, run)` 로 추출·export), `src/text/tasks.ts`(§8 필드 5개 + 타입), `src/contexts/WorkspaceShellContext.tsx`(필요 시 `wsTerminalCount(id)` 추가 전용), `i18n/master.json`(§8 5개 원문 × 6개 언어), `src/i18n/{ko,en,ja,zh-CN,de,es,fr}.ts`(같은 5줄을 `"작업 현황판"` 항목 바로 아래 직접 삽입 — emit 금지).
- 금지: `codingpt_pc/**`, `tasksModel.ts`, `NewTaskSheet.tsx`(prefill 이 이미 `workspaceId/host` 를 받는다), 팔레트 표.

### 7.3 공용 계약
- `sidebar-01.json` 모양: `{ "input": SidebarInput, "expect": { "<wsId>": { "openCount", "needsInput", "tasks": [{ "taskId", "group", "dot", "sub": {"key","diff"}, "fanout", "runs": [{"runId","group","dot"}] }] } } }` — `summarizeSidebar()` 가 이 모양을 만든다(title·agent·branch 는 대조 제외).
- `rows` 입력은 픽스처에 **직접 박는다**(현황판 모델을 다시 돌리지 않는다 — 사이드바 함수의 단위 계약만 본다).

---

## 8. i18n (원문 = 키. 7개 언어. 자리표시자 `{n}` 만)

| 필드(text/tasks) | ko(원문) | en | ja | zh-CN | de | es | fr |
|---|---|---|---|---|---|---|---|
| `overview` | 진행 현황 | Progress | 進行状況 | 进行状况 | Fortschritt | Progreso | Avancement |
| `local` | 로컬 | Local | ローカル | 本地 | Lokal | Local | Local |
| `addTask` | 작업 추가 | Add task | タスクを追加 | 添加任务 | Aufgabe hinzufügen | Añadir tarea | Ajouter une tâche |
| `terminalsN` | 터미널 {n}개 | {n} terminals | ターミナル {n} 件 | {n} 个终端 | {n} Terminals | {n} terminales | {n} terminaux |
| `openTasksN` | 열린 작업 {n}개 | {n} open tasks | 進行中のタスク {n} 件 | {n} 个进行中的任务 | {n} offene Aufgaben | {n} tareas abiertas | {n} tâches ouvertes |

- `terminalsN` 은 로컬 행 후행 메타. `openTasksN` 은 접힘 칩의 `title`(PC)/`accessibilityLabel`(모바일) 에만 쓴다(칩 본문은 아이콘+숫자).
- 로컬 행 라벨 = `tt('local') + (branch ? ' · ' + branch : '')` — 구분자만 코드가 붙인다(문장 조립 금지 규율의 허용 범위 = 설계 §6.0 `reviewLine` 과 동일).
- 기존 키 재사용: `groupNeedsInput`·`groupWorking`·`groupReviewReady`·`groupIdle`·`stateCreating`·`diffStat`·`newTask`·`접기`(있음)·`사이드바 펼치기` 계열은 쓰지 않는다(캐럿에 title 을 붙이지 않는다 — 머리 클릭이 곧 토글).
- master.json 항목 모양(모바일 구현자):
  ```json
  "진행 현황": { "en": "Progress", "ja": "進行状況", "zh-CN": "进行状况", "es": "Progreso", "de": "Fortschritt", "fr": "Avancement" },
  ```
- 카탈로그 삽입 줄 모양(양쪽 동일, 각 언어 값으로): `  "진행 현황": "Progress",` — ko 카탈로그는 값 = 원문. 삽입 위치 = 각 파일의 `"작업 현황판":` 줄 **바로 아래**(정렬 순서와 달라도 무방 — 객체 리터럴이라 순서 무관. 다음 emit 이 재정렬한다).
- PC `text/tasks.js` 는 `TASKS_TEXT.ko` 에 5개 필드 추가(`i18n-crossimpl.mjs` 5절이 한글 원문 전부가 7개 PC 카탈로그에 있는지 검사한다 → 카탈로그 삽입을 빠뜨리면 테스트가 잡는다). 앱 `text/tasks.ts` 는 `TasksText` 타입 + `ko` 에 추가(`terminalsN`/`openTasksN` 은 함수 값 `(n) => i18n.t('터미널 {n}개', { n })`).

---

## 9. 수동 검증 체크리스트 (완료 보고 전 — 양쪽 각각)

공통 준비: 이 Mac 데몬은 **추가 기동 금지**(PC 앱 번들 데몬과 상호 kill). 작업 2개 이상(하나는 ×3 팬아웃, 하나는 리뷰 준비)이 있는 저장소 워크스페이스 + 작업 0개 워크스페이스 + 미등록 저장소의 작업 1개를 준비한다.

PC
1. 상단 행 라벨이 `진행 현황`, 배지 = 입력 대기 수. 클릭 → 현황판 제목/뒤로 라벨도 `진행 현황`. 카드 폴백 제목·`작업: {name}` 배지는 그대로 "작업".
2. 각 워크스페이스가 그룹으로 그려지고 첫 자식이 `로컬 · <branch>`(브랜치 없으면 `로컬`), 터미널을 연 워크스페이스에만 `터미널 n개`.
3. 로컬 행 클릭 = 워크스페이스 열림(활성 하이라이트가 로컬 행에), 유령/오프라인 가드 오늘 그대로. 머리 클릭 = 토글, 더블클릭 = 열기, 우클릭 메뉴·드래그 순서·핀·색 inset 정상.
4. 작업 행: 제목·점·부제(입력 대기 warn / 작업 중 점멸 / 리뷰 준비 `+a −d` 무채색). 클릭 → 그 작업 상세. `×3` 클릭 → 에이전트 3행, 각 행 클릭 → 그 run 터미널 탭 포커스.
5. 머지된 작업이 워크스페이스 아래서 사라지고 진행 현황 완료에는 남는다. 미등록 저장소의 작업은 사이드바에 없고 진행 현황엔 있다.
6. 접기 → 칩 `⑂n`(입력 대기 있으면 앞 점 warn), 앱 재시작 후 접힘 유지. 팬아웃 펼침은 재시작 후 접힘.
7. 호버 `+ 작업` → 새 작업 시트 저장소가 그 워크스페이스로 선택돼 있음(다른 PC 워크스페이스에서도 PC/저장소 둘 다 맞음). 오프라인이면 blockedOffline.
8. 다른 PC 선택 시 그 PC 버킷의 작업만 붙는다. 호스트 오프라인이면 그룹이 흐려지고 마지막 목록 유지.
9. 사이드바 폭 200 에서 제목·부제 말줄임, 가로 스크롤 없음. `tasks.changed` 수신 후 사이드바가 갱신된다(sbSig).
10. `npm test`(tasks-crossimpl · i18n-crossimpl · palette-crossimpl) 통과. 7개 언어 전환 시 새 문구 5개가 번역돼 나온다.

모바일 (폰 + 태블릿, Android 에뮬 + iOS 시뮬 중 가능한 것)
1. 드로어의 상단 행 `진행 현황`, 헤더 `ListChecks` 아이콘이 같은 현황판을 연다(제목 `진행 현황`).
2. 그룹 머리 탭 = 토글(캐럿 회전 160ms + LayoutAnimation), 롱프레스 = 기존 메뉴. 후행 `+` → NewTaskSheet 저장소 preselect. overlay 에선 드로어가 먼저 닫힌다.
3. 로컬 행 탭 = 기존 openWs 흐름(드로어 닫힘 → 활성). 작업 행 탭 = 현황판 상세. 에이전트 행 탭 = 그 run 터미널(TaskCard 터미널 버튼과 같은 결과).
4. StateDot tone 이 현황판 카드와 일치(같은 run 이 사이드바 warn 이면 카드도 warn).
5. 접힘 영속(앱 재시작 후 유지) · 팬아웃 비영속.
6. 태블릿 도킹 사이드바에서 동일 렌더, 탭 후 드로어 유지.
7. 다크/라이트 테마 전환 시 색 토큰 반영(StyleSheet 굳힘 없음). 7개 언어 확인.
8. `npx tsc --noEmit` · `jest`(sidebarTasks·tasksModel·tasksRender) 통과. 리로드가 아니라 **재빌드/재설치**로 확인(릴리스 설치본은 metro 리로드 무효).

---

## 10. 변경 규칙

- 이 문서의 §2 규칙을 바꾸면 `sidebar-01.json` 을 먼저 고치고 양쪽 테스트를 함께 깨뜨린다.
- 문구를 추가하면 §8 표 → master.json → 양쪽 카탈로그 → `text/tasks.{js,ts}` 순서.
- 팔레트 라벨(`작업 현황판`)을 `진행 현황` 으로 맞추는 것은 다음 라운드 후보(양쪽 팔레트 표 + palette-crossimpl 동시 수정 필요).
