// agents-view.js — "이 PC 의 AI 에이전트" 목록·배선 토글·설치 시트. 설정 탭과 첫 실행 온보딩이 공유한다.
//
// 왜 별 모듈인가: 같은 목록을 두 자리(설정 / 온보딩)에서 보여줘야 하고, 등급 문구가 **정직성의
//  핵심**이라 한 곳에만 있어야 한다. 문구가 갈리면 한쪽에서 "연동됨"이라 읽은 사용자가 폰에서
//  오지 않는 승인 카드를 기다린다.
//
// 등급(데몬 agents.js 가 정본):
//   full    claude — 실행 인자 --settings 로 훅 7종 → 상태·원격 승인·알림·트랜스크립트
//   partial codex  — 실행 인자 -c notify 만 → 알림/턴 종료. **원격 승인 없음**
//   launch  그 외  — 실행·탭 로고까지. 배선 0 (사용자 개인 설정 파일을 우리가 쓰지 않기로 확정)
//
// 설치 시트의 3단계는 사용자 확정 설계(2026-07-27):
//   ① 권장 설치 명령 + 복사 + 공식 문서  ② **시트 안의 실제 터미널**에서 실행  ③ 재감지로 검증 → 배선
// ★ 성공 판정은 **명령의 종료 코드가 아니라 재감지 결과**다. "npm 은 성공했는데 PATH 에 없다"가
//   흔하고, 그때 "설치 완료!"라고 말하면 거짓말이 된다.
// ★ 설치 명령을 우리가 몰래 실행하지 않는다 — 사용자가 보는 터미널에서 돌아서 무엇이 실행되는지
//   드러나고 Ctrl+C 로 멈출 수 있다. 그리고 명령은 낡을 수 있으니 공식 문서 링크를 항상 함께 둔다.
import { api } from "./api.js";
import { icons, agentMarkHtml } from "./icons.js";
import { termTheme, monoFontStack, termMinContrast } from "./theme.js";

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

// 마지막으로 받은 목록 — 온보딩이 "물어볼 게 있나"를 판단할 때도 쓴다.
let cached = { agents: [], onboardedAt: null, at: 0 };

export function cachedAgents() { return cached; }

export async function loadAgents(refresh) {
  const r = await api.agentsLocal("agents.list", { refresh: !!refresh });
  cached = { agents: (r && r.agents) || [], onboardedAt: (r && r.onboardedAt) || null, at: Date.now() };
  return cached;
}

/**
 * 목록 렌더 — container 를 통째로 채우고 이벤트를 바인딩한다.
 * @param {HTMLElement} container
 * @param {{onChange?:Function, compact?:boolean}} opt
 */
export function renderAgentList(container, opt) {
  const o = opt || {};
  const items = cached.agents;
  if (!items.length) {
    container.innerHTML = `<div class="sett-hint">에이전트를 확인하는 중…</div>`;
    return;
  }
  const rows = items.map((a) => {
    const tier = TIER[a.tier] || { label: a.tier, desc: "" };
    const logo = agentMarkHtml(a.id, { size: 17 }) || icons.terminal({ size: 17 });
    // 상태 점: ● 연동 중 / ○ 설치됐지만 연동 꺼짐 / ◦ 미설치. 색은 등급이 아니라 **상태**를 나타낸다.
    const dot = a.installed
      ? (a.wired ? `<span class="ag-dot on" title="연동 중"></span>`
        : `<span class="ag-dot off" title="${a.wirable ? "연동 꺼짐" : "배선 없음"}"></span>`)
      : `<span class="ag-dot none" title="미설치"></span>`;
    const right = !a.installed
      ? `<button class="sett-btn ag-install" data-ag="${esc(a.id)}">설치</button>`
      : a.wirable
        ? `<input type="checkbox" class="tgl ag-wire" data-ag="${esc(a.id)}"${a.wired ? " checked" : ""} title="연동 켜기/끄기" />`
        : "";
    const meta = a.installed
      ? `${a.version ? esc(a.version) + " · " : ""}${esc(tier.label)}`
      : `미설치 · ${esc(tier.label)}`;
    return `
      <div class="ag-row${a.installed ? "" : " missing"}" data-ag-row="${esc(a.id)}">
        ${dot}
        <span class="ag-logo">${logo}</span>
        <span class="ag-main">
          <span class="ag-name">${esc(a.name)}</span>
          <span class="ag-meta">${meta}</span>
        </span>
        <span class="ag-right">${right}</span>
      </div>
      ${o.compact ? "" : `<div class="ag-desc">${esc(tier.desc)}</div>`}`;
  });
  container.innerHTML = rows.join("");

  container.querySelectorAll(".ag-wire").forEach((el) => {
    el.addEventListener("change", async () => {
      const id = el.getAttribute("data-ag");
      const on = el.checked;
      el.disabled = true;
      try {
        const r = await api.agentsLocal("agents.wire", { id, on });
        cached = { agents: (r && r.agents) || cached.agents, onboardedAt: (r && r.onboardedAt) || cached.onboardedAt, at: Date.now() };
        renderAgentList(container, o);
        o.onChange?.(cached);
      } catch (e) {
        el.checked = !on;                 // 실패했으면 UI 를 되돌린다(켠 척 금지)
        el.disabled = false;
        alertLine(container, String(e && e.message ? e.message : e));
      }
    });
  });
  container.querySelectorAll(".ag-install").forEach((el) => {
    el.addEventListener("click", () => openInstallSheet(el.getAttribute("data-ag"), () => {
      renderAgentList(container, o);
      o.onChange?.(cached);
    }));
  });
}

