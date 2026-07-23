// design-pick.js — Design Mode: 프리뷰에서 요소 선택 → 소스 위치 + 크롭 스크린샷을 터미널에 [디자인] 줄로 첨부.
//  · 픽커(window.__cptPick)는 preview_eval 로 페이지에 주입(멱등) — 1회성 선택 모드(선택/ESC 후 자동 해제).
//  · PC 는 페이지→앱 역방향 이벤트 채널이 없어 선택 결과는 500ms 폴링(take() 소진)으로 회수한다.
//    폴링은 모드 중에만 — 선택/취소/내비게이션(픽커 소실=off 응답)으로 즉시 종료.
//  · 크롭은 페이지 안 canvas 로 수행(새 의존성 금지). evaluateJavaScript 는 Promise 를 기다리지
//    않으므로 crop() 은 시작만 하고 takeCrop() 폴링으로 결과(b64)를 회수한다.
//  · 저장 = Rust fs_write_b64(홈 jail, ~/.codingpt/attachments/design-*.jpg) → 절대경로 반환 →
//    포커스(없으면 첫) 터미널 pane 에 insertText. 터미널이 없으면 안내만 하고 파일은 저장 유지.
import { api } from "./api.js";
import { state, ensureRuntime } from "./state.js";
import * as T from "./tiling.js";
import { getPane, isTermTab } from "./pane.js";

