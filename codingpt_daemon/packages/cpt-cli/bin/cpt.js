#!/usr/bin/env node
/**
 * cpt — CodingPT 컨트롤 CLI (cmux CLI 의 CodingPT 판)
 *
 * 터미널(tmux -L codingpt) 안에서 실행되는 AI(claude/codex)나 사용자가 서비스 전체를 조작한다.
 * 데몬의 로컬 유닉스 소켓(<stateDir>/cpt.sock)으로 NDJSON one-shot 요청을 보낸다.
 *
 * 자기 좌표: TMUX_PANE 으로 tmux 에 자기 세션/window 를 조회(ctx.tmux)하고, 워크스페이스는
 * CPT_WS env(풀 세션 환경으로 주입) → tmux show-environment → 프로세스 CWD 순으로 해석한다.
 *
 * 의존성 0(순수 node) — 셸 shim 이 어디서든 exec 할 수 있게 가볍게 유지한다.
 */
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TMUX_SOCKET = 'codingpt';

// ── 인자 파서(선언적 미니멀) — --flag value / --flag / 위치 인자 ──
function parseArgv(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

// ── tmux 자기조회 — 이 CLI 가 어느 세션/window 에서 실행됐는지 ──
function findTmuxBin() {
  // win32: tmux 없음 — 세션 호스트는 term-host(웨이브 2, 계약 1) 경유 예정. 자기 좌표는
  //  env 패스트패스(CPT_TID/CPT_TSESSION)만으로 해석되므로 여기서는 조용히 포기한다.
  if (process.platform === 'win32') return null;
  const candidates = [];
  if (process.env.CPT_TMUX) candidates.push(process.env.CPT_TMUX);
  if (process.env.CODINGPT_TMUX) candidates.push(process.env.CODINGPT_TMUX);
  try {
    const p = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
    if (p) candidates.push(p);
  } catch (_) { /* noop */ }
  candidates.push('/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux');
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) { /* noop */ } }
  return null;
}

// env 패스트패스 — 데몬이 터미널 세션에 CPT_TID/CPT_TSESSION(안정 ID + 세션명 전체)을 주입한다.
//  둘 다 있으면 tmux display-message 서브프로세스를 통째로 생략한다: 훅은 한 턴에 여러 번(최대 7종)
//  실행되므로 매번 tmux 를 띄우는 비용이 그대로 claude 의 체감 지연이 된다. 세션명이 전용 세션
//  규칙("<ns>--t-<tid>")과 일치할 때만 채택 — 어긋나면 데몬 resolveCtx 의 레거시 분기가 windowId 를
//  필요로 하므로 기존 조회 경로로 폴백한다(구 세션/마이그레이션 중 호환).
function tmuxSelfFromEnv() {
  const tid = parseInt(process.env.CPT_TID || '', 10);
  const session = process.env.CPT_TSESSION || '';
  if (!Number.isFinite(tid) || tid <= 0 || !session) return null;
  const m = /^(.*)--t-(\d+)$/.exec(session);
  if (!m || parseInt(m[2], 10) !== tid) return null;
  return { session, windowIndex: tid };
}

function tmuxSelf() {
  const fast = tmuxSelfFromEnv();
  if (fast) return fast;
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  const bin = findTmuxBin();
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', pane,
      '#{session_name}\t#{window_id}\t#{window_index}\t#{pane_id}'], { encoding: 'utf8', timeout: 3000 }).trim();
    const [session, windowId, windowIndex, paneId] = out.split('\t');
    return { session, windowId, windowIndex: parseInt(windowIndex, 10), pane: paneId };
  } catch (_) { return null; }
}

// 워크스페이스(cwdRel) — env → tmux 세션 환경 → 세션명 역산 불가 시 null(데몬이 CWD 로 해석).
function resolveWs(tmuxInfo) {
  if (process.env.CPT_WS != null) return process.env.CPT_WS;
  if (tmuxInfo && tmuxInfo.session) {
    const bin = findTmuxBin();
    if (bin) {
      try {
        // 전용 세션(--t-<id>)엔 세션 자체에 CPT_WS 가 주입돼 있어 그대로 조회 가능. 레거시 뷰
        //  세션(--p-)만 풀 세션명으로 역산한다.
        const pool = tmuxInfo.session.includes('--p-') ? tmuxInfo.session.split('--p-')[0] : tmuxInfo.session;
        const out = execFileSync(bin, ['-L', TMUX_SOCKET, 'show-environment', '-t', '=' + pool, 'CPT_WS'],
          { encoding: 'utf8', timeout: 3000 }).trim();
        const m = /^CPT_WS=(.*)$/.exec(out);
        if (m) return m[1];
      } catch (_) { /* noop */ }
    }
  }
  return null;
}

// ── win32 백엔드 위임(웨이브2, 계약 1) — CPT_WS env 유실 시 term-host 세션 env 를 직접 조회 ──
//  darwin 의 `tmux show-environment` 등가. env 패스트패스(CPT_TSESSION)가 세션명을 주므로,
//  파이프(one-shot NDJSON getEnv op)로 그 세션의 CPT_WS 를 되찾는다. 의존성 0 원칙 유지 —
//  파이프 이름 규칙은 term-host paths.pipePath 의 최소 복제(sockPath 폴백과 같은 접근).
function termhostPipePath() {
  if (process.env.CPT_TERMHOST_SOCK) {
    const p = process.env.CPT_TERMHOST_SOCK;
    if (process.platform === 'win32' && !/^\\\\[.?]\\pipe\\/.test(p)) {
      const h = require('crypto').createHash('sha256').update(String(p)).digest('hex').slice(0, 8);
      return `\\\\.\\pipe\\cpt-termhost-test-${h}`;
    }
    return p;
  }
  const h = require('crypto').createHash('sha256').update(os.homedir()).digest('hex').slice(0, 8);
  return `\\\\.\\pipe\\cpt-termhost-${h}`;
}

function termhostGetEnv(session, key, timeoutMs = 800) {
  return new Promise((resolve) => {
    let conn;
    try { conn = net.createConnection(termhostPipePath()); } catch (_) { return resolve(null); }
    let buf = '';
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { conn.destroy(); } catch (_) { /* noop */ } resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, op: 'getEnv', name: session, k: key }) + '\n'));
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, i));
        finish(msg && msg.ok && typeof msg.value === 'string' ? msg.value : null);
      } catch (_) { finish(null); }
    });
    conn.on('error', () => finish(null)); // 호스트 미기동 = 조용히 포기(CWD 폴백은 데몬이 해석)
  });
}

function sockPath() {
  if (process.env.CPT_SOCK) return process.env.CPT_SOCK;
  // 단일 출처(runner-core/sock-path.js) — 데몬 번들/워크스페이스 배치 모두 runner-core 가 옆에 있다
  //  (shim 이 이 파일을 절대경로로 exec 하는 구조라 상대 위치가 보존된다). 의존성 0 원칙은 "옆에
  //  없으면 최소 폴백으로 자립"으로 지킨다 — 폴백은 sock-path.js 의 기본 규칙과 반드시 일치할 것.
  try {
    return require(path.join(__dirname, '..', '..', 'runner-core', 'sock-path.js')).clientSockPath();
  } catch (_) { /* 독립 배치 — 아래 최소 폴백 */ }
  if (process.platform === 'win32') {
    const h = require('crypto').createHash('sha256').update(os.homedir()).digest('hex').slice(0, 8);
    return '\\\\.\\pipe\\codingpt-cpt-' + h;
  }
  return path.join(os.homedir(), '.codingpt', 'cpt.sock');
}

// 소켓 요청(one-shot) — 응답 한 줄 수신 후 종료.
// 전역 --on <기기> — 화면 조작/브라우저 명령을 지정 기기로 라우팅(미지정=활성 기기). run() 에서 채움.
let GLOBAL_ON = null;

async function request(cmd, args, { timeoutMs = 65000 } = {}) {
  const tmuxInfo = tmuxSelf();
  let ws = resolveWs(tmuxInfo);
  // win32 백엔드 위임: env 유실(CPT_WS 부재)이어도 세션 좌표가 있으면 term-host 에 물어 되찾는다
  //  — darwin 의 show-environment 폴백 등가(없으면 데몬의 CWD 해석 폴백 그대로).
  if (ws == null && process.platform === 'win32') {
    const sess = (tmuxInfo && tmuxInfo.session) || process.env.CPT_TSESSION || '';
    if (sess) ws = await termhostGetEnv(sess, 'CPT_WS').catch(() => null);
  }
  return new Promise((resolve, reject) => {
    const ctx = {
      cwd: process.cwd(),
      ws,
      tmux: tmuxInfo || undefined,
    };
    // --on 은 ui.*/browser.* 계열에만 의미 있음(기기 타겟팅) — 데몬 dispatch 가 args.on 으로 해석.
    if (GLOBAL_ON && (cmd.startsWith('ui.') || cmd.startsWith('browser.'))) {
      args = { ...(args || {}), on: GLOBAL_ON };
    }
    const sock = sockPath();
    const conn = net.createConnection(sock);
    let buf = '';
    // settled 가드 — 아래 close 핸들러가 정상 응답 후의 종료를 오류로 오해하지 않게(그리고 승인 경로에서
    //  "응답 전 소켓 끊김"을 타임아웃까지 기다리지 않고 즉시 알리게) 한다.
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      try { conn.destroy(); } catch (_) { /* noop */ }
      done(reject, new Error('데몬 응답 시간 초과'));
    }, timeoutMs);
    conn.on('connect', () => {
      conn.write(JSON.stringify({ id: 'c' + Date.now(), cmd, args, ctx }) + '\n');
    });
    conn.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try {
        const res = JSON.parse(buf.slice(0, i));
        if (res.ok) done(resolve, res.result);
        else done(reject, Object.assign(new Error(res.error || '실패'), { code: res.code }));
      } catch (e) { done(reject, e); }
      try { conn.end(); } catch (_) { /* noop */ }
    });
    conn.on('error', (e) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        done(reject, new Error(`CodingPT 데몬에 연결할 수 없습니다 (${sock}) — 데몬/데스크톱 앱이 실행 중인지 확인하세요.`));
      } else done(reject, e);
    });
    // 응답 없이 닫힘(데몬 재시작·인수·크래시) — 타이머까지 매달리면 승인 훅이 그만큼 claude 를 세운다.
    conn.on('close', () => {
      done(reject, Object.assign(new Error('데몬 연결이 응답 전에 끊겼습니다'), { code: 'DAEMON_GONE' }));
    });
  });
}

function printJson(v) { process.stdout.write(JSON.stringify(v, null, 2) + '\n'); }

/**
 * 접근성 요소가 검색어와 맞는가 — 라벨 우선, 값(리소스 id·본문)도 본다.
 *  대소문자를 무시하고 **부분 일치**다: 화면의 라벨은 "설정 1개의 새로운 알림" 처럼 뒤에 상태가
 *  붙어 오는 일이 흔해서, 정확히 일치만 허용하면 사람이 보는 것과 어긋난다.
 */
function matchesEl(e, q) {
  const s = `${e.label || ''}\n${e.value || ''}`.toLowerCase();
  return s.includes(q);
}

function out(v, flags, human) {
  if (flags.json || human == null) printJson(v);
  else process.stdout.write(human + '\n');
}

// ChatMsg(정규화 트랜스크립트 메시지) 1건 → 사람이 읽는 한 줄(+본문). --json 이면 원본이 나간다.
//  seq 를 항상 앞에 찍는다 — `cpt transcript --since <seq>` 로 이어 읽을 때 그 값이 필요하다.
function renderChatMsg(m) {
  const role = { user: '사용자', assistant: '에이전트', system: '시스템' }[m.role] || m.role || '?';
  const head = `[${m.seq}] ${role}/${m.kind}${m.hidden ? ' (접힘)' : ''}`;
  if (m.kind === 'tool_use' && m.tool) {
    return `${head} ${m.tool.title || m.tool.name}${m.tool.path ? ` — ${m.tool.path}` : ''}`
      + `${m.tool.argsPreview ? `\n    ${String(m.tool.argsPreview).replace(/\n/g, '\n    ')}` : ''}`;
  }
  if (m.kind === 'tool_result' && m.result) {
    return `${head} ${m.result.ok ? 'ok' : '실패'} ${m.result.bytes != null ? `${m.result.bytes}B` : ''}`
      + `${m.result.preview ? `\n    ${String(m.result.preview).replace(/\n/g, '\n    ')}` : ''}`;
  }
  if (m.kind === 'question' && m.question) {
    const opts = (m.question.options || []).map((o) => `- ${o.label}`).join('\n    ');
    return `${head} ${m.question.header || ''} ${m.question.question || ''}${opts ? `\n    ${opts}` : ''}`;
  }
  const text = m.text ? String(m.text) : '';
  return `${head}${text ? `\n    ${text.replace(/\n/g, '\n    ')}${m.truncated ? ' …(잘림)' : ''}` : ''}`;
}

