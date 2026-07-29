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
const POLL_MS = 20 * 1000;

let timer = null;

function log(msg) { console.log(`[q-revive] ${msg}`); }

async function poll() {
  const transcript = require('./transcript');
  const approvals = require('./approvals');
  const ptyLib = require('./pty');
  if (approvals.gateReason && approvals.gateReason()) return; // 승인 기능이 꺼져 있으면 전부 무의미

  let binds = [];
  try { binds = transcript.listClaudeBinds(); } catch (_) { return; }
  for (const { cwdRel, tid } of binds) {
    let screen = null;
    try {
      const { session } = ptyLib.sessionForCwd(cwdRel);
      screen = await ptyLib.runTmux(['capture-pane', '-p', '-t', `=${ptyLib.termSession(session, tid)}:0`]);
    } catch (_) { screen = null; } // 터미널 없음(닫힘) — 아래 dialogUp=false 경로가 슬롯을 걷는다
    const questionUp = !!screen && /Enter to select/.test(screen);
    const perm = !questionUp && screen ? parsePermissionDialog(screen) : null;
    const slot = approvals.tuiSlotFor(cwdRel, tid);

    if (!questionUp && !perm) {
      if (slot) { approvals.cancelTui(slot.id, 'dialog_gone'); log(`회수 ${slot.id} (다이얼로그 소멸) ws=${cwdRel || '-'} tid=${tid}`); }
      continue;
    }

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
}

// ── 권한 다이얼로그 화면 파싱 ────────────────────────────────────────────────
// 실캡처(claude 2.1.220, 2026-07-29) 기준 구조:
//   ────────────────────────────────  ← 구분선
//    Bash command                     ← 제목(도구)
//    rm …/approval-demo.txt && git -C ← 명령(줄바꿈될 수 있음)
//    /Users/… status --short
//    Remove the demo file and …       ← 설명(회색 한 줄, 없을 수 있음)
//    This command requires approval   ← 있을 수도 없을 수도
//    Do you want to proceed?
//    ❯ 1. Yes
//      2. Yes, and don't ask again for: git -C … status --short
//      3. No
//    Esc to cancel · Tab to amend · ctrl+e to explain
//  ⚠ 화면엔 지난 대화의 다이얼로그 **잔상**이 남을 수 있다 → 질문 줄은 아래에서부터 찾는다(살아
//   있는 다이얼로그는 항상 화면 맨 아래 블록이다). 옵션 문구는 줄바꿈 연속행을 이어 붙인다.
function parsePermissionDialog(screen) {
  const lines = String(screen || '').split('\n');
  if (!lines.some((l) => /Esc to cancel/.test(l))) return null;
  let pi = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Do you want to .{0,160}\?\s*$/.test(lines[i])) { pi = i; break; }
  }
  if (pi < 0) return null;

  // 옵션 — "N. 라벨" 행 + 연속(줄바꿈)행. 푸터를 만나면 끝.
  const options = [];
  for (let i = pi + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/Esc to cancel/.test(l)) break;
    const m = /^\s*[❯›>]?\s*([1-9])\.\s+(.*\S)\s*$/.exec(l);
    if (m) { options.push({ n: parseInt(m[1], 10), label: m[2].trim() }); continue; }
    if (!l.trim()) { if (options.length) break; continue; }
    if (options.length) options[options.length - 1].label += ' ' + l.trim(); // 옵션 문구 줄바꿈
  }
  if (options.length < 2) return null;

  // 제목/본문 — 질문 줄 위로 구분선(───)까지 거슬러 올라간다.
  let top = pi;
  for (let i = pi - 1; i >= 0; i--) {
    if (/^\s*─{4,}\s*$/.test(lines[i])) break;
    top = i;
  }
  const block = lines.slice(top, pi).map((l) => l.trim())
    .filter((l) => l && !/^This command requires approval$/.test(l) && !/^─+$/.test(l));
  const title = block[0] || 'Permission';
  const body = block.slice(1).join(' ').replace(/\s+/g, ' ').trim();

  // 카드는 화면 문구 그대로 — 질문 1개(단일선택)로 모델링해 기존 선택지 카드/조작 배관을 재사용한다.
  const question = {
    question: body ? body.slice(0, 500) : (lines[pi] || '').trim(),
    header: title,
    multiSelect: false,
    options: options.map((o) => ({ label: o.label.slice(0, 200) })),
  };
  const key = 'perm|' + crypto.createHash('sha256')
    .update([title, question.question, ...options.map((o) => `${o.n}.${o.label}`)].join('|')).digest('hex').slice(0, 16);
  return { key, title, tool: toolOfDialogTitle(title), summary: body || title, question, options, expect: body || title };
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
  await cptServer.permissionAnswer({ cwd: cwdRel, tid, pick, expect: perm.expect });
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
  // 부팅 직후 1회 — 데몬 재시작으로 회수된 배너를 20초 기다리지 않고 되살린다.
  //  (단 claude 가 다이얼로그를 다시 그리는 데 몇 초 걸리므로 짧은 지연 후.)
  setTimeout(() => { poll().catch(() => { /* noop */ }); }, 8000);
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  start, stop, _poll: poll, _toWire: toWire,
  _parsePermissionDialog: parsePermissionDialog, _pickForOutcome: pickForOutcome,
};
