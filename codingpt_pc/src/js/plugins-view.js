// plugins-view — 설정 > 플러그인. 설치 목록 + 마켓플레이스에서 찾아 설치.
//
// 화면이 지켜야 하는 것 하나: **무엇을 허용하는지 보여 주기 전에는 설치 버튼이 없다.**
//  설치 = 남의 코드를 이 PC 에 놓는 일이다. 목록에서 바로 "설치"가 눌리면 사용자는 자기가
//  무엇에 동의했는지 모른 채 동의하게 된다 → 미리보기(허용 목록) → 설치, 두 단계로 나눈다.
//
// ⚠ 앱(codingpt_app/src/components/PluginSettings.tsx)에 같은 규율의 화면이 있다.
import { api } from "./api.js";
import { icons } from "./icons.js";
import * as i18n from "./i18n/index.js";

/** 처음 화면에 둘 추천 저장소 — "빈 상점"을 면하는 최소한의 안내. */
const SUGGESTED = [
  { name: "CodingPT 공식", url: "https://github.com/codingpt/plugins.git" },
];

const KIND_LABEL = {
  quickCommands: "저장한 명령",
  commands: "팔레트 명령",
  skills: "에이전트 스킬",
  languagePacks: "번역",
};

export function renderPlugins(root) {
  root.innerHTML = "";
  const el = document.createElement("div");
  el.className = "plug";
  root.appendChild(el);

  const state = { installed: null, caps: {}, market: null, marketUrl: "", busy: false, err: "", preview: null };

  const setErr = (e) => { state.err = e ? (e.message || String(e)) : ""; paint(); };

  async function load() {
    try {
      const r = await api.pluginsList();
      state.installed = (r && r.plugins) || [];
      state.caps = (r && r.capabilities) || {};
      state.err = "";
    } catch (e) { state.installed = []; setErr(e); return; }
    paint();
  }

  async function openMarketplace(url) {
    state.marketUrl = url;
    state.busy = true; paint();
    try {
      state.market = await api.pluginsMarketplace(url);
      state.err = "";
    } catch (e) { state.market = null; state.err = e.message || String(e); }
    state.busy = false; paint();
  }

  async function showPreview(url, ref, subdir) {
    state.busy = true; paint();
    try {
      state.preview = { ...(await api.pluginsPreview(url, ref, subdir)), url, ref, subdir };
      state.err = "";
    } catch (e) { state.preview = null; state.err = e.message || String(e); }
    state.busy = false; paint();
  }

  async function doInstall() {
    const pv = state.preview;
    if (!pv) return;
    state.busy = true; paint();
    try {
      // 동의 지문은 **미리보기가 준 것**을 그대로 보낸다 — 화면이 A 를 보여 주고 B 가 깔리는
      //  레이스를 데몬이 여기서 잡는다(리포가 그 사이 바뀌면 설치가 거부된다).
      await api.pluginsInstall(pv.url, pv.ref, pv.subdir, pv.consent);
      state.preview = null;
      await load();
    } catch (e) { state.err = e.message || String(e); }
    state.busy = false; paint();
  }

  function row(label, value) {
    const d = document.createElement("div");
    d.className = "plug-kv";
    d.innerHTML = `<span></span><b></b>`;
    d.querySelector("span").textContent = label;
    d.querySelector("b").textContent = value;
    return d;
  }

  function paint() {
    el.innerHTML = "";

    // ── 설치 전 동의 화면 ──
    if (state.preview) {
      const pv = state.preview;
      const box = document.createElement("div");
      box.className = "plug-consent";
      box.innerHTML = `
        <div class="plug-consent-h"></div>
        <div class="plug-consent-sub"></div>
        <div class="plug-consent-t">${i18n.t('이 플러그인이 하는 일')}</div>`;
      box.querySelector(".plug-consent-h").textContent = `${pv.manifest.name} ${pv.manifest.version}`;
      box.querySelector(".plug-consent-sub").textContent = pv.manifest.description || pv.manifest.key;
      const perms = document.createElement("ul");
      perms.className = "plug-perms";
      for (const p of pv.permissions) {
        const li = document.createElement("li");
        li.textContent = p.label || p.kind;
        perms.appendChild(li);
      }
      box.appendChild(perms);
      // 커밋을 보여 준다 — "지금 이 코드"를 설치한다는 사실이 화면에 있어야 한다.
      box.appendChild(row(i18n.t('가져올 커밋'), String(pv.commit || "").slice(0, 12)));
      box.appendChild(row(i18n.t('저장소'), pv.url));
      const btns = document.createElement("div");
      btns.className = "plug-btns";
      const cancel = document.createElement("button");
      cancel.className = "btn";
      cancel.textContent = i18n.t('취소');
      cancel.addEventListener("click", () => { state.preview = null; paint(); });
      const ok = document.createElement("button");
      ok.className = "btn primary";
      ok.textContent = state.busy ? i18n.t('설치 중…') : i18n.t('허용하고 설치');
      ok.disabled = state.busy;
      ok.addEventListener("click", doInstall);
      btns.append(cancel, ok);
      box.appendChild(btns);
      if (state.err) { const e = document.createElement("div"); e.className = "plug-err"; e.textContent = state.err; box.appendChild(e); }
      el.appendChild(box);
      return;
    }

    // ── 설치된 것 ──
    const h1 = document.createElement("div");
    h1.className = "sm-section-title";
    h1.textContent = i18n.t('설치된 플러그인');
    el.appendChild(h1);
    const card = document.createElement("div");
    card.className = "sm-card2";
    if (state.installed === null) {
      card.innerHTML = `<div class="plug-empty">${i18n.t('불러오는 중…')}</div>`;
    } else if (!state.installed.length) {
      card.innerHTML = `<div class="plug-empty">${i18n.t('아직 없어요. 아래에서 저장소를 열어 찾아보세요.')}</div>`;
    } else {
      for (const p of state.installed) {
        const r = document.createElement("div");
        r.className = "plug-row" + (p.enabled ? "" : " off");
        const kinds = p.contributes
          ? Object.keys(p.contributes).filter((k) => p.contributes[k].length)
            .map((k) => `${KIND_LABEL[k] || k} ${p.contributes[k].length}`).join(" · ")
          : i18n.t('폴더가 사라졌어요');
        r.innerHTML = `<div class="plug-row-t"><b></b><i></i></div>`;
        r.querySelector("b").textContent = `${p.name} ${p.version || ""}`.trim();
        r.querySelector("i").textContent = kinds;
        const sw = document.createElement("button");
        sw.className = "plug-sw" + (p.enabled ? " on" : "");
        sw.title = p.enabled ? i18n.t('끄기') : i18n.t('켜기');
        sw.textContent = p.enabled ? i18n.t('켜짐') : i18n.t('꺼짐');
        sw.addEventListener("click", async () => {
          try { await api.pluginsSetEnabled(p.key, !p.enabled); await load(); } catch (e) { setErr(e); }
        });
        const del = document.createElement("button");
        del.className = "plug-del";
        del.title = i18n.t('삭제');
        del.innerHTML = icons.trash({ size: 14 });
        del.addEventListener("click", async () => {
          // 확인 없이 지우지 않는다 — 되돌리려면 다시 받아야 한다. 창은 두 번 누르기로.
          if (del.dataset.armed !== "1") {
            del.dataset.armed = "1";
            del.textContent = i18n.t('한 번 더');
            setTimeout(() => { del.dataset.armed = ""; del.innerHTML = icons.trash({ size: 14 }); }, 3000);
            return;
          }
          try { await api.pluginsUninstall(p.key); await load(); } catch (e) { setErr(e); }
        });
        r.append(sw, del);
        card.appendChild(r);
      }
    }
    el.appendChild(card);

    // ── 마켓플레이스 ──
    const h2 = document.createElement("div");
    h2.className = "sm-section-title";
    h2.textContent = i18n.t('마켓플레이스');
    el.appendChild(h2);
    const card2 = document.createElement("div");
    card2.className = "sm-card2";
    const addRow = document.createElement("div");
    addRow.className = "plug-add";
    const input = document.createElement("input");
    input.className = "sett-input";
    input.placeholder = i18n.t('저장소 주소 (https://github.com/…/plugins.git)');
    input.value = state.marketUrl;
    const go = document.createElement("button");
    go.className = "btn";
    go.textContent = state.busy ? i18n.t('여는 중…') : i18n.t('열기');
    go.disabled = state.busy;
    go.addEventListener("click", () => openMarketplace(input.value.trim()));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    addRow.append(input, go);
    card2.appendChild(addRow);

    if (!state.market) {
      const s = document.createElement("div");
      s.className = "plug-sugg";
      s.innerHTML = `<span>${i18n.t('추천')}</span>`;
      for (const g of SUGGESTED) {
        const b = document.createElement("button");
        b.className = "plug-sugg-b";
        b.textContent = g.name;
        b.addEventListener("click", () => { input.value = g.url; openMarketplace(g.url); });
        s.appendChild(b);
      }
      card2.appendChild(s);
    } else {
      const title = document.createElement("div");
      title.className = "plug-mkt-h";
      title.textContent = state.market.name;
      card2.appendChild(title);
      const installedKeys = new Set((state.installed || []).map((p) => p.key));
      for (const item of state.market.plugins) {
        const r = document.createElement("div");
        r.className = "plug-row";
        r.innerHTML = `<div class="plug-row-t"><b></b><i></i></div>`;
        r.querySelector("b").textContent = item.id;
        r.querySelector("i").textContent = item.description || item.source.url;
        const b = document.createElement("button");
        b.className = "btn sm";
        if (installedKeys.has(item.id)) {
          b.textContent = i18n.t('설치됨');
          b.disabled = true;
        } else {
          b.textContent = i18n.t('보기');
          b.addEventListener("click", () => showPreview(item.source.url, item.source.ref, item.source.subdir));
        }
        r.appendChild(b);
        card2.appendChild(r);
      }
      if (!state.market.plugins.length) {
        const e = document.createElement("div");
        e.className = "plug-empty";
        e.textContent = i18n.t('이 저장소에는 아직 플러그인이 없어요.');
        card2.appendChild(e);
      }
    }
    el.appendChild(card2);

    const hint = document.createElement("div");
    hint.className = "sett-hint";
    hint.textContent = i18n.t('플러그인은 저장한 명령·팔레트 명령·에이전트 스킬·번역을 더할 수 있어요. 화면을 직접 그리지는 않아요.');
    el.appendChild(hint);

    if (state.err) {
      const e = document.createElement("div");
      e.className = "plug-err";
      e.textContent = state.err;
      el.appendChild(e);
    }
  }

  paint();
  load();
}
