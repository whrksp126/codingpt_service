// agents-view.js — "이 PC 의 AI 에이전트" 목록 · 연동 토글 · **행 아래 인라인 설치 패널**.
//  설정 탭과 첫 실행 온보딩이 공유한다.
//
// 사용자 확정(2026-07-27 저녁, 2차):
//  · 좌측 상태 점 **제거** — 토글/[설치] 버튼이 이미 상태를 말한다(점은 중복 신호였다).
//  · 에이전트별 상세 설명문 **제거** — 등급은 메타 줄의 라벨(`완전 연동`/`알림 연동`/`실행 전용`)로만.
//    ⚠ 라벨은 남긴다. 이게 "codex 는 원격 승인이 안 된다" 를 전하는 **유일한 채널**이 됐다.
//  · 하단 요약/설명 문단 **제거**.
//  · 설치는 **모달 위 모달을 만들지 않는다** → 그 행 아래에서 펼친다.
//  · 설치 명령은 탭 전환이 아니라 **위에서 아래로 전부** 보여준다.
//  · 이 영역에 포인트 컬러(accent)를 쓰지 않는다 — 버튼은 중립, 링크는 밑줄.
//
// 등급(데몬 agents.js 가 정본):
//   full    claude — 실행 인자 --settings 로 훅 7종 → 상태·원격 승인·알림·트랜스크립트
//   partial codex  — 실행 인자 -c notify 만 → 알림/턴 종료. **원격 승인 없음**
//   launch  그 외  — 실행·탭 로고까지. 배선 0 (사용자 개인 설정 파일을 우리가 쓰지 않기로 확정)
//
// 설치 절차의 정직성 규율:
//  ★ 성공 판정은 **명령의 종료 코드가 아니라 재감지 결과**다("npm 은 성공했는데 PATH 에 없다"가 흔하다).
//  ★ 설치 명령을 몰래 실행하지 않는다 — 사용자가 보는 터미널에서 돌고 Ctrl+C 로 멈출 수 있다.
//  ★ 명령은 낡을 수 있으니 공식 문서 링크를 항상 함께 둔다.
import { api } from "./api.js";
import { icons, agentMarkHtml } from "./icons.js";
import { termTheme, monoFontStack, termMinContrast } from "./theme.js";
import { state } from "./state.js";
import * as S from "./state.js";

const Terminal = window.Terminal;
const FitAddon = window.FitAddon && window.FitAddon.FitAddon;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export const TIER = {
  full: { label: "완전 연동", desc: "상태 감지 · 원격 승인 · 알림까지 연동돼요" },
  partial: { label: "알림 연동", desc: "작업 완료 알림이 와요. 원격 승인은 지원하지 않아요" },
  launch: { label: "실행 전용", desc: "실행과 탭 표시까지만. 알림 · 원격 승인은 안 돼요" },
};

let cached = { agents: [], onboardedAt: null, at: 0 };

export function cachedAgents() { return cached; }

export async function loadAgents(refresh) {
  const r = await api.agentsLocal("agents.list", { refresh: !!refresh });
  cached = { agents: (r && r.agents) || [], onboardedAt: (r && r.onboardedAt) || null, at: Date.now() };
  return cached;
}

// 지금 펼쳐 둔 설치 패널의 에이전트 id — 목록을 다시 그려도 펼침이 유지돼야 한다(설치 중 리렌더).
let openPanelId = null;

/**
 * 목록 렌더 — container 를 통째로 채우고 이벤트를 바인딩한다.
 * @param {HTMLElement} container
 * @param {{onChange?:Function}} opt
 */