const HELP = `cpt - CodingPT 를 유닉스 소켓으로 조작 (터미널 안의 AI/사용자용)

사용법: cpt [--json] <command> [args]

컨텍스트:
  CodingPT 터미널에서 실행하면 자기 워크스페이스/터미널을 자동 인지한다(CPT_WS/TMUX_PANE).
  터미널 인덱스를 받는 명령은 생략 시 "자기 자신"이 대상이다.

명령:
  identify                              내 좌표(워크스페이스/터미널) 확인
  devices                               접속 중인 화면(기기) 목록 (● = 지금 활성 기기)
  capabilities                          지원 명령 목록
  ping
  agent status                          이 워크스페이스 에이전트 상태(● 작업중 ○ 유휴 ✋ 승인대기)
  hooks doctor                          훅 배선 진단(상태·알림이 안 올 때 원인 확인)
  agents [rescan]                       이 PC 의 AI CLI 목록(● 연동 ○ 연동꺼짐 · 미설치)

  # 작업(Agent Tasks — 조회 전용. 만들기·커밋·머지·폐기는 앱/PC 화면에서 사람이 한다)
  task list [--all]                     이 PC 의 작업 목록(* = 이 터미널이 그 작업의 실행)
  task get [<taskId>]                   작업 상세(프롬프트 포함). 생략 시 이 터미널이 속한 작업

  # 자동화 (반복·조건 작업 — 이 PC 에 산다. 만들기 전에 auto schema 를 읽어라)
  auto list                             이 PC 의 자동화(이름·트리거·다음 실행·마지막 결과)
  auto get <id>                         자동화 상세 + 실행 기록 꼬리
  auto create --file <spec.json> | -    Draft JSON(- = stdin) 으로 만들기 → id 출력. --dry-run = 검증만
  auto update <id> --file <patch.json>  patch = {name?, trigger?, actions?, guards?, enabled?}
  auto pause|resume|run|remove <id>     일시정지 / 재개 / 지금 실행 / 삭제
  auto log [<id>] [--limit <n>=100]     실행 기록(감사 로그)
  auto schema                           Draft 스키마 + 템플릿 변수 + 예시 3개(가이드 7-3 절)

  # 터미널 (전 기기 공유 풀)
  terminal list                         터미널 목록(이름/실행 중 명령)
  terminal new [--name <이름>]          새 터미널 생성(전 기기에 나타남)
  terminal close [<idx>]                터미널 삭제(전 기기)
  terminal rename <이름> [--index <n>]  터미널 이름 변경
  terminal wait [<idx>] [--for idle|permission|any] [--timeout-sec <n>=600]
                                        다른 터미널의 에이전트가 유휴/승인대기 될 때까지 대기(자기 자신은 --force)
  read-screen [<idx>] [--lines <n>]     터미널 화면/스크롤백 읽기
  send [<idx>] <text> [--enter]         터미널에 텍스트 입력(자기 자신은 --force)
  send-key [<idx>] <key>                특수키 입력 (C-c, Enter, Up ...)

  # 이슈 — CodingPT 자체 이슈 + 이 폴더의 GitHub 이슈(한 목록). 사용자가 PC·폰의 이슈 화면에서 같은 것을 본다
  issue list [--all] [--status <s>] [--source codingpt|github] [--done]   이 워크스페이스의 열린 이슈
  issue show <id|#번호>                  본문까지
  issue create --title "<제목>" [--body "<본문>"] [--priority low|medium|high|urgent] [--labels a,b] [--github]
  issue update <id|#번호> [--status todo|in_progress|in_review|done] [--title …] [--body …] [--priority …]
  issue close <id|#번호> · issue delete <id|#번호>(자체 이슈만)
  issue start <id|#번호> [--mode task|terminal|orch] [--agent …]   그 이슈로 에이전트를 시작(task = 전용 브랜치)

  # 오케스트레이션 — 다른 에이전트에게 일을 나눠 맡기고 결과를 받는다 (전체: cpt skills get cpt-orch)
  orch status                           내 역할(코디네이터/워커)·상한
  orch run-create --objective "<목표>"  묶음 만들기(내 터미널이 코디네이터가 된다)
  orch worker-start --spec "<일>" [--title "<짧은 제목>"] [--agent claude|codex|gemini] [--worktree current|new] [--model <id>] [--effort <e>]
                                        워커 띄우기(일 + 시도를 한 번에). --task <id> 로 이미 만든 일에, --terminal <n> 로 끝난 워커 재사용
  orch check [--wait] [--types worker_done,escalation,question] [--timeout-ms <ms>] [--ack <deliveryId>] [--peek]
                                        수신함 확인(--wait 는 올 때까지 기다림, 기본 100초 — 시간 초과는 실패가 아니다)
  orch reply --id <messageId> --body "<답>"            워커의 질문에 답하기
  orch send --to dispatch:<id>|@all|@idle|@<agent> --subject "…" --body "…"   워커에게 추가 지시
  orch worker-list | worker-show --dispatch <id> | worker-read --dispatch <id> [--limit <줄>]
  orch worker-release --dispatch <id> [--merge [merge|squash|ff]] [--message "…"]   끝난 워커 정리(작업 폴더면 머지 또는 폐기)
  orch worker-retain|worker-stop|worker-abandon --dispatch <id>
  orch task-create --spec "<일>" [--deps <id,id>] | task-list [--ready] [--brief] | task-update --task <id> --status <s>
  orch gate-create --question "<결정>" --options "a,b" [--task <id>] | gate-resolve --id <id> --resolution "<선택>" | gate-list
  orch run-show | run-list [--all] | run-close [--force]
  # (워커 전용) orch done|ask|heartbeat|escalate — 띄워질 때 받은 안내문에 정확한 명령이 들어 있다

  # 워크스페이스
  ws set [--comment "<한 줄>"] [--status todo|in-progress|in-review|completed] [--clear]
                                        사이드바 카드에 보이는 한 줄 메모·단계(체크포인트마다 갱신)
  ws list                               워크스페이스 목록
  ws new <이름> [--parent <경로>]       새 워크스페이스 생성(git init)
  ws clone <git-url> [--name <이름>]    GitHub 레포 클론
  ws delete <id>                        워크스페이스를 목록에서 삭제(로컬 폴더/파일은 유지)
  ws select <id>                        전 기기에서 이 워크스페이스로 전환

  # 화면 배치 (사용자가 보고 있는 활성 기기에 반영 — --on <기기> 로 특정 기기 지정)
  layout tree                           현재 레이아웃 트리(활성 기기 기준)
  layout split <left|right|up|down> [--type terminal|preview|ide] [--url <u>] [--path <p>]
  layout focus <paneId>                 pane 포커스
  layout close <paneId>                 pane/surface 닫기
  preview open <url|:port>              프리뷰 열기(새 pane)
  preview navigate <url>                활성 프리뷰 이동
  preview reload                        활성 프리뷰 새로고침
  preview close                         프리뷰 닫기
  preview devtools [on|off]             개발자도구 토글(보고 있는 기기)
  preview info                          현재 URL/제목/뷰포트
  preview inspect [--off]               요소 선택(디자인) 모드 시작 — 사용자가 화면에서 클릭하면
                                        [디자인] 소스위치+크롭샷 줄이 터미널에 삽입됨(--off=취소)
  preview handoff --to <기기>           현재 프리뷰를 다른 기기로 이어주기(세션·쿠키·localStorage 포함)
  ide open <파일경로> [--line <n>]      IDE 로 파일 열기(해당 줄로 이동)
  ide diff <파일경로> [--staged]        git diff 를 IDE 에 읽기 전용 문서로 표시(변경 없으면 "변경 없음")
  ide open-changed [--mode edit|diff|both] [--staged] [--max <n>=10]
                                        변경된 파일 일괄 열기(기본 diff)
  ide close                             IDE pane 닫기
  ide close-file <파일경로>             열린 파일 탭 하나 닫기
  ide list                              지금 열린 파일 목록
  review [<파일>...] [--staged] [--title <t>] [--timeout <초>=1800]
                                        지금 변경한 것을 사용자에게 **리뷰받는다**. IDE 가 리뷰 모드로
                                        바뀌고 사용자가 덩어리마다 승인/거절·코멘트를 단 뒤 보내면
                                        그 결과가 JSON 으로 돌아온다(파일 생략 = 변경된 파일 전부).
                                        결과: {status:"submitted"|"cancelled"|"timeout", files:[...]}

  # 에이전트 PC (이 맥 안의 별도 macOS — 사용자 화면을 건드리지 않고 GUI 를 조작한다)
  #  네이티브 앱·창을 다뤄야 하면 사용자 화면이 아니라 **여기서** 한다. 좌표는 0~1 비율.
  desktop status                        macOS·Linux 둘 다 요약(--os 로 하나만 상세)
  ── macOS·Linux 는 동시에 따로 돕니다 — 아래 모든 명령에 --os macos|linux 를 붙여 고른다(기본 macOS) ──
  desktop start | stop                  켜기(정지 상태면 수십 초) / 끄기   (예: cpt desktop --os linux start)
  desktop provision                     첫 설정 다시(자동 로그인·절전 끔 — 처음 켤 때는 자동으로 한다)
  desktop snapshot [라벨] | snapshots    지금 상태를 저장(끄고 2초 복제·다시 켬 ~30초) / 목록 — 위험한 작업 전에
  desktop restore <이름>                 스냅샷으로 되돌리기(지금 상태는 사라진다 — 먼저 사용자에게 알려라)
  desktop show                          사용자가 보고 있는 기기에 데스크톱 탭을 띄운다
  desktop open <앱|URL>                 앱 실행(open -a) 또는 게스트 브라우저로 URL(호스트 localhost 자동 변환)
  desktop run -- <명령>                 게스트 셸에서 실행
  desktop screenshot [--out <파일>] [--width <px>=1280]
  desktop ax [앱] [--all|--json]         ★ 화면을 읽는다 — 접근성 트리(요소·글·0~1 좌표). 스크린샷 좌표 추정 대신 이걸 먼저
  desktop tap "<글자>" [--app 앱]        글자로 요소를 찾아 클릭(버튼·링크·메뉴·입력칸 — title/설명/값/placeholder)
  desktop click <x> <y> [--right] · double-click · right-click · move · drag <x> <y> <x2> <y2> · scroll <x> <y> [dy]
  desktop key <조합>                    예: key cmd+space · key enter · key cmd+shift+4
  desktop type <글자>                   ASCII 는 키로, 한글 등은 클립보드+⌘V 로
  desktop handoff <사유>                사용자에게 개입 요청(로그인 등) — [계속] 을 누를 때까지 기다린다
  desktop pause | resume                에이전트 입력 멈춤/재개
  desktop path <경로>                   호스트 경로 → 게스트 공유 폴더 경로
  desktop connect [폴더] | disconnect   폴더를 에이전트 PC 에 공유(기본=이 워크스페이스 · 어떤 경로든 · 켜져 있으면 다시 켜서 바로 반영)

  # 모바일 화면 (안드로이드 에뮬레이터/실기기 · iOS 시뮬레이터)
  #  좌표는 **0~1 비율**이다(0.5 0.5 = 화면 한가운데). 픽셀이 아니다 — 기기마다 해상도가 달라서.
  emulator list                         붙어 있는 기기 목록(켜짐/꺼짐, 조작 가능 여부 포함)
  emulator show [--device <id>]         사용자가 보고 있는 기기에 **모바일 화면 탭을 띄운다**
                                        (--device 생략 = 켜져 있는 기기 중 첫 번째 · --on <기기> 로
                                        어느 화면에 띄울지 지정). 프리뷰/IDE 를 여는 것과 같은 급.
  emulator hide                         띄운 모바일 화면 탭 닫기
  emulator boot --device <id>           꺼진 에뮬레이터/시뮬레이터 켜기(수십 초 걸림 — 기다리지 않는다)
  emulator shutdown --device <id>       끄기
  emulator screenshot --device <id> [--out <파일>] [--width <px>=720] [--quality <n>=80]
                                        지금 화면을 파일로 저장(경로를 알려 준다 — Read 로 보면 된다)
  emulator tap --device <id> <x> <y>    탭. 예: emulator tap --device android:emulator-5554 0.5 0.9
  emulator long-press --device <id> <x> <y>
  emulator swipe --device <id> <x> <y> <x2> <y2> [--ms <n>=220]
  emulator key --device <id> <키>       home|back|recents|enter|del|tab|escape|up|down|left|right
                                        |volumeUp|volumeDown|lock (iOS: home|lock|siri)
  emulator rotate --device <id> [portrait|landscape]
                                        기기를 세로/가로로 (생략하면 landscape). 홈 화면처럼 세로
                                        고정인 화면은 OS 가 거부한다 — 그때는 화면만 눕는다.
  emulator text --device <id> <문자열>  글자 입력
  emulator open --device <id> <url>     주소/딥링크 열기

  # 브라우저 자동화 (프리뷰 페이지 — 한 기기에서 실행해 결과 회신)
  browser snapshot                      인터랙티브 요소 트리(ref 포함)
  browser click <ref|selector>          또는 좌표: browser click --x <n> --y <n>
  browser scroll [--dy <n>] [--dx <n>] [--x <n>] [--y <n>] [<ref|selector>]
  browser press <key> [--target <sel>] [--mod ctrl,shift] [--text <t>]  (Enter/Escape/Tab/Arrow*/문자)
  browser type <ref|selector> <text>
  browser fill <ref|selector> <value>
  browser eval <js>
  browser wait [--selector <css>] [--text <t>] [--timeout-ms <ms>]
  browser get <url|title|text|html> [--selector <css>]
  browser screenshot [--out <path>]     캡처(--out 없으면 ~/.codingpt/tmp/shot-<ts>.jpg 저장)
  browser console [--limit <n>=100] [--level error|warn|info|log] [--pattern <regex>] [--clear]
                                        프리뷰 웹뷰 콘솔 로그 조회(--clear 는 버퍼 비움)
  browser network [--limit <n>=50] [--pattern <url정규식>] [--status 4xx|5xx|err|<숫자>] [--clear]
                                        프리뷰 웹뷰 네트워크 요청 조회(fetch/XHR — --clear 는 버퍼 비움)

  # 알림/상태 (전 기기 동기화)
  notify --title <t> [--subtitle <s>] [--body <b>]
  notifications [--limit <n>]           알림 목록
  notifications read-all                모두 읽음
  set-status <key> <value> [--icon <i>] [--color <#hex>]
  clear-status [<key>]
  set-progress <0.0-1.0> [--label <text>]
  clear-progress
  log [--level info|warn|error] <message>
  status                                이 워크스페이스의 상태/로그 보기

  # 원격 승인 / 대화 로그 (조회 전용 — 승인 응답과 프롬프트 입력은 앱/PC 화면에서 한다)
  approval list                         지금 원격 응답을 기다리는 승인 요청 목록
  transcript [--since <seq>] [--limit <n>=40] [--session <id>]
                                        이 터미널 에이전트의 대화 로그 읽기(--since = 그 seq 이후만)
  transcript sessions                   이 워크스페이스의 대화 세션 목록(● = 진행 중)

  # 작업(전용 작업 폴더 = git worktree 에서 다른 에이전트가 맡는 일)
  task list [--all] | task get [<taskId>]
  task create --prompt "<맡길 일>" [--agent <id>] [--model <id>] [--base <branch>]   인계(결과를 기다리지 않는다)
  task commit <taskId> --message "…" | task merge <taskId> [--message "…"] | task discard <taskId> [--force]

  # 스킬 가이드 (AI 용 전체 사용법 — 이 CLI 로 무엇을 할 수 있는지)
  skills get cpt-cli                    버전 일치 전체 가이드 출력(태스크 중심)
  skills get cpt-orch                   오케스트레이션 가이드(워커 띄우기·수신함·질문/답·정리)

옵션: --json (원본 JSON 출력), --on <기기> (화면 조작/브라우저를 특정 기기로 — 이름 부분일치·#id·pc/mobile),
      --sid <표면id> (특정 프리뷰/IDE 대상 지정)

환경: CPT_WS(워크스페이스), CPT_SOCK(소켓 경로), CPT_TID/CPT_TSESSION(터미널 좌표 — 있으면 tmux 조회 생략), TMUX_PANE(자동)
      CPT_APPROVAL=0 (원격 승인 끄기 — 승인은 항상 이 PC 터미널에서만 답한다)
`;