// 페이지 주입 픽커 — 계약(round2 §2) 사양 그대로: 오버레이+hover 하이라이트+라벨 툴팁,
//  클릭=선택 확정(기본 동작·전파 차단), ESC=취소, 1회성. payload = { rect, selector, tag, cls, text, src? }.
const PICKER_JS = String.raw`(function(){
  if (window.__cptPick) return;
  var st = { on:false, result:null, crop:undefined, ov:null, hl:null, tip:null, el:null };
  var ACC = '#3b82f6';
  function esc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s); } catch (e) { return String(s); } }
  // CSS 선택자 — id > 문서 내 고유 클래스 > nth-child 경로(4단계 캡).
  function cssPath(el){
    var parts = [];
    var node = el;
    for (var d = 0; node && node.nodeType === 1 && node !== document.body && d < 4; d++){
      if (node.id){ parts.unshift('#' + esc(node.id)); return parts.join(' > '); }
      var seg = node.tagName.toLowerCase();
      var cls = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      var uniq = null;
      for (var i = 0; i < cls.length; i++){
        try { if (document.querySelectorAll('.' + esc(cls[i])).length === 1) { uniq = cls[i]; break; } } catch (e) {}
      }
      if (uniq){ parts.unshift(seg + '.' + esc(uniq)); return parts.join(' > '); }
      var p = node.parentElement;
      if (p){
        var idx = 1, sib = node;
        while ((sib = sib.previousElementSibling)) idx++;
        seg += ':nth-child(' + idx + ')';
      }
      parts.unshift(seg);
      node = p;
    }
    return parts.join(' > ');
  }
  // 소스 위치 — 요소에서 조상으로 올라가며 ① React fiber _debugSource(return 체인 8단계)
  //  ② Vue __vueParentComponent.type.__file ③ dataset.source("파일:줄"). 전부 없으면 null.
  function srcOf(el){
    var node = el, hop = 0;
    while (node && node.nodeType === 1 && hop < 15){
      for (var k in node){
        if (k.indexOf('__reactFiber$') === 0){
          var f = node[k], d = 0;
          while (f && d < 8){
            var s = f._debugSource;
            if (s && s.fileName) return { file: String(s.fileName), line: s.lineNumber || 0 };
            f = f.return; d++;
          }
          break;
        }
      }
      var vc = node.__vueParentComponent;
      if (vc && vc.type && vc.type.__file) return { file: String(vc.type.__file), line: 0 };
      var ds = node.dataset && node.dataset.source;
      if (ds){
        var m = /^(.*):(\d+)$/.exec(String(ds));
        return m ? { file: m[1], line: parseInt(m[2], 10) || 0 } : { file: String(ds), line: 0 };
      }
      node = node.parentElement; hop++;
    }
    return null;
  }
  function labelOf(el, src){
    var cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
    var s = el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
    if (s.length > 60) s = s.slice(0, 60) + '…';
    if (src && src.file) s += ' — ' + String(src.file).split('/').pop() + ':' + (src.line || 0);
    return s;
  }
  function mk(css){ var d = document.createElement('div'); d.style.cssText = css; return d; }
  function cleanup(){
    st.on = false; st.el = null;
    try { st.ov && st.ov.remove(); } catch (e) {}
    try { st.hl && st.hl.remove(); } catch (e) {}
    try { st.tip && st.tip.remove(); } catch (e) {}
    st.ov = st.hl = st.tip = null;
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e){
    if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); st.result = { cancelled: true }; cleanup(); }
  }
  // 오버레이가 포인터를 캡처하므로 대상 탐색 시에만 일시 pointer-events:none 토글 후 elementFromPoint.
  function under(x, y){
    if (!st.ov) return null;
    st.ov.style.pointerEvents = 'none';
    var el = document.elementFromPoint(x, y);
    st.ov.style.pointerEvents = 'auto';
    if (!el || el === st.hl || el === st.tip || el === document.documentElement) return null;
    return el;
  }
  function positionTip(e){
    var tw = st.tip.offsetWidth || 0;
    st.tip.style.left = Math.max(4, Math.min(e.clientX + 12, (window.innerWidth || 0) - tw - 8)) + 'px';
    st.tip.style.top = Math.min(e.clientY + 16, (window.innerHeight || 0) - 34) + 'px';
  }
  function onMove(e){
    var el = under(e.clientX, e.clientY);
    if (!el){ return; }
    if (el !== st.el){
      st.el = el;
      var r = el.getBoundingClientRect();
      st.hl.style.display = 'block';
      st.hl.style.left = r.left + 'px'; st.hl.style.top = r.top + 'px';
      st.hl.style.width = r.width + 'px'; st.hl.style.height = r.height + 'px';
      st.tip.style.display = 'block';
      st.tip.textContent = labelOf(el, srcOf(el));
    }
    positionTip(e);
  }
  function onClick(e){
    e.preventDefault(); e.stopPropagation();
    var el = under(e.clientX, e.clientY);
    if (!el) return;
    var r = el.getBoundingClientRect();
    var payload = {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') || '').slice(0, 120),
      text: String(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    };
    var s = srcOf(el);
    if (s) payload.src = s;
    st.result = { picked: payload };
    cleanup();
  }
  function block(e){ e.preventDefault(); e.stopPropagation(); }
  window.__cptPick = {
    start: function(){
      if (st.on) return true;
      cleanup();
      st.on = true; st.result = null;
      st.ov = mk('position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:transparent;');
      st.hl = mk('position:fixed;z-index:2147483645;pointer-events:none;display:none;outline:2px solid ' + ACC + ';background:' + ACC + '22;');
      st.tip = mk('position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#1e293bee;color:#e2e8f0;font:12px/1.7 -apple-system,sans-serif;padding:2px 8px;border-radius:6px;');
      st.ov.addEventListener('mousemove', onMove, true);
      st.ov.addEventListener('click', onClick, true);
      st.ov.addEventListener('mousedown', block, true);
      st.ov.addEventListener('mouseup', block, true);
      document.addEventListener('keydown', onKey, true);
      document.documentElement.appendChild(st.ov);
      document.documentElement.appendChild(st.hl);
      document.documentElement.appendChild(st.tip);
      return true;
    },
    stop: function(){ if (st.on){ st.result = { cancelled: true }; cleanup(); } return true; },
    // 결과 소진 — picked/cancelled 는 1회 반환 후 클리어. 모드 중=pending, 아니면 off.
    take: function(){
      if (st.result){ var r = st.result; st.result = null; return r; }
      return st.on ? { pending: true } : { off: true };
    },
    // 크롭(비동기 시작) — img 로드 후 scale(이미지폭/뷰포트폭) 환산, rect×scale±pad(경계 클램프),
    //  canvas.toDataURL('image/jpeg', 0.9) → takeCrop 으로 회수.
    crop: function(dataURL, rect, scale, pad){
      st.crop = undefined;
      var img = new Image();
      img.onload = function(){
        try {
          var s = scale || (img.width / (window.innerWidth || 1)) || 1;
          var p = Math.round((pad == null ? 8 : pad) * s);
          var x = Math.max(0, Math.round(rect.x * s) - p);
          var y = Math.max(0, Math.round(rect.y * s) - p);
          var w = Math.max(1, Math.min(img.width - x, Math.round(rect.w * s) + p * 2));
          var h = Math.max(1, Math.min(img.height - y, Math.round(rect.h * s) + p * 2));
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
          st.crop = { b64: (c.toDataURL('image/jpeg', 0.9).split(',')[1] || '') };
        } catch (e) { st.crop = { error: String((e && e.message) || e) }; }
      };
      img.onerror = function(){ st.crop = { error: '이미지 로드 실패' }; };
      img.src = dataURL;
      return true;
    },
    takeCrop: function(){
      if (st.crop === undefined) return null;
      var c = st.crop; st.crop = undefined; return c;
    }
  };
})();`;

