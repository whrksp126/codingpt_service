// external-keys.js — 설정 > 외부 연동. 다른 서비스가 이 PC 의 에이전트를 부를 때 쓰는 API 키를 만들고 폐기한다.
//  키는 만드는 PC 에 묶이고 원문은 만들 때 한 번만 보여 준다. 같은 PC 의 에이전트도 `cpt external` 로 관리한다.
import { api } from "./api.js";
import { icons } from "./icons.js";
import * as i18n from "./i18n/index.js";

const DOCS_URL = "https://codingpt-back.ghmate.com/api/v1/docs";
const t = (s) => i18n.t(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function load(list) {
  list.textContent = t("불러오는 중…");
  try {
    const r = await api.backApiAsync("GET", "/api/daemon/api-keys");
    const keys = (r && r.keys) || [];
    list.innerHTML = "";
    if (!keys.length) { list.textContent = t("아직 만든 키가 없어요."); return; }
    for (const k of keys) {
      const row = document.createElement("div");
      row.className = "sett-row";
      const scope = (k.allowedPaths || []).length ? k.allowedPaths.join(", ") : t("홈 폴더 전체");
      row.innerHTML = `<span class="sett-copy"><span class="sett-label">${esc(k.name)}</span>
        <span class="sett-desc">${esc(k.prefix)}… · ${esc(scope)}${k.allowBypass ? " · " + t("승인 없이 실행 허용") : ""}</span></span>
        <button class="sett-btn ext-revoke">${t("폐기")}</button>`;
      row.querySelector(".ext-revoke").onclick = async (e) => {
        const btn = e.currentTarget;
        if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = t("정말 폐기"); return; }
        btn.disabled = true;
        try { await api.backApiAsync("DELETE", `/api/daemon/api-keys/${k.id}`); } catch (err) { list.textContent = String(err); return; }
        load(list);
      };
      list.appendChild(row);
    }
  } catch (e) { list.textContent = String((e && e.message) || e); }
}

export function renderExternalKeys(host) {
  host.innerHTML = `
    <div class="sm-section-title">${t("외부 연동")}</div>
    <div class="sm-section-note">${t("다른 서비스가 API 키로 이 PC 의 에이전트를 부릅니다. 키를 가진 쪽은 이 PC 에서 명령을 실행할 수 있으니 서버 측에만 보관하세요.")}
      <a class="ext-docs" href="#">${t("연동 문서")}</a></div>
    <div class="sm-card2">
      <div class="sett-row"><span class="sett-copy"><span class="sett-label">${t("키 이름")}</span></span><input class="sm-search-input ext-input ext-name" maxlength="60" placeholder="${esc(t("예: 내 쇼핑몰"))}"></div>
      <div class="sett-row"><span class="sett-copy"><span class="sett-label">${t("허용 폴더")}</span><span class="sett-desc">${t("쉼표로 구분, 비우면 홈 폴더 전체")}</span></span><input class="sm-search-input ext-input ext-paths" placeholder="~/projects/my-app"></div>
      <label class="sett-row sett-row-action"><span class="sett-copy"><span class="sett-label">${t("승인 없이 실행 허용")}</span><span class="sett-desc">${t("위험: 끄면 파일 수정·명령 실행마다 호출한 서비스나 CodingPT 에서 승인해야 합니다")}</span></span><input type="checkbox" class="tgl ext-bypass" /></label>
      <div class="sett-row"><span></span><button class="sett-btn ext-create">${t("키 만들기")}</button></div>
    </div>
    <div class="ext-secret" hidden></div>
    <div class="sm-section-title">${t("만든 키")}</div>
    <div class="sm-card2"><div class="ext-key-list sett-col"></div></div>`;
  const list = host.querySelector(".ext-key-list");
  const secret = host.querySelector(".ext-secret");
  host.querySelector(".ext-docs").onclick = (e) => { e.preventDefault(); api.openExternal?.(DOCS_URL); };
  host.querySelector(".ext-create").onclick = async (e) => {
    const name = host.querySelector(".ext-name").value.trim();
    if (!name) { host.querySelector(".ext-name").focus(); return; }
    const allowedPaths = host.querySelector(".ext-paths").value.split(",").map((s) => s.trim()).filter(Boolean);
    const allowBypass = host.querySelector(".ext-bypass").checked;
    e.currentTarget.disabled = true;
    try {
      const r = await api.backApiAsync("POST", "/api/daemon/api-keys", { name, allowedPaths, allowBypass });
      secret.hidden = false;
      secret.innerHTML = `<div class="sm-section-note">${t("지금만 볼 수 있어요. 복사해 두세요.")}</div>
        <code class="ext-secret-value">${esc(r.secret)}</code> <button class="sett-btn ext-copy">${icons.copy ? icons.copy({ size: 13 }) : ""} ${t("복사")}</button>`;
      secret.querySelector(".ext-copy").onclick = () => navigator.clipboard.writeText(r.secret);
      host.querySelector(".ext-name").value = "";
      host.querySelector(".ext-paths").value = "";
      host.querySelector(".ext-bypass").checked = false;
      load(list);
    } catch (err) { list.textContent = String((err && err.message) || err); }
    host.querySelector(".ext-create").disabled = false;
  };
  load(list);
}