async function main() {
  const argv = process.argv.slice(2);
  const { flags, pos } = parseArgv(argv);
  const [c1, c2, ...rest] = pos;

  if (!c1 || c1 === 'help' || flags.help) { process.stdout.write(HELP); return; }

  // 전역 --on <기기> — 이후 ui.*/browser.* 요청에 자동 동봉(기기 타겟팅).
  GLOBAL_ON = typeof flags.on === 'string' ? flags.on : null;

  // 위치 인자에서 "터미널 인덱스(숫자)" 선택적 소비.
  const takeIdx = (arr) => (arr.length && /^\d+$/.test(arr[0]) ? { index: parseInt(arr.shift(), 10) } : {});

  const run = async () => {
    switch (c1) {
      case 'ping': return out(await request('ping', {}), flags, 'pong');
      case 'capabilities': return printJson(await request('capabilities', {}));
      // 에이전트 상태 — 이 워크스페이스 터미널들이 지금 무엇을 하고 있나(훅 1차 / 관찰 폴백).
      case 'agent': {
        if (c2 === 'status') {
          const r = await request('agent.status', {});
          const arr = (r && r.terminals) || [];
          const GLYPH = { working: '●', idle: '○', permission: '✋', needsInput: '?', ended: '×', launching: '·' };
          return out(r, flags, arr.map((t) =>
            `${GLYPH[t.state] || '?'} [${t.tid}] ${t.state}${t.hookGoverned ? '' : ' (관찰 폴백)'}`
            + `${t.agent ? ` ${t.agent}` : ''}${t.summary ? ` — ${String(t.summary).split('\n')[0].slice(0, 60)}` : ''}`
          ).join('\n') || '(에이전트 없음)');
        }
        process.stderr.write('사용법: cpt agent status\n');
        process.exitCode = 2;
        return;
      }
      // 훅 배선 진단 — "상태/알림이 안 온다" 의 원인(PATH 경쟁·구버전 shim·비활성)을 판별한다.
      case 'hooks': {
        if (c2 === 'doctor') {
          const r = await request('hooks.doctor', {});
          const lines = [
            `훅 설정: ${r.hooksFile}`,
            `등록 이벤트(${(r.hookEvents || []).length}): ${(r.hookEvents || []).join(', ') || '(없음)'}`,
            `claude 래퍼: ${r.wrapper && r.wrapper.exists ? '있음' : '없음'}${r.wrapper && r.wrapper.injectsSettings ? ' (--settings 주입)' : ' (주입 안 함)'}`,
            `훅 비활성(CPT_HOOKS_DISABLED): ${r.hooksDisabled ? '예' : '아니오'}`,
            '',
            '터미널:',
            ...(r.terminals || []).map((t) =>
              `  [${t.tid}] ${t.state} v${t.version} src=${t.source}`
              + ` 훅=${t.lastHookAt ? `${Math.round(t.hookAgeMs / 1000)}초 전` : '미도착'}`
              + `${t.hookGoverned ? ' (훅 지배)' : ''}`),
            '',
            r.ok ? '✓ 문제 없음' : '문제:',
            ...(r.problems || []).map((p) => `  · ${p}`),
          ];
          return out(r, flags, lines.join('\n'));
        }
        process.stderr.write('사용법: cpt hooks doctor\n');
        process.exitCode = 2;
        return;
      }
      case 'agents': {
        // 이 PC 에 설치된 AI 코딩 CLI 목록. 등급을 정직하게 찍는다(배선되는 것과 실행만 되는 것 구분).
        //  배선 토글(agents.wire)은 일부러 CLI 에 없다 — 터미널 안의 AI 가 자기 승인 훅을 스스로
        //  끄는 경로가 되기 때문(설정 화면에서 사람이 한다).
        const r = await request('agents.list', { refresh: c2 === 'rescan' });
        const TIER = { full: '완전 연동', partial: '알림만', launch: '실행 전용' };
        const lines = (r.agents || []).map((a) => {
          const mark = a.installed ? (a.wired ? '●' : '○') : '·';
          const tail = a.installed
            ? `${a.version ? 'v' + a.version + ' ' : ''}${TIER[a.tier] || a.tier}${a.wirable && !a.wired ? ' (연동 꺼짐)' : ''}`
            : '미설치';
          return `${mark} ${a.name} (${a.bin}) — ${tail}`;
        });
        return out(r, flags, lines.join('\n') || '(카탈로그 비어 있음)');
      }
      // 작업(Agent Tasks) — 읽기 2개만. 자기 run 은 CPT_TSESSION 으로 찾는다(새 env 없음 — 설계 §2.1).
      //  쓰기(task.create/git.commit/…)는 CLI 에 없다: 터미널 안의 AI 가 스스로 작업을 늘리거나
      //  자기 브랜치를 머지하는 경로가 되기 때문(agents.wire·approval.respond 를 닫은 것과 같은 이유).
      case 'task': {
        const self = process.env.CPT_TSESSION || '';
        const runLine = (r) => `${r.tsession && r.tsession === self ? '*' : ' '} [${r.idx}] ${r.agent} ${r.state}`
          + `${r.trustPending ? ' (폴더 신뢰 확인 필요)' : ''}${r.agentGone ? ' (에이전트 없음)' : ''}`
          + `${r.diff ? ` 파일 ${r.diff.files} +${r.diff.additions} -${r.diff.deletions}` : ''}`
          + `${r.commits ? ` 커밋 ${r.commits.ahead}` : ''}${r.pr ? ` PR #${r.pr.number}(${r.pr.state})` : ''}`
          + ` ${r.branch}${r.error ? ` — ${r.error.code}` : ''}`;
        if (c2 === 'list') {
          const r = await request('task.list', { includeClosed: !!flags.all });
          const items = (r && r.items) || [];
          return out(r, flags, items.map((t) =>
            `${t.id} [${t.state}] ${t.title} — ${t.repo && t.repo.name} · base ${t.base}\n${t.runs.map(runLine).join('\n')}`,
          ).join('\n\n') || '(작업 없음)');
        }
        if (c2 === 'get') {
          let taskId = rest[0];
          if (!taskId) {
            if (!self) { process.stderr.write('taskId 를 주거나 작업 터미널 안에서 실행하세요(CPT_TSESSION 없음)\n'); process.exitCode = 2; return; }
            const l = await request('task.list', { includeClosed: true });
            const hit = ((l && l.items) || []).find((t) => t.runs.some((x) => x.tsession === self));
            if (!hit) { process.stderr.write('이 터미널은 작업의 실행이 아닙니다\n'); process.exitCode = 1; return; }
            taskId = hit.id;
          }
          const r = await request('task.get', { taskId });
          const t = r && r.task;
          if (!t) return printJson(r);
          return out(r, flags, [
            `${t.id} [${t.state}] ${t.title}`,
            `저장소: ${t.repo.path}${t.repo.subdir ? '/' + t.repo.subdir : ''} · base ${t.base}`,
            '실행:', ...t.runs.map(runLine),
            '', '프롬프트:', t.prompt || '',
          ].join('\n'));
        }
        // 쓰기(2026-10-06 — 사용자 결정으로 개방): 인계(새 작업 폴더에서 다른 에이전트가 이어받는다)와 머지·폐기.
        //  이전에는 "AI 자기증식·자기머지 금지" 로 닫혀 있었다. 폭주 방지는 tasks.js 의 상한(TASK_LIMIT)이 맡는다.
        const opId = () => `cli-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const runRef = async () => {
          let taskId = flags.task || rest[0];
          let runId = flags.run || null;
          if (!taskId) throw new Error('taskId 가 필요합니다 (cpt task list 로 확인)');
          if (!runId) {
            const g = await request('task.get', { taskId });
            const runs = (g && g.task && g.task.runs) || [];
            const open = runs.filter((x) => x.state !== 'discarded' && x.state !== 'merged');
            if (open.length !== 1) throw new Error(`실행이 ${open.length}개입니다 — --run <runId> 로 고르세요`);
            runId = open[0].id;
          }
          return { taskId, runId };
        };
        const waitOp = async (taskId, runId, id, first) => {
          let lo = first && first.lastOp && first.lastOp.opId === id ? first.lastOp : null;
          const until = Date.now() + 240000;
          while (!lo && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 500));
            const g = await request('task.get', { taskId });
            const r = g && g.task && g.task.runs.find((x) => x.id === runId);
            if (!r) return { ok: true };
            if (r.lastOp && r.lastOp.opId === id) lo = r.lastOp;
            else if (!r.op && (r.state === 'merged' || r.state === 'discarded')) return { ok: true, state: r.state };
          }
          return lo || { ok: false, code: 'TIMEOUT', message: '시간 안에 끝나지 않았습니다' };
        };
        if (c2 === 'create') {
          const prompt = typeof flags.prompt === 'string' ? flags.prompt : rest.join(' ');
          if (!prompt) { process.stderr.write('사용법: cpt task create --prompt "<맡길 일>" [--agent claude|codex|gemini] [--model <id>] [--effort <e>] [--base <branch>] [--title <t>]\n'); process.exitCode = 2; return; }
          const id = await request('identify', {});
          const r = await request('task.create', {
            opId: opId(), repo: typeof flags.repo === 'string' ? flags.repo : (id.ws || ''),
            base: typeof flags.base === 'string' ? flags.base : (await request('git.branches', { repo: typeof flags.repo === 'string' ? flags.repo : (id.ws || '') }).then((b) => b.current || b.default || 'main').catch(() => 'main')),
            prompt, title: typeof flags.title === 'string' ? flags.title : undefined,
            agents: [{ id: typeof flags.agent === 'string' ? flags.agent : 'claude', model: typeof flags.model === 'string' ? flags.model : null, effort: typeof flags.effort === 'string' ? flags.effort : null }],
          });
          const t = r && r.task;
          return out(r, flags, t ? `${t.id} 생성 — ${t.runs.map((x) => `${x.agent} ${x.branch}`).join(', ')}` : 'ok');
        }
        if (c2 === 'commit' || c2 === 'merge' || c2 === 'discard') {
          const ref = await runRef();
          const id = opId();
          const method = c2 === 'commit' ? 'git.commit' : c2 === 'merge' ? 'git.merge.local' : 'task.discard';
          const args = c2 === 'commit' ? { message: String(flags.message || rest.slice(1).join(' ') || '') }
            : c2 === 'merge' ? { method: typeof flags.method === 'string' ? flags.method : 'merge', ...(typeof flags.message === 'string' ? { commitMessage: flags.message } : {}) }
              : { force: !!flags.force };
          const first = await request(method, { ...ref, opId: id, ...args });
          const lo = await waitOp(ref.taskId, ref.runId, id, first);
          if (lo && lo.ok === false) { process.exitCode = 1; return out(lo, flags, `실패: ${lo.code || ''} ${lo.message || ''}`.trim()); }
          return out(lo || first, flags, c2 === 'commit' ? '커밋됨' : c2 === 'merge' ? '머지됨' : '폐기됨');
        }
        process.stderr.write('사용법: cpt task list [--all] | get [<taskId>] | create --prompt "…" | commit <taskId> --message "…" | merge <taskId> [--message "…"] | discard <taskId> [--force]\n');
        process.exitCode = 2;
        return;
      }
      // 자동화(docs/automation-design.md §5.7) — 에이전트가 반복·조건 작업을 스스로 등록하는 유일한 표면.
      //  데몬이 게이트한다: CodingPT 터미널 밖(AUTO_OUT_OF_TERMINAL)·자동화가 만든 작업의 터미널(AUTO_LOOP) 거부.
      //  전체 일시정지(auto.pauseAll)는 CLI 에 없다 — 사람 UI 전용 킬스위치.
      case 'auto': return autoCommand(c2, rest, flags);
      // 오케스트레이션(docs/orchestration-design.md) — 에이전트가 다른 에이전트를 부린다. 호출자는 터미널 좌표로 식별된다.
      case 'orch': return orchCommand(c2, rest, flags);
      case 'issue': return issueCommand(c2, rest, flags);
      case 'devices': {
        // 접속 중인 화면(기기) 목록 — --on <기기> 타겟 지정 재료. ● = 지금 활성(executor).
        const r = await request('ui.devices', {});
        const arr = (r && r.devices) || [];
        return out(r, flags, arr.map((d) =>
          `${d.executor ? '●' : '○'} ${d.deviceName || '(이름없음)'} (${d.kind}${d.foreground ? '' : ', bg'})${d.deviceId != null ? ` [#${d.deviceId}]` : ''}`
        ).join('\n') || '(접속된 화면 없음)');
      }
      case 'identify': {
        const r = await request('identify', {});
        return out(r, flags, `workspace: ${r.ws || '(홈)'}\nterminal: ${r.windowIndex != null ? r.windowIndex : '-'} (${r.windowId || '-'})\nrunner: ${r.runner}`);
      }

      case 'terminal': {
        if (c2 === 'list') {
          const r = await request('terminal.list', {});
          const lines = (r.windows || []).map((w) => `${w.index}\t${w.name}${w.command && !/^(zsh|bash|sh|fish)$/.test(w.command) ? ' · ' + w.command : ''}`);
          return out(r, flags, lines.join('\n') || '(터미널 없음)');
        }
        if (c2 === 'new') {
          const r = await request('terminal.new', { name: flags.name });
          return out(r, flags, `터미널 ${r.index} 생성됨 (${r.name})`);
        }
        if (c2 === 'close') {
          const a = takeIdx(rest);
          const r = await request('terminal.close', a);
          return out(r, flags, 'ok');
        }
        if (c2 === 'rename') {
          const a = takeIdx(rest);
          const name = rest.join(' ');
          const r = await request('terminal.rename', { ...a, index: flags.index != null ? parseInt(flags.index, 10) : a.index, name });
          return out(r, flags, `터미널 ${r.index} → "${r.name}"`);
        }
        if (c2 === 'wait') {
          // 다른 터미널 에이전트가 idle/permission 이 될 때까지 대기 — 데몬이 폴링, CLI 는 그만큼 길게 기다린다.
          const a = takeIdx(rest);
          const timeoutSec = flags['timeout-sec'] ? parseInt(flags['timeout-sec'], 10) : 600;
          const r = await request('terminal.wait', { ...a, for: flags.for, timeoutSec, force: !!flags.force },
            { timeoutMs: (timeoutSec + 15) * 1000 });
          return out(r, flags, r.timeout ? `타임아웃 (state=${r.state})` : `${r.state} (${(r.waitedMs / 1000).toFixed(1)}s 대기)`);
        }
        break;
      }
      case 'read-screen': {
        const arr = [c2, ...rest].filter((v) => v !== undefined);
        const a = takeIdx(arr);
        const r = await request('terminal.read', { ...a, lines: flags.lines ? parseInt(flags.lines, 10) : undefined });
        return out(r, flags, r.text);
      }
      case 'send': {
        const arr = [c2, ...rest].filter((v) => v !== undefined);
        const a = takeIdx(arr);
        const text = arr.join(' ');
        const r = await request('terminal.send', { ...a, text, enter: !!flags.enter, force: !!flags.force });
        return out(r, flags, 'ok');
      }
      case 'send-key': {
        const arr = [c2, ...rest].filter((v) => v !== undefined);
        const a = takeIdx(arr);
        const key = arr[0];
        const r = await request('terminal.sendKey', { ...a, key, force: !!flags.force });
        return out(r, flags, 'ok');
      }

      case 'ws': {
        // 워크스페이스 카드의 한 줄 메모·단계 — 사이드바에 보인다(사람이 "지금 뭐 하는 중인지" 한눈에 보게).
        if (c2 === 'set') {
          const p = {};
          if (flags.comment !== undefined) p.comment = flags.comment === true ? null : String(flags.comment);
          if (flags.status !== undefined) p.status = flags.status === true ? null : String(flags.status);
          if (flags['clear']) { p.comment = null; p.status = null; }
          if (!Object.keys(p).length) { process.stderr.write('사용법: cpt ws set [--comment "<한 줄>"] [--status todo|in-progress|in-review|completed] [--clear]\n'); process.exitCode = 2; return; }
          return out(await request('orch.noteSet', p), flags, 'ok');
        }
        if (c2 === 'list') {
          const r = await request('ws.list', {});
          const arr = Array.isArray(r) ? r : (r && r.workspaces) || [];
          return out(r, flags, arr.map((w) => `${w.id}\t${w.name}\t${w.localPath || ''}`).join('\n') || '(없음)');
        }
        if (c2 === 'new') return printJson(await request('ws.create', { name: rest[0], parentPath: flags.parent }));
        if (c2 === 'clone') return printJson(await request('ws.clone', { url: rest[0], name: flags.name, parentPath: flags.parent }));
        if (c2 === 'delete') {
          // 서버 목록(메타)에서만 삭제 — 로컬 폴더/파일은 그대로 둔다.
          const r = await request('ws.delete', { id: rest[0] });
          return out(r, flags, '삭제됨 — 폴더/파일은 유지됩니다');
        }
        if (c2 === 'select') return out(await request('ui.wsSelect', { id: rest[0] }), flags, 'ok');
        if (c2 === 'close') return out(await request('ui.wsClose', { id: rest[0] }), flags, 'ok');
        break;
      }

      case 'layout': {
        if (c2 === 'tree') return printJson(await request('ui.layoutTree', {}));
        if (c2 === 'split') {
          return out(await request('ui.layoutSplit', {
            direction: rest[0] || 'right', type: flags.type || 'terminal', url: flags.url, path: flags.path, paneId: flags.pane,
          }), flags, 'ok');
        }
        if (c2 === 'focus') return out(await request('ui.focusPane', { paneId: rest[0] }), flags, 'ok');
        if (c2 === 'close') return out(await request('ui.closeSurface', { paneId: rest[0] }), flags, 'ok');
        if (c2 === 'ratio') return out(await request('ui.setRatio', { path: flags.path, ratio: parseFloat(rest[0]) }), flags, 'ok');
        break;
      }
      case 'preview': {
        const sid = flags.sid || undefined;
        // open 은 dev 서버가 fire-and-forget 으로 부를 수 있어 짧은 타임아웃(open shim 블록 방지).
        if (c2 === 'open') return out(await request('ui.previewOpen', { url: rest[0], sid, timeoutMs: 5000 }), flags, 'ok');
        if (c2 === 'navigate') return out(await request('ui.previewNavigate', { url: rest[0], sid }), flags, 'ok');
        if (c2 === 'reload') return out(await request('ui.previewReload', { sid }), flags, 'ok');
        if (c2 === 'close') return out(await request('ui.previewClose', { sid }), flags, 'ok');
        if (c2 === 'devtools') return out(await request('ui.previewDevtools', { sid, on: rest[0] === 'off' ? false : (rest[0] === 'on' ? true : undefined) }), flags, 'ok');
        if (c2 === 'info') return printJson(await request('ui.previewInfo', { sid }));
        if (c2 === 'inspect') {
          // 요소 선택(디자인) 모드 — 클라가 픽커를 켠다. 선택 결과는 비동기(사용자 클릭 시 터미널 삽입).
          const r = await request('ui.previewInspect', { off: !!flags.off, sid });
          return out(r, flags, r && r.on
            ? '요소 선택 모드 시작 — 사용자가 화면에서 요소를 클릭하면 [디자인] 줄이 터미널에 삽입됩니다'
            : '요소 선택 모드 해제');
        }
        // 이어받기: 현재(또는 --on) 기기의 프리뷰를 --to 기기로 세션·쿠키째 옮긴다.
        if (c2 === 'handoff') return out(await request('ui.previewHandoff', { to: flags.to, timeoutMs: 35000 }), flags, 'ok');
        break;
      }
      /**
       * 사용자 리뷰 요청 — **에이전트가 스스로 판단해서** 쓰는 도구다. 강제 관문이 아니다.
       *  사람이 읽는 시간을 기다리므로 기본 타임아웃이 길다(30분). 그동안 이 프로세스는 블록된다 —
       *  터미널에서 `cpt review` 를 친 그 자리에서 결과 JSON 이 나온다.
       */
      case 'review': {
        const secs = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : undefined;
        const timeoutMs = Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : 30 * 60 * 1000;
        const r = await request('ui.review', {
          files: rest.filter(Boolean),
          staged: !!flags.staged,
          title: typeof flags.title === 'string' ? flags.title : undefined,
          timeoutMs,
          // CLI 요청 타임아웃은 리뷰 대기보다 넉넉해야 한다 — 여기서 먼저 끊으면 사용자가
          //  화면에서 보내기를 눌러도 받을 사람이 없다.
        }, { timeoutMs: timeoutMs + 30000 });
        if (r && r.noChanges) return out(r, flags, '변경 없음 — 리뷰할 것이 없습니다');
        return printJson(r);
      }
      // 모바일 화면 — 에이전트가 "내가 고친 화면이 실제로 어떻게 나오는지" 스스로 본다.
      //  screenshot 은 기본으로 파일에 저장한다(base64 를 stdout 에 쏟으면 컨텍스트가 통째로 날아간다).
      case 'emulator': {
        //  ★ 기기 id 는 `--device` 로도, 첫 위치인자로도 줄 수 있다. **위치인자로 준 경우에만**
        //   첫 자리를 소비한다 — 예전엔 무조건 rest[0] 을 id 로 치고 rest[1] 부터 인자로 읽어서,
        //   `--device` 를 쓰면 좌표가 통째로 한 칸씩 밀렸다(2026-08-06 실사용에서 발견).
        const idFlag = flags.device || flags.id || null;
        const id = idFlag || rest[0];
        const a1 = idFlag ? rest : rest.slice(1);
        const num = (n, d) => (flags[n] != null && flags[n] !== true ? Number(flags[n]) : d);
        if (c2 === 'list' || c2 == null) return printJson(await request('emulator.list', {}));
        //  화면에 띄우기 — 사용자가 지금 보고 있는 기기(--on 으로 지정 가능)에 모바일 화면 탭을 연다.
        //   id 생략 = 켜져 있는 기기 중 첫 번째(데몬이 고른다 — 화면의 낡은 목록으로 고르지 않게).
        if (c2 === 'show') {
          const r = await request('ui.emulatorOpen', { device: id || undefined, timeoutMs: 8000 });
          return out(r, flags, `띄웠어요${r && r.device ? `: ${r.device}` : ''}`);
        }
        if (c2 === 'hide') return out(await request('ui.emulatorClose', {}), flags, 'ok');
        if (c2 === 'boot') return out(await request('emulator.boot', { id }), flags, '켜는 중…');
        if (c2 === 'shutdown') return out(await request('emulator.shutdown', { id }), flags, 'ok');
        if (c2 === 'open') return out(await request('emulator.openUrl', { id, url: a1[0] || flags.url }), flags, 'ok');
        if (c2 === 'tap' || c2 === 'long-press') {
          return out(await request('emulator.input', {
            id, type: c2 === 'tap' ? 'tap' : 'longPress', x: Number(a1[0]), y: Number(a1[1]),
          }), flags, 'ok');
        }
        if (c2 === 'swipe') {
          return out(await request('emulator.input', {
            id, type: 'swipe', x: Number(a1[0]), y: Number(a1[1]), x2: Number(a1[2]), y2: Number(a1[3]),
            durationMs: num('ms', undefined),
          }), flags, 'ok');
        }
        if (c2 === 'key') return out(await request('emulator.input', { id, type: 'key', key: a1[0] }), flags, 'ok');
        if (c2 === 'rotate') {
          const want = String(a1[0] || flags.orientation || 'landscape').toLowerCase();
          if (want !== 'portrait' && want !== 'landscape') throw new Error('portrait 또는 landscape 로 알려 주세요');
          return out(await request('emulator.input', { id, type: 'rotate', orientation: want }), flags, 'ok');
        }
        //  화면을 **글자로** 읽는다 — 스크린샷을 눈으로 보고 좌표를 찍는 것보다 훨씬 정확하다.
        if (c2 === 'ax' || c2 === 'screen') {
          const r = await request('emulator.ax', { id }, { timeoutMs: 40000 });
          const q = (a1.join(' ') || flags.match || '').toString().trim().toLowerCase();
          const els = q ? r.elements.filter((e) => matchesEl(e, q)) : r.elements;
          if (flags.json) return printJson({ ...r, elements: els });
          console.log(`${r.kind} · ${r.screen.w}x${r.screen.h} · ${els.length}개`);
          for (const e of els) console.log(`  (${e.x}, ${e.y})  ${e.label || '(이름 없음)'}${e.value ? `  [${e.value}]` : ''}  ${e.role}`);
          return 0;
        }
        //  라벨로 누르기 — 에이전트가 가장 많이 쓸 명령. 후보가 여럿이면 **누르지 않고** 보여 준다.
        if (c2 === 'tap-label' || c2 === 'tap-text') {
          const q = a1.join(' ').trim().toLowerCase();
          if (!q) throw new Error('누를 라벨을 알려 주세요 — cpt emulator tap-label "설정"');
          const r = await request('emulator.ax', { id }, { timeoutMs: 40000 });
          const hits = r.elements.filter((e) => matchesEl(e, q));
          if (!hits.length) {
            throw new Error(`"${a1.join(' ')}" 를 화면에서 못 찾았어요 — cpt emulator ax 로 지금 보이는 것을 확인하세요`);
          }
          //  완전히 같은 라벨이 있으면 그것부터(부분일치가 엉뚱한 걸 집는 걸 막는다).
          const exact = hits.filter((e) => String(e.label || '').toLowerCase() === q);
          const pick = (exact.length ? exact : hits)[0];
          if ((exact.length ? exact : hits).length > 1 && !flags.first) {
            const list = (exact.length ? exact : hits).map((e) => `  (${e.x}, ${e.y})  ${e.label}  ${e.role}`).join('\n');
            throw new Error(`후보가 ${hits.length}개예요 — 좌표로 누르거나 --first 를 쓰세요:\n${list}`);
          }
          await request('emulator.input', { id, type: 'tap', x: pick.x, y: pick.y });
          return out({ ok: true, tapped: pick }, flags, `눌렀어요: ${pick.label} (${pick.x}, ${pick.y})`);
        }
        if (c2 === 'text') return out(await request('emulator.input', { id, type: 'text', text: a1.join(' ') }), flags, 'ok');
        if (c2 === 'screenshot') {
          const r = await request('emulator.frame', { id, maxWidth: num('width', 720), quality: num('quality', 80) }, { timeoutMs: 60000 });
          const ext = r.mime === 'image/png' ? 'png' : (r.mime === 'image/bmp' ? 'bmp' : 'jpg');
          let dest = flags.out ? String(flags.out) : null;
          if (!dest) {
            const dir = path.join(os.homedir(), '.codingpt', 'tmp');
            fs.mkdirSync(dir, { recursive: true });
            dest = path.join(dir, `emu-${Date.now()}.${ext}`);
          }
          fs.writeFileSync(dest, Buffer.from(r.base64, 'base64'));
          return out({ saved: dest, width: r.width, height: r.height, bytes: r.bytes }, flags, `저장됨: ${dest}`);
        }
        break;
      }
      // 에이전트 PC — 이 맥 안의 별도 macOS(게스트 VM). 사용자 화면을 건드리지 않고 전면 GUI 조작을 한다.
      //  화면·입력은 모바일 화면(emulator.*)과 같은 계약이고 기기 id 가 `desktop:main` 으로 고정된 것뿐이다.
      case 'desktop': {
        //  ★ 에이전트 PC 는 macOS·Linux 두 대(동시). --os 로 어느 것을 조작할지 고른다(기본 macOS). 기기 id·설정·상태가 그 OS 로 간다.
        const osk = (flags.os === 'linux' || flags.os === 'macos') ? flags.os : 'macos';
        const osSpecified = flags.os === 'linux' || flags.os === 'macos';
        const D = `desktop:${osk}`;
        const dreq = (m, p, o) => request(m, { os: osk, ...(p || {}) }, o);   // desktop.* 에 os 를 실어 보낸다
        const num = (n, d) => (flags[n] != null && flags[n] !== true ? Number(flags[n]) : d);
        const isUrl = (v) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(String(v || ''));
        if (c2 === 'status' || c2 == null) {
          const statusLine = (r) => (r.phase === 'running'
            ? `● 실행 중 · ${r.screen ? `${r.screen.width}x${r.screen.height}` : '화면 준비 중'} · ip ${r.ip || '-'}${r.paused ? ' · 에이전트 멈춤' : ''}${r.handoff ? ` · 개입 대기: ${r.handoff.reason}` : ''}`
            : `○ ${r.phase}${r.reason ? ` — ${r.reason}` : ''}`);
          //  --os 없으면 둘 다 요약(동시 실행 모델), 있으면 그 OS 상세.
          if (!osSpecified) {
            const [m, l] = await Promise.all([request('desktop.status', { os: 'macos' }, { timeoutMs: 20000 }), request('desktop.status', { os: 'linux' }, { timeoutMs: 20000 })]);
            if (flags.json) return printJson({ macos: m, linux: l });
            return out({ macos: m, linux: l }, flags, `macOS  ${statusLine(m)}\nLinux  ${statusLine(l)}`);
          }
          const r = await dreq('desktop.status', {}, { timeoutMs: 20000 });
          return out(r, flags, `[${osk}] ${statusLine(r)}\n연결된 폴더: ${(r.sharedDirs || []).join(', ') || '(없음)'}`);
        }
        if (c2 === 'start') return out(await dreq('desktop.start', {}, { timeoutMs: 150000 }), flags, '켜졌어요');
        if (c2 === 'stop') return out(await dreq('desktop.stop', {}), flags, '꺼졌어요');
        if (c2 === 'pull') return out(await dreq('desktop.pull', {}, { timeoutMs: 4 * 3600 * 1000 }), flags, '이미지 준비됨');
        if (c2 === 'show') {
          //  꺼져 있으면 먼저 켠다 — 빈 액자를 띄우고 "켜세요" 라고 하는 것보다 낫다(수십 초 걸리면 그만큼 기다린다).
          const st = await dreq('desktop.status', {}, { timeoutMs: 20000 });
          if (st.phase === 'stopped' || st.phase === 'starting') await dreq('desktop.start', {}, { timeoutMs: 150000 });
          else if (st.phase !== 'running') throw new Error(st.reason || `에이전트 PC 를 쓸 수 없어요 (${st.phase})`);
          return out(await request('ui.emulatorOpen', { device: D, timeoutMs: 8000 }), flags, '띄웠어요');
        }
        if (c2 === 'hide') return out(await request('ui.emulatorClose', {}), flags, 'ok');
        if (c2 === 'open') {
          const target = rest[0] || flags.url || flags.app;
          if (!target) throw new Error('무엇을 열지 알려 주세요 — cpt desktop open Safari | cpt desktop open http://localhost:5173');
          if (isUrl(target)) return out(await dreq('desktop.openUrl', { url: target }, { timeoutMs: 30000 }), flags, 'ok');
          return out(await dreq('desktop.openApp', { name: target }, { timeoutMs: 30000 }), flags, 'ok');
        }
        if (c2 === 'run') {
          const cmd = rest.join(' ').trim();
          if (!cmd) throw new Error('실행할 명령을 알려 주세요 — cpt desktop run -- ls -la');
          const r = await dreq('desktop.exec', { cmd, timeoutMs: num('timeout', 60) * 1000 }, { timeoutMs: num('timeout', 60) * 1000 + 10000 });
          if (flags.json) return printJson(r);
          process.stdout.write(String(r.out || ''));
          return 0;
        }
        if (c2 === 'path') {
          const r = await dreq('desktop.path', { path: path.resolve(rest[0] || '.') });
          return out(r, flags, r.guest || '(연결된 폴더 밖이에요 — cpt desktop connect <폴더> 로 붙이세요)');
        }
        //  사용자 개입 — 로그인·2FA 처럼 사람이 해야 하는 일. 카드가 뜨고 사용자가 [계속]을 누를 때까지 **기다린다**.
        if (c2 === 'handoff') {
          const reason = rest.join(' ').trim() || '사용자 조작이 필요해요';
          const ms = num('timeout', 900) * 1000;
          const r = await dreq('desktop.handoff', { reason, timeoutMs: ms }, { timeoutMs: ms + 10000 });
          if (r && r.ok) return out(r, flags, '사용자가 처리했어요 — 계속하세요');
          throw new Error(r && r.timeout ? '사용자 응답이 없어 개입 요청이 끝났어요' : '개입 요청이 취소됐어요');
        }
        if (c2 === 'pause') return out(await dreq('desktop.pause', {}), flags, '에이전트 입력 멈춤');
        if (c2 === 'resume') return out(await dreq('desktop.resume', {}), flags, '에이전트 입력 재개');
        if (c2 === 'screenshot') {
          const r = await request('emulator.frame', { id: D, maxWidth: num('width', 1280), quality: num('quality', 80) }, { timeoutMs: 60000 });
          let dest = flags.out ? String(flags.out) : null;
          if (!dest) { const dir = path.join(os.homedir(), '.codingpt', 'tmp'); fs.mkdirSync(dir, { recursive: true }); dest = path.join(dir, `desktop-${Date.now()}.jpg`); }
          fs.writeFileSync(dest, Buffer.from(r.base64, 'base64'));
          return out({ saved: dest, width: r.width, height: r.height, bytes: r.bytes }, flags, `저장됨: ${dest} (${r.width}x${r.height})`);
        }
        const inp = (o) => request('emulator.input', { id: D, from: 'agent', ...o }, { timeoutMs: 30000 });
        if (c2 === 'click' || c2 === 'double-click') return out(await inp({ type: 'tap', x: Number(rest[0]), y: Number(rest[1]), count: c2 === 'double-click' ? 2 : 1, button: flags.right ? 'right' : 'left' }), flags, 'ok');
        if (c2 === 'right-click') return out(await inp({ type: 'tap', x: Number(rest[0]), y: Number(rest[1]), button: 'right' }), flags, 'ok');
        if (c2 === 'move') return out(await inp({ type: 'move', x: Number(rest[0]), y: Number(rest[1]) }), flags, 'ok');
        if (c2 === 'drag') return out(await inp({ type: 'swipe', x: Number(rest[0]), y: Number(rest[1]), x2: Number(rest[2]), y2: Number(rest[3]), durationMs: num('ms', 400) }), flags, 'ok');
        if (c2 === 'scroll') return out(await inp({ type: 'scroll', x: Number(rest[0]), y: Number(rest[1]), dy: Number(rest[2] != null ? rest[2] : 3) }), flags, 'ok');
        if (c2 === 'key') return out(await inp({ type: 'key', key: rest[0] }), flags, 'ok');
        if (c2 === 'type') return out(await inp({ type: 'text', text: rest.join(' ') }), flags, 'ok');
        if (c2 === 'ax') {
          //  접근성 트리 — 기본은 사람이 읽는 줄(i role "글" @x,y wxh), --json 은 원본. 조작 가능한 것만이 기본, --all 로 전부.
          const t = await dreq('desktop.ax', { app: flags.app || rest[0] || undefined }, { timeoutMs: 120000 });
          if (flags.json) return printJson(t);
          const KEEP = /^(Button|CheckBox|RadioButton|MenuItem|MenuBarItem|PopUpButton|Link|TextField|TextArea|SearchField|Tab|Cell|Row|ComboBox|Slider|StaticText|Heading|Image|Window|Sheet|Dialog|Group)$/;
          const rows = t.nodes.filter((n) => flags.all || (KEEP.test(n.role) && n.w > 0 && (n.title || n.desc || n.value || n.ph || n.role !== 'Group')));
          const line = (n) => {
            const label = [n.title, n.desc, n.value, n.ph].filter((v) => v != null && v !== '').map((v) => JSON.stringify(String(v))).join(' ');
            //  @ 는 요소의 **중심** 좌표다 — `cpt desktop click <x> <y>` 에 그대로 넣으면 그 요소가 눌린다(0~1 비율).
            //   size 는 크기(참고용). 예전엔 좌상단을 찍어, 헤더의 "click 에 그대로" 를 믿고 누르면 모서리를 눌렀다(2026-09-20).
            const geo = n.w > 0 ? ` @${(n.x + n.w / 2).toFixed(3)},${(n.y + n.h / 2).toFixed(3)} (${n.w.toFixed(3)}x${n.h.toFixed(3)})` : '';
            return `${n.i} ${n.role}${n.subrole ? '/' + n.subrole : ''} ${label}${geo}${n.disabled ? ' (disabled)' : ''}${n.focused ? ' (focused)' : ''}`;
          };
          process.stdout.write(`# ${t.app} (pid ${t.pid}) — ${rows.length}/${t.nodes.length}개${t.truncated ? ' · 잘림' : ''} · @=중심 0~1 좌표(cpt desktop click x y 에 그대로), 괄호=크기\n${rows.map(line).join('\n')}\n`);
          return;
        }
        if (c2 === 'tap') {
          if (!rest[0]) { process.stderr.write('사용법: cpt desktop tap "<글자>" [--app 이름] [--role Button]\n'); process.exitCode = 2; return; }
          const r = await dreq('desktop.tap', { text: rest[0], app: flags.app || undefined, role: flags.role || undefined, from: 'agent' }, { timeoutMs: 120000 });
          return out(r, flags, `클릭: ${r.node.role} ${JSON.stringify(r.node.title || r.node.desc || r.node.value || '')} @${r.x},${r.y} (${r.app})`);
        }
        if (c2 === 'snapshots') {
          const r = await dreq('desktop.snapshots', {});
          if (flags.json) return printJson(r);
          const fmt = (s) => `${s.name}  ${new Date(s.at).toLocaleString()}${s.label ? '  ' + s.label : ''}`;
          process.stdout.write(r.snapshots.length ? r.snapshots.map(fmt).join('\n') + '\n' : '(스냅샷 없음)\n');
          return;
        }
        if (c2 === 'snapshot') {
          const r = await dreq('desktop.snapshot', { label: rest[0] || '' }, { timeoutMs: 240000 });
          return out(r, flags, `스냅샷 저장: ${r.name}${r.restarted ? ' (끄고 저장한 뒤 다시 켰어요)' : ''}`);
        }
        if (c2 === 'restore') {
          if (!rest[0]) { process.stderr.write('사용법: cpt desktop restore <스냅샷 이름>  (cpt desktop snapshots 로 목록)\n'); process.exitCode = 2; return; }
          const r = await dreq('desktop.restore', { name: rest[0] }, { timeoutMs: 240000 });
          return out(r, flags, `되돌렸어요: ${r.name}${r.restarted ? ' (다시 켰어요)' : ''}`);
        }
        if (c2 === 'snapshot-delete') return out(await dreq('desktop.snapshot.delete', { name: rest[0] }, { timeoutMs: 60000 }), flags, '삭제했어요');
        if (c2 === 'provision') return out(await dreq('desktop.provision', {}), flags, '첫 설정 완료 — 자동 로그인·절전 끔·설정 도우미 건너뜀');
        if (c2 === 'os') {
          //  ★ 더 이상 OS 를 "전환"하지 않는다 — macOS·Linux 는 동시에 따로 돈다. 조작은 각 명령에 `--os macos|linux` 로 고른다.
          process.stderr.write('이제 macOS·Linux 를 동시에 씁니다 — 전환이 아니라 명령마다 골라요:\n  cpt desktop --os linux start | ax | tap | open …  (기본은 macOS)\n  cpt desktop status  → 둘 다 요약\n');
          process.exitCode = 2; return;
        }
        if (c2 === 'connect' || c2 === 'disconnect') {
          const dir = path.resolve(rest[0] || process.env.CPT_WS_ROOT || process.cwd());
          //  켜져 있으면 데몬이 끄고 다시 켜서 바로 쓸 수 있게 돌려준다(공유 폴더는 부팅 때 고정) — 최대 3분.
          const r = await dreq(`desktop.${c2}`, { dir }, { timeoutMs: 180000 });
          const tail = r.restarted ? ' (에이전트 PC 를 다시 켰어요 — 바로 쓸 수 있어요)' : (r.changed ? '' : ' (이미 그 상태)');
          return out(r, flags, c2 === 'connect' ? `연결: ${r.host} → ${r.guest}${tail}` : `해제: ${r.host}${tail}`);
        }
        process.stderr.write('사용법: cpt desktop [--os macos|linux] status|start|stop|provision|snapshot [라벨]|snapshots|restore <이름>|show|ax [앱]|tap <글자>|open <앱|URL>|run -- <명령>|screenshot|click x y|right-click x y|drag x y x2 y2|scroll x y [dy]|key <조합>|type <글>|handoff <사유>|pause|resume|path <경로>|connect [폴더]|disconnect [폴더]\n');
        process.exitCode = 2;
        return;
      }
      case 'ide': {
        const sid = flags.sid || undefined;
        if (c2 === 'open') return out(await request('ui.ideOpen', { path: rest[0], line: flags.line ? parseInt(flags.line, 10) : undefined, sid }), flags, 'ok');
        if (c2 === 'close') return out(await request('ui.ideClose', { sid }), flags, 'ok');
        if (c2 === 'close-file') return out(await request('ui.ideCloseFile', { path: rest[0], sid }), flags, 'ok');
        if (c2 === 'list') return printJson(await request('ui.ideList', { sid }));
        if (c2 === 'diff') {
          // 데몬이 git diff 를 계산해 IDE 에 읽기 전용 diff 문서로 띄운다. 변경 없으면 "변경 없음".
          const r = await request('ui.ideDiff', { path: rest[0], staged: !!flags.staged, sid });
          return out(r, flags, r && r.noChanges ? '변경 없음' : 'ok');
        }
        if (c2 === 'open-changed') {
          // 변경 파일 일괄 열기 — 파일당 최대 2회 ui 왕복 × 150ms 간격이라 CLI 타임아웃을 넉넉히.
          const r = await request('ui.ideOpenChanged', {
            mode: flags.mode, staged: !!flags.staged, max: flags.max ? parseInt(flags.max, 10) : undefined,
          }, { timeoutMs: 240000 });
          return out(r, flags, r && r.noChanges ? '변경 없음' : `${r.opened}/${(r.files || []).length}개 열림${r.skipped ? ` (${r.skipped}개 건너뜀)` : ''}`);
        }
        break;
      }
      case 'skills': {
        if (c2 === 'get') return printSkillGuide(rest[0]);
        if (c2 === 'list' || c2 == null) { process.stdout.write('cpt-cli\ncpt-orch\n'); return; }
        break;
      }

      case 'browser': {
        const sub = c2;
        const numF = (n) => (flags[n] != null && flags[n] !== true ? Number(flags[n]) : undefined);
        const m = {
          snapshot: () => request('browser.snapshot', { compact: !!flags.compact }),
          click: () => request('browser.click', { target: rest[0], x: numF('x'), y: numF('y') }),
          scroll: () => request('browser.scroll', { target: rest[0], x: numF('x'), y: numF('y'), dx: numF('dx'), dy: numF('dy') }),
          press: () => request('browser.press', { key: rest[0], target: flags.target, modifiers: flags.mod ? String(flags.mod).split(',') : undefined, text: flags.text }),
          type: () => request('browser.type', { target: rest[0], text: rest.slice(1).join(' ') }),
          fill: () => request('browser.fill', { target: rest[0], value: rest.slice(1).join(' ') }),
          eval: () => request('browser.eval', { js: rest.join(' ') }),
          wait: () => request('browser.wait', { selector: flags.selector, text: flags.text, timeoutMs: flags['timeout-ms'] ? parseInt(flags['timeout-ms'], 10) : undefined }),
          get: () => request('browser.get', { what: rest[0], selector: flags.selector }),
          screenshot: () => request('browser.screenshot', {}),
          console: () => request('browser.console', {
            limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
            level: typeof flags.level === 'string' ? flags.level : undefined,
            pattern: typeof flags.pattern === 'string' ? flags.pattern : undefined,
            clear: !!flags.clear,
          }),
          network: () => request('browser.network', {
            limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
            pattern: typeof flags.pattern === 'string' ? flags.pattern : undefined,
            status: flags.status != null && flags.status !== true ? String(flags.status) : undefined,
            clear: !!flags.clear,
          }),
        };
        if (!m[sub]) break;
        const r = await m[sub]();
        if (sub === 'screenshot' && r && r.base64) {
          // --out 미지정이면 ~/.codingpt/tmp/shot-<ts>.jpg 기본 저장(base64 는 출력하지 않는다).
          if (flags.out) { fs.writeFileSync(String(flags.out), Buffer.from(r.base64, 'base64')); return out({ saved: flags.out }, flags, `저장됨: ${flags.out}`); }
          const dir = path.join(os.homedir(), '.codingpt', 'tmp');
          fs.mkdirSync(dir, { recursive: true });
          const shotPath = path.join(dir, `shot-${Date.now()}.jpg`);
          fs.writeFileSync(shotPath, Buffer.from(r.base64, 'base64'));
          return printJson({ path: shotPath, device: r.device, viewport: r.viewport });
        }
        return printJson(r);
      }

      case 'notify': {
        const r = await request('notify', { title: flags.title || pos.slice(1).join(' '), subtitle: flags.subtitle, body: flags.body, kind: flags.kind });
        return out(r, flags, 'ok');
      }
      case 'notifications': {
        if (c2 === 'read-all') return out(await request('notification.readAll', {}), flags, 'ok');
        const r = await request('notification.list', { limit: flags.limit ? parseInt(flags.limit, 10) : undefined });
        const list = (r && r.notifications) || [];
        const human = list.map((n) => `${n.readAt ? ' ' : '●'} [${n.id}] ${n.title}${n.subtitle ? ' — ' + n.subtitle : ''}${n.body ? '\n    ' + String(n.body).slice(0, 120) : ''}`).join('\n');
        return out(r, flags, human || '(알림 없음)');
      }

      case 'set-status': return out(await request('status.set', { key: c2, value: rest.join(' '), icon: flags.icon, color: flags.color }), flags, 'ok');
      case 'clear-status': return out(await request('status.clear', { key: c2 }), flags, 'ok');
      case 'set-progress': return out(await request('status.progress', { value: parseFloat(c2), label: flags.label }), flags, 'ok');
      case 'clear-progress': return out(await request('status.progress', { value: null }), flags, 'ok');
      case 'log': return out(await request('status.log', { message: pos.slice(1).join(' '), level: flags.level, source: flags.source }), flags, 'ok');
      case 'status': return printJson(await request('status.list', {}));

      // ── 원격 승인(조회 전용) ──
      //  응답(허용/거절)은 여기서 하지 않는다: 이 CLI 는 터미널 안의 AI 도 부를 수 있어서, 응답 명령을
      //  노출하면 에이전트가 자기 승인 요청을 스스로 통과시킬 수 있다. 사람은 앱/PC 카드에서 답한다.
      case 'approval': {
        if (c2 === 'list' || c2 == null) {
          const r = await request('approval.list', {});
          const arr = (r && r.approvals) || [];
          const now = Date.now();
          const left = (d) => (d ? `남은 ${Math.max(0, Math.round((d - now) / 1000))}초` : '마감 미정');
          return out(r, flags, arr.map((a) =>
            `✋ ${a.id}  ${a.tool || '?'}${a.summary ? ' · ' + String(a.summary).split('\n')[0].slice(0, 80) : ''}`
            + `\n   ${a.wsName || a.cwd || '-'}${a.win != null ? `/${a.win}` : ''} · ${left(a.deadlineAt)}`
          ).join('\n') || (r && r.supported === false ? '(이 데몬은 원격 승인을 지원하지 않습니다 — PC 앱 업데이트 필요)' : '(대기 중 승인 없음)'));
        }
        process.stderr.write('사용법: cpt approval list\n');
        process.exitCode = 2;
        return;
      }

      // ── 트랜스크립트(에이전트 대화 로그 직독) ──
      //  기본 = 이 터미널이 보고 있는 세션의 최근 대화. --since <seq> 면 그 이후 증분만(폴링용).
      case 'transcript': {
        if (c2 === 'sessions') {
          const r = await request('chat.sessions', {});
          const arr = (r && r.sessions) || [];
          if (r && r.supported === false) return out(r, flags, `(${r.agent || '이 에이전트'}의 트랜스크립트는 아직 지원하지 않습니다)`);
          return out(r, flags, arr.map((s) =>
            `${s.live ? '●' : '○'} ${s.sessionId}  ${s.title || '(제목 없음)'}`
            + `\n   ${s.lines != null ? `${s.lines}줄 ` : ''}${s.bytes != null ? `${Math.round(s.bytes / 1024)}KB ` : ''}`
            + `${s.gitBranch ? `${s.gitBranch} ` : ''}${s.oversize ? '(대용량) ' : ''}${s.lastAt || ''}`
          ).join('\n') || '(세션 없음)');
        }
        const limit = flags.limit != null && flags.limit !== true ? parseInt(flags.limit, 10) : undefined;
        const sinceSeq = flags.since != null && flags.since !== true ? parseInt(flags.since, 10) : null;
        // 스냅샷을 먼저 연다(chatId/epoch 획득 — since 는 이 좌표계 위에서만 의미가 있다).
        const opened = await request('chat.open', {
          sessionId: typeof flags.session === 'string' ? flags.session : undefined,
          limit: sinceSeq != null ? 1 : (limit || 40), // --since 면 스냅샷 본문은 필요 없다
        });
        if (opened && opened.supported === false) {
          return out(opened, flags, `(${opened.agent || '이 에이전트'}의 트랜스크립트는 아직 지원하지 않습니다)`);
        }
        let messages = (opened && opened.messages) || [];
        let epoch = opened && opened.epoch;
        let headSeq = opened && opened.headSeq;
        if (sinceSeq != null) {
          const d = await request('chat.since', { chatId: opened.chatId, sinceSeq, epoch, limit });
          messages = (d && d.messages) || [];
          if (d && d.epoch) epoch = d.epoch;
          if (d && d.headSeq != null) headSeq = d.headSeq;
          if (d && d.epochChanged) process.stderr.write('알림: 세션 파일이 교체됐습니다(--since 무효) — 전체를 다시 읽으세요.\n');
        }
        // 구독을 남기지 않는다(CLI 는 one-shot 조회) — 실패는 무해(데몬 idle TTL 이 정리).
        await request('chat.close', { chatId: opened && opened.chatId }).catch(() => {});
        const payload = { chatId: opened && opened.chatId, sessionId: opened && opened.sessionId, epoch, headSeq, messages };
        return out(payload, flags, messages.map(renderChatMsg).join('\n') || '(내용 없음)');
      }

      // ── 훅(claude/codex 래퍼가 호출 — 사람이 직접 쓸 일 없음) ──
      case 'claude-hook': {
        // 이벤트 7종(session-start|prompt|permission|notification|stop|stop-failure|session-end)을
        //  hook.event v2 스키마로 매핑해 데몬에 자기보고한다. 데몬이 상태의 단일 소유자다.
        //  불변식: claude 를 절대 블록/오염하지 않는다 → 짧은 타임아웃 + 무조건 exit 0 + stdout 무출력.
        //  ⚠ permission(PermissionRequest) 도 1단계에선 무출력이다. 빈 stdout + exit 0 이면 claude 가
        //    평소처럼 TUI 승인 대화상자를 띄운다(실측). 여기서 결정 JSON 을 뱉으면 사용자 승인을
        //    우리가 대신 결정해버린다 — 절대 금지.
        try {
          const payload = await readStdinJson();
          const ev = mapClaudeHook(c2, payload);
          if (!ev) return;                       // 모르는 이벤트명 = 조용히 성공(구/신 버전 혼재 안전)
          await request('hook.event', ev, { timeoutMs: 3000 }).catch(() => {});
        } catch (_) { /* 훅은 실패해도 조용히 성공 처리 */ }
        return;
      }
      // ── 원격 승인(기능1) — PermissionRequest 훅 전용. 다른 훅과 달리 **응답까지 블로킹**한다 ──
      //  stdout 은 claude 와의 계약 JSON 전용이다(out()/printJson()/console.log 금지 — 한 글자라도
      //  섞이면 결정이 무효화되고 예측 불가 동작이 된다). 결정을 못 받으면 **무출력 + exit 0** →
      //  claude 가 평소처럼 TUI 승인 대화상자를 띄운다(= 자동 허용이 어떤 경로로도 발생하지 않는다).
      case 'approval-hook': {
        await approvalHook(flags);
        return;
      }
      case 'codex-notify': {
        let payload = null;
        try { payload = JSON.parse(rest[0] || c2 || '{}'); } catch (_) { /* noop */ }
        const summary = (payload && (payload['last-assistant-message'] || payload.message)) || '';
        const approval = !!(payload && /approval/i.test(String(payload.type || '')));
        // v2: codex 는 claude 처럼 notificationType 을 주지 않는다. 승인 여부를 여기서 판정해 명시적으로 실어
        //  보낸다 — 안 보내면 데몬(agent-state)이 notificationType 없는 notification 을 무변경 no-op 으로
        //  처리해 codex 승인 알림이 조용히 0건이 된다.
        await request('hook.event', {
          v: 2,
          agent: 'codex',
          event: approval ? 'notification' : 'stop',
          at: Date.now(),
          notificationType: approval ? 'permission_prompt' : null,
          backgroundTasks: 0,
          summary: String(summary),
        }, { timeoutMs: 3000 }).catch(() => {});
        return;
      }
    }
    process.stderr.write(`알 수 없는 명령: ${pos.join(' ')}\n\n`);
    process.stdout.write(HELP);
    process.exitCode = 2;
  };

  try {
    await run();
  } catch (e) {
    // 훅 경로는 어떤 오류에도 exit 0 + 무출력 — 훅이 0 아닌 코드로 끝나거나 stderr 를 뱉으면 claude 가
    //  사용자에게 훅 실패를 표시하고(2 는 모델을 깨우기까지 한다) 작업 흐름을 오염시킨다.
    if (c1 === 'claude-hook' || c1 === 'codex-notify' || c1 === 'approval-hook') return;
    process.stderr.write(`오류: ${e.message}\n`);
    process.exitCode = 1;
  }
}

