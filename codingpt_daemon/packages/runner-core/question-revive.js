// question-revive — TUI 로 폴백된 미응답 다이얼로그의 **알림 되살리기** 리컨실러.
//  (질문 AskUserQuestion + 권한 "Do you want to proceed?" — 2026-07-29 권한형 추가)
//
// 원칙(2026-07-29 사용자 확정): **채팅 카드 = TUI 화면의 미러**. TUI 에 다이얼로그가 떠 있는 한
//  채팅에도 같은 선택지의 카드가 있어야 하고, 다이얼로그가 사라지면 카드도 사라져야 한다.
//  훅이 살아 있는 정상 경로는 이 파일과 무관하다 — 여기는 훅이 끊긴 뒤(데몬 재시작 등) TUI 만
//  남은 비대칭을 화면 기준으로 화해시키는 장치다.
//
// 동작(20s 틱):
//  ① 훅 바인딩이 있는 claude 터미널을 순회한다(바인딩 = 그 터미널에서 claude 훅이 돌았다는 증거).
//  ② 화면에 다이얼로그가 실제로 떠 있는지 본다 — **화면이 정본**이다.
//     · 질문형: "Enter to select" 푸터 → 트랜스크립트에서 질문 payload 를 읽어 재광고.
//     · 권한형: "Do you want to …?" + "Esc to cancel" 푸터 → **화면을 파싱**해 재광고(승인은
//       대기 중에 트랜스크립트에 안 적히므로 화면이 유일한 근거다). 선택지는 화면 문구 그대로
//       카드에 싣는다 — TUI 와 글자까지 동일(2026-07-29 사용자 확정).
//  ③ 다이얼로그가 사라졌으면(로컬에서 답함/Esc/세션 종료) 재광고 슬롯을 회수한다 — 배너도 걷힌다.
//     내용이 바뀌었으면(다른 명령의 다이얼로그) 옛 슬롯을 걷고 새로 광고한다(dedupeKey).
//
// 응답 전달(= requestTui 의 drive):
//  · 질문형 → cpt-server.chatAnswer(다이얼로그 키 조작). 질문 전부에 답이 있어야 한다.
//  · 권한형 → cpt-server.permissionAnswer(숫자키 1번 — 2026-07-29 PTY 실측: Enter 불필요).
//    카드에서 고른 라벨을 화면 옵션 번호로 되돌려 누른다. "don't ask again" 옵션도 TUI 자신이
//    규칙을 기록하므로 훅 없이 완전 동작한다.
//
// 멱등/폭주 안전: requestTui 의 id 는 (cwd|tid|dedupeKey) 해시라 틱이 겹쳐도 1건이고,
//  back advertise 도 id 멱등이다. 순회 대상은 바인딩 수(작다)이며 capture-pane 은 로컬 tmux 조회다.
const crypto = require('crypto');
// 4s: 미러의 체감 지연 상한. capture-pane 은 로컬 tmux 조회(ms 단위)라 바인딩 몇 개 수준에선 공짜에
//  가깝다. 훅이 끊기는 순간(다이얼로그가 곧 뜨는 타이밍)은 pokeSoon() 이 별도로 즉시 당긴다.
const POLL_MS = 4 * 1000;

let timer = null;
let pokeTimers = [];

function log(msg) { console.log(`[q-revive] ${msg}`); }

// 감시 대상 = **살아 있는 모든 CodingPT 터미널**(2026-07-29 확장 — claude 훅 바인딩 한정 폐지).
//  codex 등 훅 바인딩이 없는 에이전트의 폴백 다이얼로그도 미러해야 하기 때문. 세션 이름
//  (cpt-<ws>--t-<tid>)에서 tid 를 얻고, 워크스페이스 상대경로는 세션 env 의 CPT_WS(스폰 시점에
//  주입되는 정본)로 되찾는다 — 이름 슬러그의 역해석은 손실이 있어 쓰지 않는다.
const MAX_PANES_PER_TICK = 60; // 폭주 가드(capture-pane 는 로컬 tmux 조회지만 상한은 둔다)
const cwdBySession = new Map(); // session → cwdRel 캐시(env 는 세션 수명 동안 불변)