let _mode = null; // 진행 중 선택 모드(동시 1개) — { pvId, localPath, stopped, startedAt }
let _busy = false; // 선택 직후~삽입까지(중복 선택 방지)
const MODE_TIMEOUT_MS = 5 * 60 * 1000; // 방치 모드 자동 해제(폴링 eval 무한 지속 방지)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function toast(msg) {
  try { const wv = await import("./workspace-view.js"); wv.wvToast(msg); } catch (_) { /* noop */ }
}

export function isPicking() {
  return !!_mode || _busy;
}

// 선택 모드 시작(1회성) — 픽커 주입(멱등)+start 후 폴링. 이미 켜져 있으면 재시작.
export async function startDesignPick({ pvId, localPath }) {
  if (_busy) { toast("이전 선택을 처리하는 중이에요"); return false; }
  if (_mode) await cancelDesignPick();
  await api.previewEval(pvId, PICKER_JS);
  await api.previewEval(pvId, "JSON.stringify((function(){try{return !!window.__cptPick.start();}catch(e){return false;}})())");
  const mode = { pvId, localPath: localPath || "", stopped: false, startedAt: Date.now() };
  _mode = mode;
  _poll(mode); // 백그라운드 폴링(대기하지 않음 — 선택은 비동기)
  return true;
}

// 선택 모드 취소 — ui.previewInspect --off / 내비게이션 / 재시작 경로 공용. 멱등.
export async function cancelDesignPick() {
  const m = _mode;
  if (!m) return false;
  m.stopped = true;
  _mode = null;
  try {
    await api.previewEval(m.pvId, "JSON.stringify((function(){try{window.__cptPick&&window.__cptPick.stop();}catch(e){}return true;})())");
  } catch (_) { /* 픽커 소실(내비게이션/프리뷰 닫힘) — 무시 */ }
  return true;
}

// 500ms 폴링 — 모드 중에만. picked → 후처리, cancelled/off(픽커 소실 포함) → 조용히 종료.
async function _poll(mode) {
  for (;;) {
    if (mode.stopped) return;
    if (Date.now() - mode.startedAt > MODE_TIMEOUT_MS) { if (_mode === mode) cancelDesignPick(); return; }
    await sleep(500);
    if (mode.stopped) return;
    let r = null;
    try {
      const raw = await api.previewEval(mode.pvId, "JSON.stringify(window.__cptPick?window.__cptPick.take():{off:true})");
      r = JSON.parse(raw);
    } catch (_) { r = { off: true }; } // 프리뷰 닫힘/평가 실패 = 모드 종료
    if (mode.stopped) return;
    if (r && r.pending) continue;
    mode.stopped = true;
    if (_mode === mode) _mode = null;
    if (r && r.picked) {
      _busy = true;
      try { await _finish(mode, r.picked); }
      catch (e) { toast("요소 첨부 실패: " + ((e && e.message) || e)); }
      finally { _busy = false; }
    }
    return;
  }
}