// ── 자동화(cpt auto) ─────────────────────────────────────────────────────────
const AUTO_USAGE = '사용법: cpt auto list | get <id> | create --file <spec.json>|- [--dry-run] | update <id> --file <patch.json>'
  + ' | pause|resume|run|remove <id> | log [<id>] [--limit n] | schema\n';

// 가이드의 자동화 절(`## 7-3. 자동화`) — `cpt auto schema` 는 이 절을 **그대로** 출력한다(단일 출처).
function autoSchemaText() {
  let md = '';
  try { md = fs.readFileSync(path.join(__dirname, '..', 'GUIDE.md'), 'utf8'); } catch (_) { return null; }
  const i = md.indexOf('## 7-3. 자동화');
  if (i < 0) return null;
  const j = md.indexOf('\n## ', i + 1);
  return md.slice(i, j < 0 ? md.length : j + 1);
}

// stdin 전체(파이프). TTY 면 null. 파이프가 안 닫히면 10초 뒤 포기(에이전트 셸이 매달리지 않게).
function readAllStdin(timeoutMs = 10000) {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => { try { process.stdin.destroy(); } catch (_) { /* noop */ } resolve(buf); }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(buf); });
  });
}

async function readSpecJson(flags, rest) {
  // `--dry-run -`·`--json -` 처럼 불리언 플래그 뒤의 `-` 는 파서가 그 플래그 값으로 먹는다 → stdin 으로 본다.
  const dashAsValue = Object.keys(flags).some((k) => k !== 'file' && flags[k] === '-');
  const file = typeof flags.file === 'string' ? flags.file : (rest[0] === '-' || dashAsValue ? '-' : null);
  if (!file) return { error: '--file <spec.json> 또는 - (stdin) 가 필요합니다' };
  let text;
  if (file === '-') {
    text = await readAllStdin();
    if (text == null) return { error: 'stdin 이 터미널입니다 — 파이프로 JSON 을 넘기거나 --file 을 쓰세요' };
  } else {
    try { text = fs.readFileSync(path.resolve(file), 'utf8'); } catch (e) { return { error: `파일을 읽을 수 없습니다: ${file}` }; }
  }
  try { return { value: JSON.parse(text) }; } catch (e) { return { error: `JSON 이 올바르지 않습니다: ${e.message}` }; }
}