async function listPanes(ptyLib) {
  let out = '';
  try { out = await ptyLib.runTmux(['list-windows', '-a', '-F', '#{session_name}']); } catch (_) { return []; }
  const seen = new Set();
  const panes = [];
  for (const raw of out.split('\n')) {
    const sname = raw.trim();
    const m = /^(.+)--t-(\d+)$/.exec(sname);
    if (!m || !sname.startsWith('cpt-') || seen.has(sname)) continue;
    seen.add(sname);
    panes.push({ session: sname, tid: parseInt(m[2], 10) });
    if (panes.length >= MAX_PANES_PER_TICK) break;
  }
  return panes;
}

async function cwdRelOf(ptyLib, session) {
  if (cwdBySession.has(session)) return cwdBySession.get(session);
  let rel = null;
  try {
    const out = await ptyLib.runTmux(['show-environment', '-t', `=${session}`, 'CPT_WS']);
    const m = /^CPT_WS=(.*)$/m.exec(out || '');
    if (m) rel = m[1].trim();
  } catch (_) { rel = null; }
  if (rel != null) cwdBySession.set(session, rel);
  return rel;
}

async function poll() {
  const transcript = require('./transcript');
  const approvals = require('./approvals');
  const ptyLib = require('./pty');
  if (approvals.gateReason && approvals.gateReason()) return; // 승인 기능이 꺼져 있으면 전부 무의미

  const panes = await listPanes(ptyLib);
  const liveDialogs = new Set(); // `${cwdRel}|${tid}` — 이번 틱에 다이얼로그가 확인된 pane
  for (const { session, tid } of panes) {
    let screen = null;
    try {
      screen = await ptyLib.runTmux(['capture-pane', '-p', '-t', `=${session}:0`]);
    } catch (_) { screen = null; } // 터미널 없음(닫힘) — 틱 끝의 슬롯 화해가 걷는다
    const questionUp = !!screen && /Enter to select/.test(screen);
    const perm = !questionUp && screen ? parsePermissionDialog(screen) : null;
    if (!questionUp && !perm) continue;
    const cwdRel = await cwdRelOf(ptyLib, session);
    if (cwdRel == null) continue;   // CPT_WS 없는 세션(레거시) — 카드 좌표를 만들 수 없다
    liveDialogs.add(`${cwdRel}|${tid}`);
    const slot = approvals.tuiSlotFor(cwdRel, tid);

    // ── 권한형("Do you want to proceed?") — 화면이 유일한 근거(트랜스크립트에 안 적힌다) ──
    if (perm) {
      if (slot) {
        if ((slot.meta && slot.meta.dedupeKey) === perm.key) continue;   // 같은 다이얼로그 유지(멱등)
        // 종류가 바뀌었거나(질문→권한) 다른 명령의 다이얼로그 — 옛 슬롯을 걷고 새로 광고한다.
        approvals.cancelTui(slot.id, 'dialog_changed');
      }
      if (approvals.hasPending(cwdRel, tid)) continue; // 훅 승인이 살아 있음 = 정상 경로가 처리 중
      approvals.requestTui({
        cwdRel, tid, sessionId: null, toolUseId: null,
        dedupeKey: perm.key, revKind: 'perm',
        tool: perm.tool, summary: perm.summary,
        questions: [perm.question],
        drive: (outcome) => deliverPermission(cwdRel, tid, perm, outcome),
      });
      log(`권한 다이얼로그 재광고 ws=${cwdRel || '-'} tid=${tid} 옵션 ${perm.options.length}개`);
      continue;
    }

    // ── 질문형(AskUserQuestion) — 트랜스크립트가 payload 근거 ──
    if (slot) {
      if (slot.meta && slot.meta.revKind === 'perm') approvals.cancelTui(slot.id, 'dialog_changed'); // 권한→질문 전환
      else continue;                             // 이미 재광고됨(멱등)
    }
    if (approvals.hasPending(cwdRel, tid)) continue; // 훅 승인이 살아 있음 = 정상 경로가 처리 중

    let q = null;
    try { q = await transcript.pendingQuestionFor(cwdRel, tid); } catch (_) { q = null; }
    if (!q) continue;                            // 화면엔 다이얼로그, 트랜스크립트엔 근거 없음 — 보수적으로 침묵
    approvals.requestTui({
      cwdRel, tid, sessionId: q.sessionId, toolUseId: q.toolUseId, questions: q.questions,
      drive: (outcome) => deliver(cwdRel, tid, q, outcome),
    });
  }

  // ── 틱 끝 화해 — 다이얼로그가 확인되지 않은 pane 의 미러 슬롯을 걷는다(로컬에서 답함/Esc/
  //  세션 종료/터미널 삭제 전부 이 한 규칙으로 수렴: 화면에 없으면 카드도 없다). ──
  for (const slot of approvals.tuiSlots()) {
    if (liveDialogs.has(`${slot.cwdRel}|${slot.tid}`)) continue;
    approvals.cancelTui(slot.id, 'dialog_gone');
    log(`회수 ${slot.id} (다이얼로그 소멸) ws=${slot.cwdRel || '-'} tid=${slot.tid}`);
  }
}