export function renderAgentList(container, opt) {
  const o = opt || {};
  const items = cached.agents;
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = `<div class="sett-hint">에이전트를 확인하는 중…</div>`;
    return;
  }
  for (const a of items) {
    const tier = TIER[a.tier] || { label: a.tier };
    const wrap = document.createElement("div");
    wrap.className = "ag-item";
    const row = document.createElement("div");
    row.className = "ag-row" + (a.installed ? "" : " missing");
    row.innerHTML = `
      <span class="ag-logo">${agentMarkHtml(a.id, { size: 17 }) || icons.terminal({ size: 17 })}</span>
      <span class="ag-main">
        <span class="ag-name">${esc(a.name)}</span>
        <span class="ag-meta">${a.installed
          ? `${a.version ? esc(a.version) + " · " : ""}${esc(tier.label)}`
          : `미설치 · ${esc(tier.label)}`}</span>
      </span>
      <span class="ag-right"></span>`;
    const right = row.querySelector(".ag-right");
    if (!a.installed) {
      const b = document.createElement("button");
      b.className = "sett-btn";
      b.textContent = openPanelId === a.id ? "닫기" : "설치";
      b.addEventListener("click", () => {
        openPanelId = openPanelId === a.id ? null : a.id;
        renderAgentList(container, o);
      });
      right.appendChild(b);
    } else if (a.wirable) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "tgl";
      cb.checked = !!a.wired;
      cb.title = "연동 켜기/끄기";
      cb.addEventListener("change", async () => {
        const on = cb.checked;
        cb.disabled = true;
        try {
          const r = await api.agentsLocal("agents.wire", { id: a.id, on });
          cached = { agents: (r && r.agents) || cached.agents, onboardedAt: (r && r.onboardedAt) || cached.onboardedAt, at: Date.now() };
          renderAgentList(container, o);
          o.onChange?.(cached);
        } catch (e) {
          cb.checked = !on;               // 실패했으면 UI 를 되돌린다(켠 척 금지)
          cb.disabled = false;
          const d = document.createElement("div");
          d.className = "ag-err";
          d.textContent = String(e && e.message ? e.message : e);
          wrap.appendChild(d);
        }
      });
      right.appendChild(cb);
    }
    wrap.appendChild(row);
    if (openPanelId === a.id) {
      wrap.appendChild(buildInstallPanel(a, () => {
        openPanelId = null;
        renderAgentList(container, o);
        o.onChange?.(cached);
      }));
    }
    container.appendChild(wrap);
  }
}

// ── 인라인 설치 패널 ─────────────────────────────────────────────────────────
// 모달 위 모달을 만들지 않는다(사용자 확정) → 그 행 아래에서 펼친다. 터미널은 **홈 네임스페이스의
//  전용 세션 1개를 재사용**한다: 매번 새로 만들면 사용자에게 안 보이는 세션이 누적되고(터미널 세션
//  `--t-` 는 리퍼 불가침), 닫을 때 무조건 죽이면 진행 중인 설치를 자른다.
let installTid = null;
let panelTerm = null;      // 현재 살아 있는 xterm(패널이 닫히면 dispose)
let panelUnlisten = [];
const PANEL_PANE_ID = "ag-install";

function disposePanelTerm() {
  for (const u of panelUnlisten) { try { u(); } catch (_) { /* noop */ } }
  panelUnlisten = [];
  try { panelTerm?.dispose(); } catch (_) { /* noop */ }
  panelTerm = null;
  // 스트림만 닫는다. tmux 세션은 살려 둔다(진행 중 설치를 자르지 않는다 — 다음에 재사용).
  api.ptyClose(PANEL_PANE_ID).catch(() => {});
}