function autoTrigText(t) {
  if (!t) return '?';
  const at = t.repo ? ` @ ${t.repo}` : '';
  switch (t.type) {
    case 'schedule': return t.at != null ? `일회 ${new Date(t.at).toLocaleString()} (${t.tz})` : `${t.cron} (${t.tz})`;
    case 'git.commits': return `새 커밋 · ${t.remote}/${t.branch}${at}`;
    case 'github.issues': return `새 이슈${t.labels && t.labels.length ? ` [${t.labels.join(',')}]` : ''}${at}`;
    case 'pr.ci_failed': return `검사 실패${at}`;
    case 'pr.review_comments': return `리뷰 코멘트${at}`;
    case 'task.event': return `작업 이벤트 ${t.event}${at}`;
    default: return t.type;
  }
}
function autoLastText(r) {
  if (!r) return '없음';
  const when = r.at ? new Date(r.at).toLocaleString() : '';
  if (r.ok) return `성공${r.taskIds && r.taskIds.length ? ` · 작업 ${r.taskIds.join(',')}` : ''} ${when}`.trim();
  return `실패 ${r.code || ''} ${when}`.trim();
}
function autoLine(a) {
  const st = a.state || {};
  const creator = a.createdBy ? (a.createdBy.kind === 'agent' ? `${a.createdBy.agent || '에이전트'} 가 만듦`
    : a.createdBy.kind === 'dispatch' ? '한 줄 지시로 만듦' : '직접 만듦') : '';
  return `${a.id} ${a.paused || !a.enabled ? '[일시정지] ' : ''}${a.name} — ${autoTrigText(a.trigger)}`
    + `\n    다음 ${st.nextRunAt ? new Date(st.nextRunAt).toLocaleString() : '-'} · 마지막 ${autoLastText(st.lastResult)}`
    + ` · 오늘 ${st.runsToday || 0}/${a.guards ? a.guards.maxRunsPerDay : '?'}${creator ? ` · ${creator}` : ''}`;
}
function autoLogLine(l) {
  return `${new Date(l.at).toISOString()} ${l.autoId || '-'} ${l.stage}${l.type ? ` ${l.type}` : ''} ${l.ok ? 'ok' : 'fail'}`
    + `${l.code ? ` ${l.code}` : ''}${l.taskId ? ` ${l.taskId}` : ''}${l.message ? ` — ${l.message}` : ''}`;
}
function autoActText(x, i) {
  const n = `${i + 1}.`;
  if (x.type === 'task.create') return `${n} 작업 만들기 ${x.repo}${x.subdir ? '/' + x.subdir : ''} · ${(x.agents || []).map((g) => `${g.id}×${g.count}`).join(',')}${x.title ? ` · "${x.title}"` : ''}`;
  if (x.type === 'terminal.prompt') return `${n} 에이전트에게 지시 → ${JSON.stringify(x.target)}`;
  if (x.type === 'notify') return `${n} 알림 "${x.title}"`;
  return `${n} ${x.type}`;
}