// ── 권한 다이얼로그 화면 파싱(claude + codex 겸용) ──────────────────────────
// 실캡처 2종(2026-07-29) 기준 구조:
//  · claude 2.1.220:
//    ───────────────────              ← 구분선
//     Bash command                    ← 제목(도구)
//     rm … && git -C                  ← 명령(줄바꿈될 수 있음)
//     /Users/… status --short
//     Remove the demo file and …      ← 설명(회색 한 줄, 없을 수 있음)
//     This command requires approval
//     Do you want to proceed?
//     ❯ 1. Yes / 2. Yes, and don't ask again for: … / 3. No
//     Esc to cancel · Tab to amend · ctrl+e to explain
//  · codex 0.145:
//     Would you like to run the following command?
//     Environment: local
//     $ rm x.txt                      ← 본문이 질문 **아래**에 온다
//     › 1. Yes, proceed (y) / 2. Yes, and don't ask again … / 3. No, and tell Codex …
//     Press enter to confirm or esc to cancel
//  두 TUI 모두 **숫자키 한 번**으로 즉시 동작한다(각각 PTY 실측).
//  ⚠ 화면엔 지난 대화의 다이얼로그 **잔상**이 남을 수 있다 → 질문 줄은 아래에서부터 찾는다(살아
//   있는 다이얼로그는 항상 화면 맨 아래 블록이다). 옵션 문구는 줄바꿈 연속행을 이어 붙인다.
//  본문은 **줄 구조를 보존**해 카드가 TUI 와 같은 모양(명령 줄들 + 설명 줄)으로 그리게 한다.
const QUESTION_LINE_RE = /^\s*(Do you want to|Would you like to) .{0,160}\?\s*$/;
const FOOTER_RE = /esc to cancel/i; // claude "Esc to cancel · …" / codex "… or esc to cancel"
// flow(추가 지시 텍스트 전달 방식) 판별은 **푸터**로 한다 — 질문 문구는 겹친다(claude 플랜
//  다이얼로그도 "Would you like to proceed?"). codex 푸터만 "Press enter to confirm …" 형태.
//  · amend(claude): 해당 옵션에 Tab → 인라인 타이핑 → Enter (2026-07-29 실측: Yes/No 만 입력
//    가능, "always allow/don't ask again" 옵션은 타이핑 무반응. 옵션별 버퍼·한글 OK).
//  · interrupt(codex): 숫자키로 "No, and tell …" 선택 → 대화 인터럽트 → 컴포저에 지시 타이핑
//    +Enter (2026-07-29 실측: 인라인 입력 없음(Tab 무반응), 인터럽트 후 지시가 모델에 전달됨).
const INTERRUPT_FOOTER_RE = /press enter to confirm/i;
const NO_INPUT_LABEL_RE = /always allow|don.?t ask again/i;

function optionAcceptsInput(flow, label) {
  const l = String(label || '');
  if (flow === 'interrupt') return /^No\b/i.test(l);            // codex: 거절+지시만
  return /^(Yes|No)\b/i.test(l) && !NO_INPUT_LABEL_RE.test(l);  // claude: Yes/No (always 계열 제외)
}