function buildInstallPanel(a, onDone) {
  disposePanelTerm();      // 다른 에이전트 패널이 열려 있었다면 정리
  const methods = a.install || [];
  const el = document.createElement("div");
  el.className = "ag-panel";
  el.innerHTML = `
    <div class="ag-panel-step">
      <div class="ag-panel-h">1. 설치 명령</div>
      <div class="ag-cmds">${methods.map((m, i) => `
        <div class="ag-cmdrow">
          <span class="ag-cmd-label">${esc(m.label)}</span>
          <code class="ag-cmd" data-ci="${i}">${esc(m.cmd)}</code>
          <button class="sett-btn ag-copy" data-ci="${i}">복사</button>
        </div>`).join("")}</div>
      <div class="ag-note">설치 방법은 바뀔 수 있어요 — 잘 안 되면 <a href="#" class="ag-docs">공식 문서</a>를 확인하세요.</div>
    </div>
    <div class="ag-panel-step">
      <div class="ag-panel-h ag-panel-h--act">
        <span>2. 터미널에서 실행</span>
        <button class="sett-btn ag-run">첫 번째 명령 실행</button>
      </div>
      <div class="ag-termwrap"><div class="ag-term"></div></div>
    </div>
    <div class="ag-panel-step">
      <div class="ag-panel-h ag-panel-h--act">
        <span>3. CodingPT 연동</span>
        <span class="ag-result"></span>
        <button class="sett-btn ag-verify">설치 확인하고 연동</button>
      </div>
    </div>`;

  el.querySelectorAll(".ag-copy").forEach((b) => b.addEventListener("click", async () => {
    const i = parseInt(b.getAttribute("data-ci"), 10) || 0;
    try { await navigator.clipboard.writeText(methods[i]?.cmd || ""); } catch (_) { /* 거부됨 — 직접 선택 */ }
    b.textContent = "복사됨";
    setTimeout(() => { b.textContent = "복사"; }, 1200);
  }));
  el.querySelector(".ag-docs").addEventListener("click", (ev) => {
    ev.preventDefault();
    if (a.docs) api.openExternal(a.docs).catch(() => {});
  });

  // 터미널 — 실패해도 패널은 살린다(명령을 복사해 자기 터미널에서 쓸 수 있다).
  const host = el.querySelector(".ag-term");
  (async () => {
    if (!Terminal || !FitAddon) { host.textContent = "터미널을 열 수 없어요 — 명령을 복사해 직접 실행해 주세요."; return; }
    try {
      if (installTid == null) {
        const info = await api.newWindow("", PANEL_PANE_ID);
        installTid = info && (info.index != null ? info.index : info);
      }
      const term = new Terminal({
        cursorBlink: true, fontSize: 12, fontFamily: monoFontStack(), scrollback: 4000,
        convertEol: false, theme: termTheme(), minimumContrastRatio: termMinContrast(), allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      // GPU 렌더러 — pane.js `_loadRenderer` 와 같은 이유(DOM 렌더러 마지막 열 잘림).
      try {
        const gl = new window.WebglAddon.WebglAddon();
        gl.onContextLoss(() => { try { gl.dispose(); } catch (_) {} });
        term.loadAddon(gl);
      } catch (_) {
        try { term.loadAddon(new window.CanvasAddon.CanvasAddon()); } catch (_) { /* dom 유지 */ }
      }
      panelTerm = term;
      requestAnimationFrame(() => { try { fit.fit(); } catch (_) { /* noop */ } });
      term.onData((d) => api.ptyWrite(PANEL_PANE_ID, d).catch(() => {}));
      // pane.js 의 registry 를 타지 않으므로 Tauri 이벤트를 직접 듣는다(paneId 로 필터).
      panelUnlisten.push(await api.onPtyData((p) => {
        if (p.paneId !== PANEL_PANE_ID || panelTerm !== term) return;
        try { term.write(b64ToBytes(p.b64)); } catch (_) { /* noop */ }
      }));
      panelUnlisten.push(await api.onPtyExit((p) => {
        if (p.paneId !== PANEL_PANE_ID || panelTerm !== term) return;
        term.write("\r\n\x1b[2m[터미널이 종료됐어요]\x1b[0m\r\n");
      }));
      const resolved = await api.ptyOpen(PANEL_PANE_ID, "", installTid, term.cols || 80, term.rows || 12);
      if (resolved != null && resolved !== installTid) installTid = resolved; // 스테일 tid → 데몬이 잡아준 것 승계
    } catch (e) {
      host.textContent = "터미널을 열 수 없어요: " + String(e && e.message ? e.message : e);
    }
  })();

  el.querySelector(".ag-run").addEventListener("click", () => {
    const cmd = methods[0]?.cmd || "";
    if (!cmd) return;
    api.ptyWrite(PANEL_PANE_ID, cmd + "\r").catch(() => {});
    panelTerm?.focus();
  });

  const resultEl = el.querySelector(".ag-result");
  el.querySelector(".ag-verify").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    resultEl.textContent = "확인 중…";
    resultEl.className = "ag-result";
    try {
      const r = await api.agentsLocal("agents.rescan", {});
      cached = { agents: (r && r.agents) || cached.agents, onboardedAt: (r && r.onboardedAt) || cached.onboardedAt, at: Date.now() };
      const now = cached.agents.find((x) => x.id === a.id);
      if (now && now.installed) {
        disposePanelTerm();
        onDone?.();          // 패널 접고 목록 갱신 — 행이 토글/버전으로 바뀐 것이 결과 표시다
      } else {
        // 여기서 "설치됐다" 고 말하지 않는다 — 실제로 못 찾았다.
        resultEl.textContent = `아직 못 찾았어요. 설치가 끝났는데도 이러면 새 터미널에서 ${a.bin} --version 을 확인해 주세요.`;
        resultEl.className = "ag-result warn";
        btn.disabled = false;
      }
    } catch (e) {
      resultEl.textContent = String(e && e.message ? e.message : e);
      resultEl.className = "ag-result warn";
      btn.disabled = false;
    }
  });
  return el;
}

