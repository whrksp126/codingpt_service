// question-revive — TUI 로 폴백된 미응답 AskUserQuestion 의 **알림 되살리기** 리컨실러.
//
// 문제(2026-07-28 사용자 확정): 데몬 재시작(PC 앱 업데이트)이 대기 승인을 전부 취소하면 폰 배너까지
//  회수된다. 질문은 TUI 다이얼로그로 살아 있는데, 폰에는 아무 알림도 남지 않는다 — "답 안 한 질문이
//  있으면 폰 알림도 정확히 1개 남아 있다" 가 목표 상태다.
//
// 동작(20s 틱):
//  ① 훅 바인딩이 있는 claude 터미널을 순회한다(바인딩 = 그 터미널에서 claude 훅이 돌았다는 증거).
//  ② 화면에 질문 다이얼로그("Enter to select")가 실제로 떠 있는지 본다 — **화면이 정본**이다.
//     트랜스크립트만 보면 "세션이 죽어 영영 미응답인 질문" 에도 카드를 세우게 된다.
//  ③ 떠 있고 + 이 pane 에 대기 승인이 하나도 없으면 → 트랜스크립트에서 질문 payload 를 읽어
//     approvals.requestTui 로 재광고한다(배너/카드/잠금화면 버튼이 기존 배관 그대로 부활).
//  ④ 다이얼로그가 사라졌으면(로컬에서 답함/Esc/세션 종료) 재광고 슬롯을 회수한다 — 배너도 걷힌다.
//
// 응답 전달(= requestTui 의 drive):
//  · answer → cpt-server.chatAnswer(다이얼로그 키 조작). 질문 전부에 답이 있어야 한다 —
//    다이얼로그는 질문을 순서대로 지나가므로 건너뛰기가 없다. 부족하면 INCOMPLETE_ANSWERS 로
//    거절해 폰 카드가 남는다(부분 답을 조용히 버리는 것보다 낫다).
//  · deny(전부 건너뜀) → Esc(다이얼로그 자체 취소) — claude 가 declined 를 기록한다.
//
// 멱등/폭주 안전: requestTui 의 id 는 (cwd|tid|toolUseId) 해시라 틱이 겹쳐도 1건이고,
//  back advertise 도 id 멱등이다. 순회 대상은 바인딩 수(작다)이며 capture-pane 은 로컬 tmux 조회다.
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
    const dialogUp = !!screen && /Enter to select/.test(screen);
    const slot = approvals.tuiSlotFor(cwdRel, tid);

    if (!dialogUp) {
      if (slot) { approvals.cancelTui(slot.id, 'dialog_gone'); log(`회수 ${slot.id} (다이얼로그 소멸) ws=${cwdRel || '-'} tid=${tid}`); }
      continue;
    }
    if (slot) continue;                          // 이미 재광고됨(멱등)
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

module.exports = { start, stop, _poll: poll, _toWire: toWire };