function parsePermissionDialog(screen) {
  const lines = String(screen || '').split('\n');
  // ⚠ 푸터는 라이브 판정의 **충분조건이지 필요조건이 아니다**(2026-07-29 실사고): claude 의
  //  Fetch(WebFetch) 다이얼로그는 "Esc to cancel …" 푸터 없이 옵션 3줄로 끝난다 — 푸터를 필수로
  //  걸면 이 다이얼로그가 미러에서 영영 빠진다(사용자 신고: 훅 마감 후 카드 실종의 진범).
  //  푸터가 없으면 "옵션 블록이 화면 **맨 아래**에 있다"로 라이브를 판정한다(살아 있는 다이얼로그는
  //  항상 화면 끝이고, 잔상은 그 아래에 다른 출력이 쌓인다).
  const hasFooter = lines.some((l) => FOOTER_RE.test(l));
  let pi = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION_LINE_RE.test(lines[i])) { pi = i; break; }
  }
  if (pi < 0) return null;

  // 옵션 + 질문-아래 본문(codex) — "N. 라벨" 행이 나오기 전의 비어있지 않은 줄은 본문이다.
  const options = [];
  const midBody = [];
  let lastOptIdx = -1; // 마지막 옵션(연속행 포함) 줄 번호 — 푸터 없는 다이얼로그의 맨-아래 판정용
  for (let i = pi + 1; i < lines.length; i++) {
    const l = lines[i];
    if (FOOTER_RE.test(l)) break;
    const m = /^\s*[❯›>]?\s*([1-9])\.\s+(.*\S)\s*$/.exec(l);
    if (m) { options.push({ n: parseInt(m[1], 10), label: m[2].trim() }); lastOptIdx = i; continue; }
    if (!l.trim()) { if (options.length) break; continue; }
    if (/^\s*\$\s/.test(l)) { if (options.length) break; midBody.push(l.trim()); continue; } // 셸 프롬프트 줄 = 옵션 연속행 아님(잔상 가드). 질문-아래 본문(codex "$ cmd")은 유지
    if (options.length) { options[options.length - 1].label += ' ' + l.trim(); lastOptIdx = i; } // 옵션 문구 줄바꿈
    else midBody.push(l.trim());
  }
  if (options.length < 2) return null;
  if (!hasFooter) {
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { lastNonEmpty = i; break; } }
    if (lastNonEmpty !== lastOptIdx) return null; // 옵션 아래에 다른 출력 = 잔상(라이브 아님)
  }

  // 질문-위 본문(claude) — 구분선(───)이나 트랜스크립트 글머리(⏺/•)까지 거슬러 올라간다.
  let top = pi;
  for (let i = pi - 1; i >= 0; i--) {
    if (/^\s*─{4,}\s*$/.test(lines[i]) || /^\s*[⏺•✓✳✶✻]/.test(lines[i])) break;
    top = i;
  }
  const preBody = lines.slice(top, pi).map((l) => l.trim())
    .filter((l) => l && !/^This command requires approval$/.test(l) && !/^─+$/.test(l));
  const title = pickTitle(preBody, lines[pi]);
  // 본문 = 제목을 뺀 나머지 줄들 — **줄바꿈 보존**(카드가 TUI 와 같은 줄 구조로 그린다).
  //  질문 줄("Do you want to …?")도 **화면 순서 그대로** 넣는다(2026-07-29 사용자 지적: TUI 에
  //  나오는 건 다 카드에도 — claude 는 본문 뒤, codex 는 본문 앞이 자연히 재현된다).
  //  단 expect/summary(화면 검증·요약)는 질문 줄이 아니라 **명령 줄**이어야 특이적이다.
  const qLine = (lines[pi] || '').trim();
  const coreLines = [...preBody.filter((l) => l !== title), ...midBody];
  const bodyLines = [...preBody.filter((l) => l !== title), qLine, ...midBody];
  const body = bodyLines.join('\n').slice(0, 1000);

  // 카드는 화면 문구 그대로 — 질문 1개(단일선택)로 모델링해 기존 선택지 카드/조작 배관을 재사용한다.
  //  옵션의 input 표식 = 그 선택지에 추가 지시 텍스트를 같이 보낼 수 있다(카드가 입력창을 그린다).
  const flow = lines.some((l) => INTERRUPT_FOOTER_RE.test(l)) ? 'interrupt' : 'amend';
  const question = {
    question: body || (lines[pi] || '').trim(),
    header: title,
    multiSelect: false,
    options: options.map((o) => ({
      label: o.label.slice(0, 200),
      ...(optionAcceptsInput(flow, o.label) ? { input: true } : {}),
    })),
  };
  const key = 'perm|' + crypto.createHash('sha256')
    .update([title, question.question, ...options.map((o) => `${o.n}.${o.label}`)].join('|')).digest('hex').slice(0, 16);
  // expect(조작 전 화면 검증용)는 한 줄이어야 한다 — 본문 첫 줄(명령)이 가장 특이적이다.
  const expect = coreLines[0] || title;
  return { key, title, tool: toolOfDialogTitle(title), summary: coreLines[0] || title, question, options, expect, flow };
}