function alertLine(container, msg) {
  const d = document.createElement("div");
  d.className = "sett-hint";
  d.style.color = "var(--danger, #EF4444)";
  d.textContent = msg;
  container.appendChild(d);
}

// ── 설치 시트 ────────────────────────────────────────────────────────────────
// 시트 안의 터미널은 **홈 네임스페이스의 전용 세션 1개를 재사용**한다. 매번 새로 만들면 사용자에게
//  안 보이는 세션이 무한 누적되고(터미널 세션 --t- 는 리퍼 불가침이 원칙), 닫을 때 무조건 죽이면
//  진행 중인 설치를 잘라버린다. → 살아 있으면 재사용, 닫을 때 **셸만 남아 있으면** 정리한다.
let installTid = null;
let sheet = null;

export function openInstallSheet(agentId, onDone) {
  const a = cached.agents.find((x) => x.id === agentId);
  if (!a) return;
  closeSheet();
  const methods = a.install || [];
  let mi = 0;
  let term = null;
  let fit = null;
  let unlistenData = null;
  let unlistenExit = null;
  const paneId = "ag-install";

  const el = document.createElement("div");
  el.className = "ag-sheet";
  el.innerHTML = `
    <div class="ag-sheet-back"></div>
    <div class="ag-sheet-card" role="dialog" aria-modal="true">
      <div class="ag-sheet-head">
        <span class="ag-logo">${agentMarkHtml(a.id, { size: 18 }) || icons.terminal({ size: 18 })}</span>
        <span class="ag-sheet-title">${esc(a.name)} 설치</span>
        <button class="sm-close" id="agClose" title="닫기">${icons.x({ size: 18 })}</button>
      </div>
      <div class="ag-sheet-body">
        <div class="ag-step">
          <div class="ag-step-h"><span class="ag-step-n">1</span><span>설치 명령 확인</span></div>
          ${methods.length > 1 ? `<div class="scale-seg ag-methods">${methods.map((m, i) =>
            `<button class="scale-opt${i === 0 ? " active" : ""}" data-mi="${i}">${esc(m.label)}</button>`).join("")}</div>` : ""}
          <div class="ag-cmdrow">
            <code class="ag-cmd" id="agCmd">${esc(methods[0] ? methods[0].cmd : "")}</code>
            <button class="sett-btn" id="agCopy">복사</button>
          </div>
          <div class="ag-step-note">
            설치 방법은 바뀔 수 있어요 — 잘 안 되면 <a href="#" id="agDocs">공식 문서</a>를 확인하세요.
          </div>
        </div>
        <div class="ag-step">
          <div class="ag-step-h"><span class="ag-step-n">2</span><span>터미널에서 실행</span></div>
          <div class="ag-termwrap"><div class="ag-term" id="agTerm"></div></div>
          <div class="ag-actions">
            <button class="sett-btn primary" id="agRun">붙여넣고 실행</button>
            <span class="ag-step-note">이 터미널에서 직접 입력해도 돼요. 멈추려면 Ctrl+C.</span>
          </div>
        </div>
        <div class="ag-step">
          <div class="ag-step-h"><span class="ag-step-n">3</span><span>CodingPT 연동</span></div>
          <div class="ag-actions">
            <button class="sett-btn primary" id="agVerify">설치 확인하고 연동</button>
            <span class="ag-result" id="agResult"></span>
          </div>
          <div class="ag-step-note">설치가 끝나면 눌러 주세요. 실제로 실행 파일이 잡히는지 확인한 뒤 연동해요.</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  sheet = { el, dispose };

  const cmdEl = el.querySelector("#agCmd");
  const resultEl = el.querySelector("#agResult");
  const setMethod = (i) => {
    mi = i;
    cmdEl.textContent = (methods[i] && methods[i].cmd) || "";
    el.querySelectorAll(".ag-methods .scale-opt").forEach((b, k) => b.classList.toggle("active", k === i));
  };
  el.querySelectorAll(".ag-methods .scale-opt").forEach((b) =>
    b.addEventListener("click", () => setMethod(parseInt(b.getAttribute("data-mi"), 10) || 0)));
  el.querySelector("#agCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(cmdEl.textContent || ""); } catch (_) { /* 클립보드 거부 — 사용자가 직접 선택 */ }
    const b = el.querySelector("#agCopy");
    b.textContent = "복사됨";
    setTimeout(() => { b.textContent = "복사"; }, 1200);
  });
  el.querySelector("#agDocs").addEventListener("click", (ev) => {
    ev.preventDefault();
    if (a.docs) api.openExternal(a.docs).catch(() => {});
  });
  el.querySelector("#agClose").addEventListener("click", closeSheet);
  el.querySelector(".ag-sheet-back").addEventListener("click", closeSheet);

  // 터미널 붙이기 — 실패해도 시트는 살린다(사용자는 명령을 복사해 자기 터미널에서 쓸 수 있다).
  (async () => {
    const host = el.querySelector("#agTerm");
    if (!Terminal || !FitAddon) { host.textContent = "터미널을 열 수 없어요 — 명령을 복사해 직접 실행해 주세요."; return; }
    try {
      if (installTid == null) {
        const info = await api.newWindow("", paneId);
        installTid = info && (info.index != null ? info.index : info);
      }
      term = new Terminal({
        cursorBlink: true, fontSize: 12, fontFamily: monoFontStack(), scrollback: 4000,
        convertEol: false, theme: termTheme(), minimumContrastRatio: termMinContrast(), allowProposedApi: true,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      requestAnimationFrame(() => { try { fit.fit(); } catch (_) {} });
      term.onData((d) => api.ptyWrite(paneId, d).catch(() => {}));
      // pane.js 의 registry 를 타지 않으므로 Tauri 이벤트를 직접 듣는다(paneId 로 필터).
      unlistenData = await api.onPtyData((p) => {
        if (p.paneId !== paneId || !term) return;
        try { term.write(b64ToBytes(p.b64)); } catch (_) {}
      });
      unlistenExit = await api.onPtyExit((p) => {
        if (p.paneId !== paneId || !term) return;
        term.write("\r\n\x1b[2m[터미널이 종료됐어요]\x1b[0m\r\n");
      });
      const cols = term.cols || 80;
      const rows = term.rows || 12;
      const resolved = await api.ptyOpen(paneId, "", installTid, cols, rows);
      if (resolved != null && resolved !== installTid) installTid = resolved; // 스테일 tid → 데몬이 잡아준 것으로 승계
    } catch (e) {
      host.textContent = "터미널을 열 수 없어요: " + String(e && e.message ? e.message : e);
    }
  })();

  el.querySelector("#agRun").addEventListener("click", () => {
    const cmd = cmdEl.textContent || "";
    if (!cmd) return;
    // 붙여넣고 Enter — 사용자가 화면에서 그대로 보게 한다(숨은 실행 금지).
    api.ptyWrite(paneId, cmd + "\r").catch(() => {});
    term?.focus();
  });

  el.querySelector("#agVerify").addEventListener("click", async () => {
    const btn = el.querySelector("#agVerify");
    btn.disabled = true;
    resultEl.textContent = "확인 중…";
    resultEl.className = "ag-result";
    try {
      const r = await api.agentsLocal("agents.rescan", {});
      cached = { agents: (r && r.agents) || cached.agents, onboardedAt: (r && r.onboardedAt) || cached.onboardedAt, at: Date.now() };
      const now = cached.agents.find((x) => x.id === agentId);
      if (now && now.installed) {
        const t = TIER[now.tier] || {};
        resultEl.textContent = now.wired ? `✓ 연동 완료 — ${t.label}` : `✓ 설치 확인 — ${t.label}`;
        resultEl.className = "ag-result ok";
        onDone?.(cached);
      } else {
        // 여기서 "설치됐다"고 말하지 않는다 — 실제로 못 찾았다.
        resultEl.textContent = "아직 못 찾았어요. 설치가 끝났는데도 이러면 새 터미널에서 " + (a.bin) + " --version 을 확인해 주세요.";
        resultEl.className = "ag-result warn";
      }
    } catch (e) {
      resultEl.textContent = String(e && e.message ? e.message : e);
      resultEl.className = "ag-result warn";
    }
    btn.disabled = false;
  });

  document.addEventListener("keydown", onKey);
  function onKey(ev) { if (ev.key === "Escape") { ev.preventDefault(); closeSheet(); } }

  function dispose() {
    document.removeEventListener("keydown", onKey);
    try { unlistenData?.(); } catch (_) {}
    try { unlistenExit?.(); } catch (_) {}
    try { term?.dispose(); } catch (_) {}
    term = null;
    // 스트림만 닫는다. tmux 세션은 살려 둔다 — 진행 중인 설치를 자르지 않기 위해서다.
    //  (세션은 최대 1개고, 다음에 시트를 열면 재사용한다)
    api.ptyClose(paneId).catch(() => {});
    el.remove();
  }
}

// ── 첫 실행 온보딩 1스텝 ──────────────────────────────────────────────────────
// "이 PC 에서 찾은 에이전트" — 배선 가능한 것만 체크박스로 묻는다(권장 = 전부 체크).
//  [연동하기] 체크된 것만 on / 나머지 off. [나중에] 는 **전부 off 로 명시 기록**한다 —
//  "안 물어봄(기본 켜짐)" 상태로 남기면 아니라고 답한 사용자가 켜진 채로 쓰게 된다.
//  둘 다 markOnboarded 를 남겨 다시 묻지 않는다. 기존 사용자는 이 화면을 못 보는데, 그때는
//  "안 물어봄 = 켜짐" 기본값이 지금 동작(claude 배선됨)을 그대로 유지한다(호환).
export async function maybeShowOnboarding() {
  let c;
  try { c = await loadAgents(true); } catch (_) { return false; }   // 구 데몬 등 — 조용히 넘어간다
  if (c.onboardedAt) return false;
  const wirables = c.agents.filter((a) => a.wirable);
  if (!wirables.some((a) => a.installed)) {
    // 배선할 게 하나도 없으면 묻지 않는다(빈 질문). 다음에 설치하면 그때 설정에서 켜면 된다.
    try { await api.agentsLocal("agents.rescan", { markOnboarded: true }); } catch (_) { /* noop */ }
    return false;
  }
  const picked = new Set(wirables.filter((a) => a.installed).map((a) => a.id));
  const el = document.createElement("div");
  el.className = "ag-sheet";
  el.innerHTML = `
    <div class="ag-sheet-back"></div>
    <div class="ag-sheet-card" role="dialog" aria-modal="true">
      <div class="ag-sheet-head"><span class="ag-sheet-title">이 PC에서 찾은 AI 에이전트</span></div>
      <div class="ag-sheet-body">
        <div class="ag-step-note" style="margin:0 0 10px">
          연동하면 작업 완료 알림과 <b>휴대폰에서 승인</b>이 가능해져요. 에이전트를 실행할 때만 우리 설정이
          얹히고, 개인 설정 파일(~/.claude · ~/.codex)은 수정하지 않아요.
        </div>
        <div class="ag-list" id="agOnbList"></div>
        <div class="ag-actions" style="justify-content:flex-end">
          <button class="sett-btn" id="agLater">나중에</button>
          <button class="sett-btn primary" id="agGo">연동하기</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  const list = el.querySelector("#agOnbList");
  list.innerHTML = wirables.map((a) => {
    const tier = TIER[a.tier] || {};
    const logo = agentMarkHtml(a.id, { size: 17 }) || icons.terminal({ size: 17 });
    return `
      <div class="ag-row${a.installed ? "" : " missing"}">
        <input type="checkbox" class="tgl ag-onb" data-ag="${esc(a.id)}"${a.installed ? " checked" : ""}${a.installed ? "" : " disabled"} />
        <span class="ag-logo">${logo}</span>
        <span class="ag-main">
          <span class="ag-name">${esc(a.name)}</span>
          <span class="ag-meta">${a.installed ? `${a.version ? esc(a.version) + " · " : ""}${esc(tier.label || "")}` : "미설치 — 설정에서 설치할 수 있어요"}</span>
        </span>
      </div>`;
  }).join("");
  list.querySelectorAll(".ag-onb").forEach((cb) => cb.addEventListener("change", () => {
    const id = cb.getAttribute("data-ag");
    cb.checked ? picked.add(id) : picked.delete(id);
  }));

  return new Promise((resolve) => {
    const finish = async (accept) => {
      el.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      for (const a of wirables) {
        const on = accept && picked.has(a.id);
        if (!a.installed && !on) continue;         // 미설치는 기록할 것이 없다
        try { await api.agentsLocal("agents.wire", { id: a.id, on }); } catch (_) { /* 개별 실패는 넘어간다 */ }
      }
      try { await api.agentsLocal("agents.rescan", { markOnboarded: true }); } catch (_) { /* noop */ }
      try { await loadAgents(true); } catch (_) { /* noop */ }
      el.remove();
      resolve(true);
    };
    el.querySelector("#agGo").addEventListener("click", () => finish(true));
    el.querySelector("#agLater").addEventListener("click", () => finish(false));
  });
}

export function closeSheet() {
  const s = sheet;
  sheet = null;
  s?.dispose();
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