/** 설정 화면을 닫을 때 호출 — 살아 있는 xterm/스트림 정리. */
export function closeAgentPanels() {
  openPanelId = null;
  disposePanelTerm();
}

// ── 첫 실행 온보딩 1스텝 ──────────────────────────────────────────────────────
// "이 PC 에서 찾은 에이전트" — 배선 가능한 것만 묻는다(권장 = 설치된 것 전부 체크).
//  [연동하기] 체크된 것만 on / 나머지 off. **[나중에] 는 전부 off 로 명시 기록**한다 —
//  "안 물어봄(기본 켜짐)" 으로 남기면 아니라고 답한 사용자가 켜진 채로 쓴다.
//  둘 다 markOnboarded 를 남겨 다시 묻지 않는다. 기존 사용자는 이 화면을 못 보는데, 그때는
//  "안 물어봄 = 켜짐" 기본값이 지금 동작(claude 배선됨)을 그대로 유지한다(호환).
// 온보딩 노출은 **계정별 1회**다(2026-07-28 실사고: 회원탈퇴 → 같은 이메일 재가입 = 새 user id 인데
//  데몬의 onboardedAt 이 머신 영속(agents.json — 배선 **설정**은 계정 전환에도 유지가 맞다)이라
//  새 계정에게 온보딩이 영영 안 떴다). 노출 여부는 이 로컬 계정 키가 정본이고, 데몬 markOnboarded 는
//  머신 기록으로 계속 남긴다(설정 유지와 노출 판정은 서로 다른 스코프다).
const onbKey = () => (state.me && state.me.id != null ? `cpt.agentsOnboarded.${state.me.id}` : null);
function markOnboardedLocal() { const k = onbKey(); if (k) { try { localStorage.setItem(k, "1"); } catch (_) {} } }