// 제목 고르기 — claude 는 질문-위 블록의 첫 줄("Bash command"), codex 는 질문 문구로 유추한다.
function pickTitle(preBody, questionLine) {
  if (preBody.length) return preBody[0];
  const q = String(questionLine || '');
  if (/run the following command/i.test(q)) return 'Bash command';
  if (/edit|patch/i.test(q)) return 'Edit file';
  return q.trim() || 'Permission';
}

// 다이얼로그 제목 → 도구명(느슨한 매핑 — 못 알아보면 제목 그대로. 카드 제목/푸시 머리에만 쓰인다).
function toolOfDialogTitle(title) {
  const s = String(title || '').toLowerCase();
  if (s.includes('bash')) return 'Bash';
  if (s.includes('edit')) return 'Edit';
  if (s.includes('write') || s.includes('create file')) return 'Write';
  if (s.includes('fetch')) return 'WebFetch';
  if (s.includes('read')) return 'Read';
  return String(title || 'Permission');
}

// 권한 카드의 응답 → 화면 옵션 번호(순수 매핑 — 테스트가 직접 고정한다).
//  카드는 라벨을 되돌려주므로 화면 옵션 번호로 역매핑한다. 라벨 없이 온 경우:
//  · deny → "No" 로 시작하는 옵션(TUI 의 거절과 동일). Esc 는 턴 전체 취소라 쓰지 않는다.
//  · allow → "Yes" 로 시작하는 옵션(잠금화면 [허용] 버튼 같은 라벨 없는 allow 대비).
//  못 짝지으면 null — 호출부가 전달 실패로 남긴다(카드 유지 = 재시도 가능).
function pickForOutcome(options, { decision, answers } = {}) {
  const list = Array.isArray(options) ? options : [];
  const a = Array.isArray(answers) ? answers.find((x) => x && Array.isArray(x.labels) && x.labels.length) : null;
  if (a) {
    const label = String(a.labels[0]);
    const hit = list.find((o) => o.label === label) || list.find((o) => o.label.startsWith(label.slice(0, 40)));
    if (hit) return hit.n;
  }
  if (!a && decision === 'deny') {
    const no = list.find((o) => /^No\b/i.test(o.label));
    if (no) return no.n;
  }
  if (!a && decision === 'allow') {
    const yes = list.find((o) => /^Yes\b/i.test(o.label));
    if (yes) return yes.n;
  }
  return null;
}