async function autoCommand(sub, rest, flags) {
  const need = (id) => {
    if (id) return true;
    process.stderr.write(AUTO_USAGE); process.exitCode = 2; return false;
  };
  try {
    switch (sub) {
      case 'list': {
        const r = await request('auto.list', {});
        const items = (r && r.items) || [];
        return out(r, flags, (r && r.paused ? '(전체 일시정지 중)\n' : '') + (items.map(autoLine).join('\n') || '(자동화 없음)'));
      }
      case 'get': {
        if (!need(rest[0])) return;
        const r = await request('auto.get', { id: rest[0] });
        const a = r && r.automation;
        if (!a) return printJson(r);
        return out(r, flags, [autoLine(a), '액션:', ...a.actions.map(autoActText), '', '실행 기록:',
          ...((r.log || []).map(autoLogLine)), ...(r.log && r.log.length ? [] : ['(없음)'])].join('\n'));
      }
      case 'create': {
        const spec = await readSpecJson(flags, rest);
        if (spec.error) { process.stderr.write(`${spec.error}\n${AUTO_USAGE}`); process.exitCode = 2; return; }
        if (flags['dry-run']) {
          const v = await request('auto.validate', { draft: spec.value });
          return out(v, flags, `검증 통과 — ${autoTrigText(v.normalized.trigger)} · 다음 실행 ${v.nextRunAt ? new Date(v.nextRunAt).toLocaleString() : '-'}`
            + `${v.warnings && v.warnings.length ? `\n경고:\n  ${v.warnings.join('\n  ')}` : ''}`);
        }
        const opId = require('crypto').randomUUID();
        const r = await request('auto.create', { opId, draft: spec.value });
        const a = r && r.automation;
        return out(r, flags, a ? `${a.id}  ${a.name} — ${autoTrigText(a.trigger)}` : JSON.stringify(r));
      }
      case 'update': {
        if (!need(rest[0])) return;
        const spec = await readSpecJson(flags, rest.slice(1));
        if (spec.error) { process.stderr.write(`${spec.error}\n${AUTO_USAGE}`); process.exitCode = 2; return; }
        const r = await request('auto.update', { id: rest[0], patch: spec.value });
        return out(r, flags, r && r.automation ? autoLine(r.automation) : 'ok');
      }
      case 'pause':
      case 'resume': {
        if (!need(rest[0])) return;
        const r = await request(`auto.${sub}`, { id: rest[0] });
        return out(r, flags, r && r.automation ? autoLine(r.automation) : 'ok');
      }
      case 'run': {
        if (!need(rest[0])) return;
        const r = await request('auto.runNow', { opId: require('crypto').randomUUID(), id: rest[0], ...(flags['dry-run'] ? { dryRun: true } : {}) });
        if (r && r.rendered) return printJson(r);
        return out(r, flags, `실행 요청됨 ${r && r.firingId} — 결과는 cpt auto get ${rest[0]}`);
      }
      case 'remove': {
        if (!need(rest[0])) return;
        const r = await request('auto.remove', { id: rest[0] });
        return out(r, flags, '삭제됨');
      }
      case 'log': {
        const limit = flags.limit != null ? parseInt(flags.limit, 10) : undefined;
        const r = await request('auto.log', { ...(rest[0] ? { id: rest[0] } : {}), ...(Number.isInteger(limit) ? { limit } : {}) });
        return out(r, flags, ((r && r.lines) || []).map(autoLogLine).join('\n') || '(기록 없음)');
      }
      case 'schema': {
        const txt = autoSchemaText();
        if (txt == null) { process.stderr.write('가이드 파일(GUIDE.md)에서 자동화 절을 찾을 수 없습니다.\n'); process.exitCode = 1; return; }
        process.stdout.write(txt);
        return;
      }
      default:
        process.stderr.write(AUTO_USAGE);
        process.exitCode = 2;
        return;
    }
  } catch (e) {
    // 코드를 같이 보여 준다 — 에이전트가 AUTO_LOOP/AUTO_OUT_OF_TERMINAL 을 보고 스스로 물러날 근거.
    process.stderr.write(`오류${e && e.code ? `(${e.code})` : ''}: ${(e && e.message) || e}\n`);
    process.exitCode = 1;
  }
}

// ── 원격 승인 훅(PermissionRequest) ────────────────────────────────────────
//  기본값 130s = 데몬 하드 타임아웃(120s) + 여유 10s. 실제 값은 shim 이 데몬 설정에서 파생해
//  `--wait-ms` 로 넘긴다(단일 출처=runner-core/approvals.js budget()). 순서 불변식:
//    데몬 하드 타임아웃 < CLI 대기(--wait-ms) < claude 훅 config timeout
//  이 순서가 깨지면 claude 가 먼저 훅을 잘라 우리가 defer 를 제어하지 못한다(카드 회수 누락).
//  ★ 상한(MAX)은 **shim 이 넘기는 값보다 커야 한다**. 2026-07-28 실사고: 마감을 없애면서 데몬
//   (24h)과 back(25h) 은 고쳤는데 여기 570000(9.5분)을 못 고쳐, shim 이 `--wait-ms 86410000` 을
//   넘겨도 CLI 가 9.5분으로 잘라냈다 → 9.5분 뒤 훅 프로세스가 그냥 종료 → 소켓 close =
//   데몬이 `hook_gone` 으로 defer → 전 기기에서 질문 카드 회수. 사용자에겐 "가만 뒀는데 폼이
//   사라지고 TUI 에만 질문이 남는" 증상으로 보였다. 상한은 안전장치일 뿐 정책이 아니다.
const APPROVAL_WAIT_DEFAULT_MS = 130000;
const APPROVAL_WAIT_MIN_MS = 5000;
const APPROVAL_WAIT_MAX_MS = 25 * 3600 * 1000;