export async function maybeShowOnboarding() {
  // 계정을 아직 모르면 판정하지 않는다(부팅 직후 loadMe 전) — 한 번 로드해 보고 없으면 보류.
  if (!state.me) { try { await S.loadMe(); } catch (_) {} }
  const k = onbKey();
  if (!k) return false;
  try { if (localStorage.getItem(k) === "1") return false; } catch (_) {}
  let c;
  try { c = await loadAgents(true); } catch (_) { return false; }   // 구 데몬 등 — 조용히 넘어간다
  const wirables = c.agents.filter((a) => a.wirable);
  if (!wirables.some((a) => a.installed)) {
    // 배선할 게 하나도 없으면 묻지 않는다(빈 질문). 이 계정도 본 것으로 기록한다.
    markOnboardedLocal();
    try { await api.agentsLocal("agents.rescan", { markOnboarded: true }); } catch (_) { /* noop */ }
    return false;
  }
  // ★ 2026-07-28 3차 개정(사용자 확정): 토글 목록 + 하단 [연동하기]는 "토글이 즉시 되는 건가?"라는
  //  혼란을 만들었다(선택과 적용이 분리된 걸 화면이 말하지 않았다) → 권한 위저드와 **같은 문법**으로
  //  통일: 슬라이드 하나에 에이전트 하나, 하단 큰 [연동하기] 단일 CTA(누르면 그 자리에서 즉시 배선),
  //  '연동하지 않기'는 작은 링크. 미설치 에이전트는 온보딩에 아예 안 나온다(설치는 설정의 몫 —
  //  "미설치 행 + 비활성 토글"은 처음 온 사용자에게 노이즈다).
  const queue = wirables.filter((a) => a.installed);
  const el = document.createElement("div");
  el.className = "ag-sheet";
  document.body.appendChild(el);

  return new Promise((resolve) => {
    let idx = 0;
    const finishAll = async () => {
      markOnboardedLocal(); // 이 계정은 봤다 — '연동하지 않기'도 결정이다(계정마다 1회만 묻는다)
      try { await api.agentsLocal("agents.rescan", { markOnboarded: true }); } catch (_) { /* noop */ }
      try { await loadAgents(true); } catch (_) { /* noop */ }
      el.remove();
      resolve(true);
    };
    const renderSlide = () => {
      if (idx >= queue.length) { void finishAll(); return; }
      const a = queue[idx];
      const tier = TIER[a.tier] || {};
      const dots = queue.length > 1
        ? `<div class="ag-onb-dots">${queue.map((_, i) => `<span class="lg-dot${i === idx ? " on" : i < idx ? " done" : ""}"></span>`).join("")}</div>`
        : "";
      el.innerHTML = `
        <div class="ag-sheet-back"></div>
        <div class="ag-sheet-card ag-onb-card" role="dialog" aria-modal="true">
          <div class="ag-onb-slide">
            ${dots}
            <div class="ag-onb-ic">${agentMarkHtml(a.id, { size: 30 }) || icons.terminal({ size: 30 })}</div>
            <div class="ag-onb-title">${esc(a.name)}를 찾았어요</div>
            <div class="ag-onb-meta">${a.version ? esc(a.version) + " · " : ""}${esc(tier.label || "")}</div>
            <div class="ag-onb-benefit">${a.tier === "full"
              ? "연동하면 작업 완료 알림이 오고, <b>휴대폰에서 승인</b>할 수 있어요"
              : "연동하면 작업 완료 알림이 와요"}</div>
            <div class="ag-onb-hint">실행할 때만 설정이 얹히고, 개인 설정 파일(~/.claude · ~/.codex)은 수정하지 않아요</div>
            <button class="btn primary lg ag-onb-go" data-ag="${esc(a.id)}">연동하기</button>
            <button class="lg-link ag-onb-skip">연동하지 않기</button>
          </div>
        </div>`;
      const go = el.querySelector(".ag-onb-go");
      const skip = el.querySelector(".ag-onb-skip");
      // [연동하기] = 그 자리에서 **즉시** 배선한다(선택→나중에 일괄 적용 모델 폐기 — 버튼이 곧 행동이다).
      go.addEventListener("click", async () => {
        go.disabled = true;
        skip.disabled = true;
        go.textContent = "연동하는 중…";
        try { await api.agentsLocal("agents.wire", { id: a.id, on: true }); } catch (_) { /* 실패해도 다음으로 — 설정에서 재시도 */ }
        go.textContent = "연동됐어요 ✓";
        setTimeout(() => { idx += 1; renderSlide(); }, 450);
      });
      skip.addEventListener("click", async () => {
        go.disabled = true;
        skip.disabled = true;
        try { await api.agentsLocal("agents.wire", { id: a.id, on: false }); } catch (_) { /* noop */ }
        idx += 1;
        renderSlide();
      });
    };
    renderSlide();
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