// 선택 완료 → 뷰포트 스크린샷 → 페이지 canvas 크롭 → 저장 → 터미널 [디자인] 줄 삽입.
async function _finish(mode, payload) {
  toast("요소 캡처 중…");
  // 1) 뷰포트 스크린샷(기존 preview_screenshot 경로 — JPEG base64)
  const shot = await api.previewScreenshot(mode.pvId);
  // 2) 페이지 안 canvas 크롭 — crop 은 시작만(evaluateJavaScript 는 Promise 를 안 기다림), takeCrop 폴링 회수.
  await api.previewEval(mode.pvId, PICKER_JS); // 혹시 소실됐어도 멱등 재주입(crop 만 쓰면 충분)
  const cropJs =
    "JSON.stringify((function(){try{return !!window.__cptPick.crop(" +
    JSON.stringify("data:image/jpeg;base64," + shot) + "," + JSON.stringify(payload.rect) + ",0,8);}catch(e){return false;}})())";
  await api.previewEval(mode.pvId, cropJs);
  let b64 = "";
  const deadline = Date.now() + 10000;
  for (;;) {
    await sleep(200);
    const raw = await api.previewEval(mode.pvId, "JSON.stringify(window.__cptPick&&window.__cptPick.takeCrop?window.__cptPick.takeCrop():{error:'픽커 없음'})");
    let c = null;
    try { c = JSON.parse(raw); } catch (_) { /* null 등 */ }
    if (c) {
      if (c.error || !c.b64) throw new Error(c.error || "크롭 실패");
      b64 = c.b64;
      break;
    }
    if (Date.now() > deadline) throw new Error("크롭 시간 초과");
  }
  // 3) 저장 — ~/.codingpt/attachments/design-<yyyymmdd-hhmmss>-<rand4>.jpg (절대경로 회수)
  const rel = ".codingpt/attachments/design-" + tsName() + "-" + Math.random().toString(36).slice(2, 6) + ".jpg";
  const absPath = await api.fsWriteB64(rel, b64);
  // 4) 터미널 삽입 — 포커스 터미널 pane 우선, 없으면 첫 터미널 pane. 없으면 안내(파일은 저장 유지).
  const pane = findTermPane();
  if (!pane) { toast("터미널이 없어 파일만 저장했어요: " + absPath); return; }
  pane.insertText(designLine(mode.localPath, payload, absPath));
  pane.ctx?.onFocus?.(pane.id);
  pane.focus();
  toast("디자인 요소를 터미널에 첨부했어요");
}

function tsName() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// 소스 파일 경로 정규화 — 워크스페이스 루트(홈-상대 localPath) 세그먼트가 절대경로 안에 보이면
//  ws 상대로 절단, 아니면 원문 유지(홈 절대경로를 JS 가 모르므로 세그먼트 매칭으로 판별).
function normSrcFile(file, localPath) {
  const f = String(file || "");
  const lp = String(localPath || "").replace(/^\/+|\/+$/g, "");
  if (lp) {
    const i = f.indexOf("/" + lp + "/");
    if (i >= 0) return f.slice(i + lp.length + 2);
  }
  return f;
}

// 삽입 한 줄: `[디자인] ` + (src 있으면 `<file>:<line> `) + `<selector>` + (text 있으면 ` "<text 40자>"`) + ` '<absPath>' `
function designLine(localPath, payload, absPath) {
  let s = "[디자인] ";
  if (payload.src && payload.src.file) s += normSrcFile(payload.src.file, localPath) + ":" + (payload.src.line || 0) + " ";
  s += payload.selector || payload.tag || "";
  const t = String(payload.text || "").trim();
  if (t) s += ' "' + t.slice(0, 40).replace(/"/g, "'") + '"';
  s += " '" + String(absPath).replace(/'/g, "'\\''") + "' ";
  return s;
}

// 삽입 대상 터미널 pane — 포커스 pane 이 터미널이면 그것, 아니면 레이아웃 첫 터미널 pane(터미널 탭 보유).
function findTermPane() {
  const rt = state.activeWsId ? ensureRuntime(state.activeWsId) : null;
  if (!rt) return null;
  const ok = (l) => l && l.kind === "terminal" && (l.tabs || []).some(isTermTab);
  let hit = null;
  const focusLeaf = rt.focusId ? T.findLeaf(rt.layout, rt.focusId) : null;
  if (ok(focusLeaf)) hit = focusLeaf;
  if (!hit) T.eachLeaf(rt.layout, (l) => { if (!hit && ok(l)) hit = l; });
  return hit ? getPane(hit.id) : null;
}