async function approvalHook(flags) {
  // 에이전트 판별 — codex 는 `--agent codex` 로 온다(shim 이 ~/.codex/hooks.json 에 그렇게 등록).
  //  codex 0.145 실측(2026-07-29): PermissionRequest 훅 입력이 claude 와 동형(session_id/cwd/
  //  permission_mode/transcript_path/tool_name/tool_input)이고 출력 계약도 같은 hookSpecificOutput.
  //  차이 2가지 — ① permission_suggestions 없음(→ "다음부터 묻지 않기" 선택지 없음)
  //             ② updatedPermissions 는 예약 필드(넣으면 fail-closed) — 데몬이 agent 로 차단한다.
  const agent = flags && flags.agent === 'codex' ? 'codex' : 'claude';
  let payload = null;
  try { payload = await readStdinJson({ waitMs: 2000 }); } catch (_) { return; }
  if (!payload || typeof payload !== 'object') return;      // 페이로드 파싱 실패 = 무출력(TUI 폴백)

  // 상태 보고(기능3)는 승인 기능과 독립이다 — 킬스위치/서버 미지원/오류와 무관하게 항상 자기보고한다.
  //  await 하지 않는다: 데몬이 느릴 때 그 지연이 곧 승인 대기(=claude 정지) 앞에 붙기 때문.
  //  codex 도 같은 v2 이벤트를 재사용한다(필드 이름이 동형) — agent 만 바꿔 싣는다.
  try {
    const ev = mapClaudeHook('permission', payload);
    if (ev) { ev.agent = agent; request('hook.event', ev, { timeoutMs: 3000 }).catch(() => {}); }
  } catch (_) { /* noop */ }

  // 킬스위치 — 기능 도입 전과 100% 동일 동작(무출력 + exit 0 → TUI 대화상자).
  if (process.env.CPT_APPROVAL === '0') return;

  const raw = parseInt((flags && flags['wait-ms']) || process.env.CPT_APPROVAL_WAIT_MS || '', 10);
  const waitMs = Math.max(APPROVAL_WAIT_MIN_MS,
    Math.min(APPROVAL_WAIT_MAX_MS, Number.isFinite(raw) && raw > 0 ? raw : APPROVAL_WAIT_DEFAULT_MS));

  let res = null;
  try {
    res = await request('approval.request', {
      agent,
      hookEventName: payload.hook_event_name || 'PermissionRequest',
      sessionId: payload.session_id || null,
      promptId: payload.prompt_id || null,
      toolUseId: payload.tool_use_id || null,
      toolName: payload.tool_name || null,
      toolInput: payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {},
      permissionMode: payload.permission_mode || null,
      transcriptPath: payload.transcript_path || null,
      hookCwd: payload.cwd || null,
      // "허용하고 다음부터 묻지 않기"(TUI 2번)의 재료 — claude 가 이 요청에 대해 제안한 권한 갱신.
      //  실측(2026-07-29, claude 2.1.220): addRules/addDirectories/setMode 가 온다. 우리는 addRules 만
      //  3번째 선택지로 쓰고(TUI 도 addRules 가 있을 때만 그 옵션을 띄운다), 사용자가 고르면 그대로
      //  decision.updatedPermissions 로 되돌려준다 — claude 가 실제로 settings 에 규칙을 기록한다(실측).
      permissionSuggestions: Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : null,
      waitMs,
    }, { timeoutMs: waitMs });
  } catch (_) {
    return; // 데몬 오프라인/구버전(알 수 없는 명령)/타임아웃/연결 끊김 — 전부 무출력(TUI 폴백)
  }

  const out = res && res.hookOutput;
  if (!validApprovalOutput(out)) return;                    // defer 이거나 계약 위반 → 무출력
  process.stdout.write(JSON.stringify(out) + '\n');
}

// 계약 최종 검증 — 데몬이 뭘 보내든 CLI 가 "allow/deny 결정 JSON" 이외를 stdout 에 흘리지 않게 한다.
//  (데몬 버전이 앞서가거나 손상된 응답을 받아도 claude 에게 쓰레기를 주지 않는다)
function validApprovalOutput(out) {
  if (!out || typeof out !== 'object') return false;
  const h = out.hookSpecificOutput;
  if (!h || h.hookEventName !== 'PermissionRequest') return false;
  const d = h.decision;
  if (!d || (d.behavior !== 'allow' && d.behavior !== 'deny')) return false;
  if (d.behavior === 'deny' && typeof d.message !== 'string') return false;
  return true;
}

// stdin 전체를 JSON 으로(훅 페이로드). 비 TTY 일 때만 시도.
//  타임아웃 300ms — claude 는 훅 프로세스를 띄우고 페이로드를 즉시 써서 stdin 을 close 한다(end 이벤트로
//  바로 끝난다). 과거 1500ms 는 stdin 이 안 닫히는 예외 상황에서만 쓰이던 순수 손실이었다.
//  승인 훅만 상한을 늘린다(waitMs) — 조기 resolve = 페이로드 절단 = 파싱 실패 = 승인 요청 유실이고,
//  그 비용(사용자가 폰에서 못 받음)이 300ms 절약보다 크다.
function readStdinJson({ waitMs = 300 } = {}) {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(safeParse(buf)), waitMs);
    process.stdin.on('data', (d) => { buf += d.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(safeParse(buf)); });
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// 스킬 전체 가이드 — cpt-cli 패키지에 동봉된 GUIDE.md 를 그대로 출력(바이너리 버전과 항상 일치).
//  소켓 불필요(순수 파일 읽기) — 데몬이 죽어 있어도 동작해 에이전트가 명령을 학습할 수 있다.
// ── 오케스트레이션(cpt orch …) ───────────────────────────────────────────────
//  명령 → RPC 는 얇은 변환이다. 판정(누가 워커이고 누가 코디네이터인가·상한·생존)은 전부 데몬(orch.js)이 한다.
//  기다리는 명령(check --wait · ask)은 데몬이 응답을 쥐고 있으므로 소켓 타임아웃을 대기 시간보다 길게 잡는다.
async function orchCommand(sub, rest, flags) {
  const f = (k) => (typeof flags[k] === 'string' ? flags[k] : undefined);
  const num = (k) => (flags[k] != null && flags[k] !== true && Number.isFinite(Number(flags[k])) ? Number(flags[k]) : undefined);
  const call = (method, args, opt) => request(method, args, opt);
  const need = (v, usage) => { if (v == null || v === '') { const e = new Error('사용법: cpt orch ' + usage); e.usage = true; throw e; } return v; };
  const GLYPH = { starting: '·', working: '●', asking: '?', blocked: '!', needs_input: '✋', idle_no_report: '…', exited: '×', succeeded: '✓', failed: '✗', stopped: '■', abandoned: '×' };
  const workerLine = (w) => `${GLYPH[w.uiState] || '?'} ${w.dispatchId} [${w.uiState}] ${w.agent || ''} ${w.title || ''}`
    + `${w.phase ? ` — ${w.phase}` : ''}${w.tid != null ? ` (터미널 ${w.tid})` : ''}`
    + `${w.liveness && w.liveness !== 'live' && !w.result ? ` · ${w.liveness}` : ''}`
    + `${w.attention && w.attention.categories && w.attention.categories.length ? ` ⚠ ${w.attention.categories.join(',')}` : ''}`;
  const waitOpt = () => {
    const ms = num('timeout-ms');
    return { timeoutMs: (ms || 100000) + 20000 };
  };
  try {
    switch (sub) {
      case 'status': {
        const r = await call('orch.status', {});
        const c = r.caller || {};
        return out(r, flags, `역할: ${c.role}${c.dispatch ? ` (시도 ${c.dispatch.dispatchId})` : ''}${c.runs && c.runs.length ? ` · 묶음 ${c.runs.join(',')}` : ''} · 깊이 ${c.depth || 0}/${r.limits.maxDepth} · 동시 워커 ${r.limits.maxWorkersPerRun}/묶음`);
      }
      case 'run-create': {
        const r = await call('orch.runCreate', { objective: need(f('objective') || rest.join(' '), 'run-create --objective "<목표>"') });
        return out(r, flags, `${r.run.id} 생성 — 이 터미널이 코디네이터입니다`);
      }
      case 'run-list': {
        const r = await call('orch.runList', { all: !!flags.all });
        return out(r, flags, (r.runs || []).map((x) => `${x.id} [${x.state}] ${String(x.objective).split('\n')[0].slice(0, 60)} — 진행 ${x.counts.active} · 성공 ${x.counts.succeeded} · 실패 ${x.counts.failed}`).join('\n') || '(묶음 없음)');
      }
      case 'run-show': {
        const r = await call('orch.runShow', { run: f('run') || rest[0] });
        return out(r, flags, [`${r.run.id} [${r.run.state}] ${String(r.run.objective).split('\n')[0]}`,
          '일:', ...(r.tasks || []).map((t) => `  ${t.id} [${t.status}] ${t.title}${t.deps.length ? ` ← ${t.deps.join(',')}` : ''}`),
          '워커:', ...(r.workers || []).map((w) => '  ' + workerLine(w))].join('\n'));
      }
      case 'run-close': {
        const r = await call('orch.runClose', { run: f('run') || rest[0], force: !!flags.force }, { timeoutMs: 260000 });
        return out(r, flags, `${r.run.id} 닫음${r.released && r.released.length ? ` — 워커 ${r.released.length}개 정리` : ''}`);
      }
      case 'task-create': {
        const r = await call('orch.taskCreate', { run: f('run'), spec: need(f('spec') || rest.join(' '), 'task-create --spec "<일>" [--deps <id,id>]'), deps: f('deps'), title: f('title') });
        return out(r, flags, `${r.task.id} [${r.task.status}] ${r.task.title}`);
      }
      case 'task-list': {
        const r = await call('orch.taskList', { run: f('run'), ready: !!flags.ready, brief: !!flags.brief });
        return out(r, flags, (r.tasks || []).map((t) => `${t.id} [${t.status}] ${t.title}${t.deps.length ? ` ← ${t.deps.join(',')}` : ''}`).join('\n') || '(일 없음)');
      }
      case 'task-update': {
        const r = await call('orch.taskUpdate', { task: need(f('task') || rest[0], 'task-update --task <id> [--status pending|completed|failed|blocked] [--spec "…"]'), status: f('status'), spec: f('spec'), title: f('title') });
        return out(r, flags, `${r.task.id} [${r.task.status}]`);
      }
      case 'worker-start': {
        const spec = f('spec');
        const task = f('task');
        if (!spec && !task) need(null, 'worker-start (--spec "<일>" | --task <id>) [--agent <id>] [--worktree current|new] [--model <id>] [--effort <e>] [--terminal <n>]');
        const r = await call('orch.workerStart', { run: f('run'), spec, task, title: f('title'), deps: f('deps'), agent: f('agent'), model: f('model'), effort: f('effort'),
          worktree: f('worktree'), terminal: f('terminal'), retryOf: f('retry-of'), force: !!flags.force }, { timeoutMs: 120000 });
        return out(r, flags, `${r.worker.dispatchId} 시작 — ${r.worker.agent} · ${r.worker.placement === 'worktree' ? '전용 작업 폴더' : '같은 폴더'}${r.worker.tid != null ? ` · 터미널 ${r.worker.tid}` : ''}\n일 ${r.task.id} · 묶음 ${r.run.id}`);
      }
      case 'worker-list': {
        const r = await call('orch.workerList', { run: f('run'), all: !!flags.all, terminalState: f('terminal-state') });
        return out(r, flags, (r.workers || []).map(workerLine).join('\n') || '(워커 없음)');
      }
      case 'worker-show': {
        const r = await call('orch.workerShow', { dispatch: need(f('dispatch') || rest[0], 'worker-show --dispatch <id>') });
        return out(r, flags, workerLine(r.worker) + (r.worker.result ? `\n결과(${r.worker.result.outcome}): ${r.worker.result.summary}` : '') + (r.worker.question ? `\n질문: ${r.worker.question.text}` : ''));
      }
      case 'worker-read': {
        const r = await call('orch.workerRead', { dispatch: need(f('dispatch') || rest[0], 'worker-read --dispatch <id> [--limit <줄>]'), limit: num('limit') });
        return out(r, flags, r.text || `(화면 없음: ${r.reason || ''})`);
      }
      case 'worker-release': {
        const r = await call('orch.workerRelease', { dispatch: need(f('dispatch') || rest[0], 'worker-release --dispatch <id> [--merge [merge|squash|ff]] [--message "…"]'), merge: flags.merge === undefined ? undefined : flags.merge, message: f('message') }, { timeoutMs: 260000 });
        return out(r, flags, r.already ? `이미 정리됨(${r.terminal})` : (r.merged ? '머지하고 정리했습니다' : '정리했습니다'));
      }
      case 'worker-retain': case 'worker-stop': case 'worker-abandon': {
        const m = { 'worker-retain': 'orch.workerRetain', 'worker-stop': 'orch.workerStop', 'worker-abandon': 'orch.workerAbandon' }[sub];
        const r = await call(m, { dispatch: need(f('dispatch') || rest[0], `${sub} --dispatch <id>`), reason: f('reason'), force: !!flags.force });
        return out(r, flags, r.worker ? workerLine(r.worker) : `터미널 ${r.terminal}`);
      }
      case 'send': {
        const r = await call('orch.send', { run: f('run'), to: f('to'), type: f('type'), subject: f('subject'), body: f('body'), dispatch: f('dispatch') || f('dispatch-id'), outcome: f('outcome'), phase: f('phase'), files: f('files') || f('files-modified'), report: f('report') || f('report-path') });
        return out(r, flags, r.accepted === false ? `거부: ${(r.settlement && r.settlement.reason) || r.reason || ''}` : `보냄${r.to ? ` → ${r.to.join(', ')}` : ''}`);
      }
      // 워커 전용 줄임 명령 — 안내문(머리말)에 이 형태로 들어간다.
      case 'done': {
        const r = await call('orch.send', { type: 'worker_done', dispatch: f('dispatch'), outcome: need(f('outcome'), 'done --dispatch <id> --outcome succeeded|failed --summary "<세 문장>"'), body: f('summary') || f('body'), subject: f('subject'), files: f('files'), report: f('report') });
        if (r.accepted === false) { process.exitCode = 1; return out(r, flags, `거부: ${r.settlement.reason}`); }
        return out(r, flags, `보고 완료(${r.settlement.outcome}${r.settlement.duplicate ? ', 이미 보고됨' : ''}) — 이 턴을 끝내고 기다리세요.`);
      }
      case 'heartbeat': {
        const r = await call('orch.send', { type: 'heartbeat', dispatch: f('dispatch'), phase: f('phase') });
        return out(r, flags, r.accepted ? `ok${r.pendingMail ? ` — 읽지 않은 지시 ${r.pendingMail}건(cpt orch check)` : ''}` : '끝난 시도입니다');
      }
      case 'escalate': {
        const r = await call('orch.send', { type: 'escalation', dispatch: f('dispatch'), subject: f('subject'), body: f('body') });
        return out(r, flags, '코디네이터에게 알렸습니다');
      }
      case 'check': {
        const r = await call('orch.check', { run: f('run'), as: f('as'), wait: !!flags.wait, types: f('types'), timeoutMs: num('timeout-ms'), ack: f('ack'), peek: !!flags.peek, all: !!flags.all }, flags.wait ? waitOpt() : undefined);
        const msgs = (r.messages || []).map((m) => `[${m.type}] ${m.id}${m.dispatchId ? ` (${m.dispatchId})` : ''} ${m.subject}${m.payload && m.payload.outcome ? ` — ${m.payload.outcome}` : ''}\n    ${String(m.body || '').replace(/\n/g, '\n    ')}`);
        const head = r.timeout ? '시간 초과(실패 아님) — 계속 기다리세요' : r.empty ? '새 메시지 없음' : r.peek ? `읽지 않은 메시지 ${msgs.length}건(미리보기)` : `메시지 ${msgs.length}건${r.replay ? '(다시 받음 — 아직 확인 처리 안 됨)' : ''}`;
        const tail = (r.workers || []).length ? ['워커:', ...r.workers.map((w) => `  ${GLYPH[w.uiState] || '?'} ${w.dispatchId} [${w.uiState}] ${w.title}${w.phase ? ` — ${w.phase}` : ''}${w.attention.length ? ` ⚠ ${w.attention.join(',')}` : ''}`)] : [];
        return out(r, flags, [head, ...msgs, ...(r.ack ? [`다 처리한 뒤: ${r.ack}`] : []), ...tail].join('\n'));
      }
      case 'ask': {
        const args = flags.resume ? { resume: f('resume'), timeoutMs: num('timeout-ms') }
          : { dispatch: f('dispatch'), question: need(f('question') || rest.join(' '), 'ask --dispatch <id> --question "<질문>" [--options "a,b"]'), options: f('options'), timeoutMs: num('timeout-ms') };
        const r = await call('orch.ask', args, waitOpt());
        return out(r, flags, r.answered ? `답: ${r.answer}` : r.closed ? '질문이 닫혔습니다' : `아직 답이 없습니다 — 이어서 기다리기: ${r.resume}`);
      }
      case 'reply': {
        const r = await call('orch.reply', { id: need(f('id') || rest[0], 'reply --id <messageId> --body "<답>"'), body: need(f('body') || rest.slice(1).join(' '), 'reply --id <messageId> --body "<답>"') });
        return out(r, flags, r.duplicate ? '이미 답한 질문입니다' : '답을 보냈습니다');
      }
      case 'gate-create': {
        const r = await call('orch.gateCreate', { run: f('run'), task: f('task'), question: need(f('question'), 'gate-create --question "<결정>" --options "a,b" [--task <id>]'), options: need(f('options'), 'gate-create --question "<결정>" --options "a,b"') });
        return out(r, flags, `${r.gate.id} — 사용자(또는 gate-resolve)가 고를 때까지 기다립니다`);
      }
      case 'gate-resolve': {
        const r = await call('orch.gateResolve', { id: need(f('id') || rest[0], 'gate-resolve --id <gateId> --resolution "<선택>"'), resolution: need(f('resolution'), 'gate-resolve --id <gateId> --resolution "<선택>"') });
        return out(r, flags, `결정: ${r.gate.resolution}`);
      }
      case 'gate-list': {
        const r = await call('orch.gateList', { run: f('run'), task: f('task'), pending: !!flags.pending });
        return out(r, flags, (r.gates || []).map((g) => `${g.id} [${g.status}] ${g.question}${g.resolution ? ` → ${g.resolution}` : ` (${g.options.join(' / ')})`}`).join('\n') || '(결정 없음)');
      }
      default:
        process.stderr.write('사용법: cpt orch <status|run-create|worker-start|check|reply|send|worker-list|worker-show|worker-read|worker-release|worker-retain|worker-stop|worker-abandon|task-create|task-list|task-update|gate-create|gate-resolve|gate-list|run-show|run-list|run-close>\n전체 가이드: cpt skills get cpt-orch\n');
        process.exitCode = 2;
    }
  } catch (e) {
    if (e && e.usage) { process.stderr.write(e.message + '\n'); process.exitCode = 2; return; }
    throw e;
  }
}