async function deliverPermission(cwdRel, tid, perm, outcome) {
  const cptServer = require('./cpt-server');
  const pick = pickForOutcome(perm.options, outcome || {});
  if (pick == null) {
    throw Object.assign(new Error('화면의 선택지와 응답을 짝지을 수 없습니다 — TUI 를 확인해 주세요'), { code: 'QUESTION_MISMATCH' });
  }
  // 추가 지시 텍스트 — 카드 입력창의 값(answers[].text). 고른 옵션이 입력을 받는 옵션일 때만
  //  싣는다(TUI 에서 불가능한 조합은 여기서도 만들지 않는다 — 텍스트는 버리고 선택만 전달).
  const a = Array.isArray(outcome && outcome.answers)
    ? outcome.answers.find((x) => x && typeof x.text === 'string' && x.text.trim()) : null;
  const chosen = perm.options.find((o) => o.n === pick);
  const text = a && chosen && optionAcceptsInput(perm.flow, chosen.label) ? a.text.trim() : null;
  await cptServer.permissionAnswer({ cwd: cwdRel, tid, pick, expect: perm.expect, text, flow: perm.flow });
}

// 폰/PC 카드의 응답 → 다이얼로그 조작. throw = 전달 실패(슬롯 유지, 카드가 남아 재시도).
async function deliver(cwdRel, tid, q, { decision, answers }) {
  const cptServer = require('./cpt-server');
  const expect = (q.questions[0] && (q.questions[0].question || q.questions[0].header)) || '';
  if (decision === 'deny') {
    await cptServer.chatAnswer({ cwd: cwdRel, tid, expect, cancel: true });
    return;
  }
  await cptServer.chatAnswer({ cwd: cwdRel, tid, expect, answers: toWire(q.questions, answers) });
}

// 카드 응답(라벨/자유입력) → chat.answer 와이어. **질문 전부**에 답이 있어야 한다.
function toWire(questions, answers) {
  const list = Array.isArray(answers) ? answers : [];
  return questions.map((qq, i) => {
    const a = list.find((x) => x && Number(x.questionIndex) === i);
    const optionCount = (qq.options || []).length;
    if (a && typeof a.text === 'string' && a.text.trim()) {
      return { optionIndexes: [], text: a.text, multiSelect: !!qq.multiSelect, optionCount };
    }
    const labels = a && Array.isArray(a.labels) ? a.labels : [];
    const idxs = labels
      .map((l) => (qq.options || []).findIndex((o) => o && o.label === l) + 1)
      .filter((n) => n >= 1);
    if (!idxs.length) {
      throw Object.assign(
        new Error('모든 질문에 답해야 전달할 수 있어요 — 이 질문은 터미널 다이얼로그라 건너뛸 수 없어요'),
        { code: 'INCOMPLETE_ANSWERS' },
      );
    }
    return { optionIndexes: idxs, multiSelect: !!qq.multiSelect, optionCount };
  });
}

function start() {
  if (timer) return;
  timer = setInterval(() => { poll().catch(() => { /* noop */ }); }, POLL_MS);
  // 부팅 직후 1회 — 데몬 재시작으로 회수된 배너를 주기만큼 기다리지 않고 되살린다.
  //  (claude 가 다이얼로그를 다시 그리는 데 1~2초 걸리므로 짧은 지연 후.)
  setTimeout(() => { poll().catch(() => { /* noop */ }); }, 3000);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  for (const t of pokeTimers) clearTimeout(t);
  pokeTimers = [];
}

/**
 * 즉시 화해 트리거 — "다이얼로그가 곧 뜬다/방금 사라졌다"를 아는 쪽(approvals.settle: 훅 사망·마감)이
 *  당긴다. 주기(POLL_MS)를 기다리지 않고 1.2s/3.5s 두 번 본다(TUI 가 다이얼로그를 그리는 지연 흡수).
 */
function pokeSoon() {
  if (!timer) return;                       // start 전/stop 후 — 리컨실러가 꺼져 있으면 무의미
  if (pokeTimers.length >= 4) return;       // 폭주 가드(연쇄 settle 시 중복 예약 방지)
  for (const ms of [1200, 3500]) {
    const t = setTimeout(() => {
      pokeTimers = pokeTimers.filter((x) => x !== t);
      poll().catch(() => { /* noop */ });
    }, ms);
    if (t.unref) t.unref();
    pokeTimers.push(t);
  }
}

module.exports = {
  start, stop, pokeSoon, _poll: poll, _toWire: toWire,
  _parsePermissionDialog: parsePermissionDialog, _pickForOutcome: pickForOutcome,
  _optionAcceptsInput: optionAcceptsInput,
};