// 이슈 — CodingPT 자체 이슈 + 연결된 외부 서비스(GitHub) 이슈를 한 목록으로. 화면(PC·폰)과 같은 것을 다룬다.
async function issueCommand(sub, rest, flags) {
  const f = (k) => (typeof flags[k] === 'string' ? flags[k] : undefined);
  const need = (v, usage) => { if (v == null || v === '') { const e = new Error('사용법: cpt issue ' + usage); e.usage = true; throw e; } return v; };
  const MARK = { todo: '○', in_progress: '◐', in_review: '◑', done: '●' };
  const line = (x) => `${MARK[x.status] || '?'} ${x.key} [${x.status}] ${x.title}${x.priority && x.priority !== 'none' ? ` (${x.priority})` : ''}${x.source.provider !== 'codingpt' ? ` · ${x.source.provider}` : ''}${x.cwd ? ` · ${x.cwd}` : ''}   id=${x.id}`;
  const ws = process.env.CPT_WS || '';
  try {
    switch (sub) {
      case 'list': case undefined: {
        const r = await request('orch.issueList', { cwds: flags.all ? [] : [f('cwd') || ws].filter(Boolean), fresh: !!flags.fresh }, { timeoutMs: 45000 });
        let items = r.issues || [];
        if (f('status')) items = items.filter((x) => x.status === f('status'));
        if (f('source')) items = items.filter((x) => x.source.provider === f('source'));
        if (!flags.done && !f('status')) items = items.filter((x) => x.status !== 'done');
        return out({ ...r, issues: items }, flags, items.map(line).join('\n') || '(이슈 없음)');
      }
      case 'show': {
        const r = await request('orch.issueGet', { id: need(rest[0], 'show <id|#번호>') });
        const x = r.issue;
        return out(r, flags, `${line(x)}\n${x.source.url || ''}\n\n${x.body || '(본문 없음)'}`);
      }
      case 'create': {
        const title = need(f('title') || rest.join(' '), 'create --title "<제목>" [--body "<본문>"] [--priority low|medium|high|urgent] [--labels a,b] [--github]');
        const r = await request('orch.issueCreate', { title, body: f('body'), status: f('status'), priority: f('priority'), labels: f('labels'),
          cwd: f('cwd') || ws, provider: flags.github ? 'github' : 'codingpt' }, { timeoutMs: 45000 });
        return out(r, flags, `만들었습니다: ${line(r.issue)}`);
      }
      case 'update': {
        const id = need(rest[0], 'update <id|#번호> [--status todo|in_progress|in_review|done] [--title …] [--body …] [--priority …] [--labels a,b]');
        const r = await request('orch.issueUpdate', { id, status: f('status'), title: f('title'), body: f('body'), priority: f('priority'), labels: f('labels') }, { timeoutMs: 45000 });
        return out(r, flags, line(r.issue));
      }
      case 'close': {
        const r = await request('orch.issueUpdate', { id: need(rest[0], 'close <id|#번호>'), status: 'done' }, { timeoutMs: 45000 });
        return out(r, flags, line(r.issue));
      }
      case 'delete': {
        const r = await request('orch.issueDelete', { id: need(rest[0], 'delete <id|#번호>') });
        return out(r, flags, '지웠습니다');
      }
      case 'start': {
        const id = need(rest[0], 'start <id|#번호> [--mode task|terminal|orch] [--agent claude|codex|gemini] [--model <id>] [--cwd <폴더>]');
        const r = await request('orch.issueStart', { id, mode: f('mode'), agent: f('agent'), model: f('model'), cwd: f('cwd') || ws }, { timeoutMs: 90000 });
        return out(r, flags, `시작했습니다(${r.started.mode}${r.started.taskId ? ` · 작업 ${r.started.taskId}` : ''}${r.started.tid != null ? ` · 터미널 ${r.started.tid}` : ''}): ${line(r.issue)}`);
      }
      default:
        process.stderr.write('사용법: cpt issue <list|show|create|update|close|delete|start>\n');
        process.exitCode = 2;
    }
  } catch (e) {
    if (e && e.usage) { process.stderr.write(e.message + '\n'); process.exitCode = 2; return; }
    throw e;
  }
}

function printSkillGuide(name) {
  const FILES = { 'cpt-cli': 'GUIDE.md', 'cpt-orch': 'ORCH.md' };
  const file = FILES[name || 'cpt-cli'];
  if (!file) {
    process.stderr.write(`알 수 없는 스킬: ${name} (사용 가능: ${Object.keys(FILES).join(', ')})\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  } catch (_) {
    process.stderr.write('가이드 파일(GUIDE.md)을 찾을 수 없습니다.\n');
    process.exitCode = 1;
  }
}

// ── claude 훅 페이로드 → hook.event v2 매핑 ─────────────────────────────────
//  래퍼 인자(케밥) → 와이어 event(스네이크). 모르는 값은 null 반환 → CLI 가 조용히 exit 0.
const CLAUDE_HOOK_EVENTS = {
  'session-start': 'session_start',
  prompt: 'prompt',
  permission: 'permission',
  notification: 'notification',
  stop: 'stop',
  'stop-failure': 'stop_failure',
  'session-end': 'session_end',
};

function clip(v, n) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n); }
function len(v) { return Array.isArray(v) ? v.length : 0; }

// 도구 정보 — 입력 전문은 보내지 않는다(민감 내용·용량). 상관용 digest + 짧은 프리뷰만.
function toolOf(d) {
  if (!d || !d.tool_name) return null;
  let digest = null;
  let preview = '';
  try {
    const s = typeof d.tool_input === 'string' ? d.tool_input : JSON.stringify(d.tool_input || {});
    digest = 'sha1:' + require('crypto').createHash('sha1').update(s).digest('hex');
    preview = clip(s, 200);
  } catch (_) { /* 직렬화 불가(순환 등) — digest 없이 이름만 */ }
  return { name: String(d.tool_name), useId: d.tool_use_id || null, inputDigest: digest, inputPreview: preview };
}

function mapClaudeHook(sub, payload) {
  const event = CLAUDE_HOOK_EVENTS[sub];
  if (!event) return null;
  const d = payload || {};
  const ev = {
    v: 2,
    agent: 'claude',
    event,
    at: Date.now(),                          // 데몬이 훅 도착 지연(at vs 수신시각)을 계측한다
    sessionId: d.session_id || null,
    promptId: d.prompt_id || null,
    permissionMode: d.permission_mode || null,
    agentCwd: d.cwd || null,                 // ctx.ws 와 다를 수 있다(진단용)
    transcriptPath: d.transcript_path || null, // 데몬은 읽지 않는다 — 포인터만
    summary: '',
    tool: null,
    notificationType: null,
    suggestions: null,
    stopHookActive: !!d.stop_hook_active,
    backgroundTasks: len(d.background_tasks), // >0 이면 "턴 종료"가 아니다(백그라운드 대기) → 데몬이 알림 억제
    sessionCrons: len(d.session_crons),
    sessionSource: null,
    endReason: null,
    // 서브에이전트에서 발화한 이벤트 표식 — 데몬이 상태/알림에서 제외한다(병렬 N건 오알림 방지).
    //  ⚠ 판정은 agent_id 단독으로만 한다. agent_type 은 메인 세션의 SessionStart 페이로드에도 실려 오므로
    //  (실측) 이걸 판정에 넣으면 메인 세션 session_start 가 통째로 서브에이전트로 오분류돼 버려지고,
    //  상태가 launching 에 영구 고착된다. agent_type 은 진단용으로만 함께 싣는다.
    subagent: d.agent_id ? { id: d.agent_id, type: d.agent_type || null } : null,
    agentType: d.agent_type || null, // 진단 전용(판정에 쓰지 말 것)
  };
  switch (event) {
    case 'session_start':
      ev.sessionSource = d.source || null;   // startup|resume|clear|compact|fork
      break;
    case 'prompt':
      // 프롬프트 본문(d.prompt)은 보내지 않는다 — 상태 전이(working)에 불필요하고 알림 본문도 아니다.
      break;
    case 'permission':
      ev.tool = toolOf(d);
      ev.suggestions = Array.isArray(d.permission_suggestions) ? d.permission_suggestions : null;
      break;
    case 'notification':
      ev.notificationType = d.notification_type || null; // permission_prompt|idle_prompt|…
      ev.summary = clip(d.message, 2000);
      break;
    case 'stop':
      ev.summary = stopSummary(d);
      break;
    case 'stop_failure':
      ev.summary = clip(d.error_details || d.error || d.last_assistant_message, 2000);
      break;
    case 'session_end':
      ev.endReason = d.reason || null;
      break;
  }
  if (!ev.tool && d.tool_name) ev.tool = toolOf(d);
  return ev;
}

// 턴 요약 — payload 의 last_assistant_message 가 정본(claude 가 "트랜스크립트를 읽고 파싱할 필요를
//  없애기 위해" 넣어준 필드). 없을 때(구버전 claude)만 트랜스크립트 tail 폴백.
function stopSummary(d) {
  const m = clip(d && d.last_assistant_message, 2000);
  if (m) return m;
  return tailAssistantSummary(d && d.transcript_path);
}

// 트랜스크립트 폴백 — 파일 "끝에서" 최대 4×256KB 만 역방향으로 읽는다.
//  ⚠ readFileSync 금지: 이 리포의 최대 트랜스크립트는 1.25GB 로, 전체 읽기는 ERR_STRING_TOO_LONG 으로
//    던지면서 RSS 3.3GB 를 튀긴다(실측) → 긴 세션의 완료 알림 본문이 항상 비어 있었다. 상한이 있는
//    tail 읽기만 허용한다(메모리 ≤ 약 1MB, 시간 ≤ 수 ms).
function tailAssistantSummary(p) {
  const CHUNK = 256 * 1024;
  const MAX_CHUNKS = 4;
  let fd = null;
  try {
    if (!p) return '';
    const size = fs.statSync(p).size;
    if (!size) return '';
    fd = fs.openSync(p, 'r');
    let pos = size;
    const parts = [];
    for (let n = 0; n < MAX_CHUNKS && pos > 0; n++) {
      const want = Math.min(CHUNK, pos);
      pos -= want;
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const r = fs.readSync(fd, buf, got, want - got, pos + got);
        if (!r) break;
        got += r;
      }
      parts.unshift(buf.subarray(0, got));
      // 청크 경계에서 멀티바이트 문자가 쪼개질 수 있어 매번 전체를 한 번에 디코드한다(≤1MB).
      const text = Buffer.concat(parts).toString('utf8');
      const lines = text.split('\n');
      if (pos > 0) lines.shift();            // 파일 시작이 아니면 첫 줄은 잘린 조각 — 버린다
      const hit = scanAssistant(lines);
      if (hit) return hit;
    }
  } catch (_) { /* 없음/권한/깨진 파일 — 요약 없이 진행 */ } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* noop */ } }
  }
  return '';
}

// jsonl 줄 배열을 뒤에서 최대 80줄 스캔해 마지막 assistant 텍스트를 찾는다.
function scanAssistant(lines) {
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 80; i--) {
    const line = lines[i];
    if (!line) continue;
    seen++;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const msg = j && (j.message || j);
    if ((j.type === 'assistant' || (msg && msg.role === 'assistant')) && msg && Array.isArray(msg.content)) {
      const texts = msg.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim();
      if (texts) return texts.replace(/\s+/g, ' ').slice(0, 300);
    }
  }
  return '';
}

// 직접 실행(셸 shim: node cpt.js …)일 때만 CLI 로 동작. require 로 불러오면 순수 함수만 노출해
//  훅 매핑/요약 추출을 소켓·tmux 없이 단위 검증할 수 있다.
if (require.main === module) main();

module.exports = { mapClaudeHook, tailAssistantSummary, scanAssistant, tmuxSelfFromEnv, validApprovalOutput };
