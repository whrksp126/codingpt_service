// page-agent.js — 프리뷰 페이지에 주입되는 자동화 에이전트(window.__cptAgent).
//  · PC 는 preview_eval 이 반환값을 동기 회수하므로 postMessage 불필요 — 각 메서드는
//    JSON 직렬화 가능한 객체를 "동기 반환"한다.
//  · wait 만 예외: 단발 검사만 하고, 폴링(500ms 재-eval)은 호출측(ui-channel)이 담당한다.
//  · 멱등: window.__cptAgent 가 이미 있으면 skip(재주입 안전 — 매 호출 전 주입해도 무해).
//  · 호출측은 항상 JSON.stringify((function(){...})()) 로 감싸 문자열만 회수한다.
export const PAGE_AGENT_JS = String.raw`(function(){
  if (window.__cptAgent) return;
  var SEL = 'a,button,input,select,textarea,[role],[onclick],[contenteditable]';

  // 가시성 필터 — 렌더 박스가 있고 display/visibility/opacity 로 숨겨지지 않은 요소만.
  function visible(el){
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 사람이 읽는 이름: aria-label > placeholder > innerText(80자) > alt > title.
  function nameOf(el){
    var t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    if (!t) t = String(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!t) t = el.getAttribute('alt') || el.getAttribute('title') || '';
    return t;
  }

  // target 해석 — snapshot 이 부여한 ref('eN') 또는 CSS selector.
  function resolve(target){
    var el = null;
    var s = String(target || '');
    if (/^e\d+$/.test(s)) el = document.querySelector('[data-cpt-ref="' + s + '"]');
    else { try { el = document.querySelector(s); } catch (e) { el = null; } }
    if (!el) throw new Error('대상 없음: ' + s);
    return el;
  }

  // React 호환 값 주입 — 프레임워크가 감싼 setter 대신 네이티브 value setter 사용 후 이벤트 발화.
  function setValue(el, v, withChange){
    var proto = (window.HTMLTextAreaElement && el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
      : (window.HTMLSelectElement && el instanceof HTMLSelectElement) ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (withChange) el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  window.__cptAgent = {
    // 인터랙티브 요소 스냅샷 — data-cpt-ref="eN" 를 새로 부여하고 목록을 반환.
    snapshot: function(){
      var old = document.querySelectorAll('[data-cpt-ref]');
      for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-cpt-ref');
      var els = document.querySelectorAll(SEL);
      var refs = [];
      var n = 0;
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!visible(el)) continue;
        n += 1;
        var ref = 'e' + n;
        el.setAttribute('data-cpt-ref', ref);
        var r = el.getBoundingClientRect();
        var item = {
          ref: ref,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          name: nameOf(el),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        };
        if ('value' in el && typeof el.value === 'string') item.value = el.value.slice(0, 200);
        if (el.href) item.href = String(el.href).slice(0, 500);
        refs.push(item);
      }
      return { url: location.href, title: document.title, refs: refs };
    },

    // 클릭 — target(ref/selector) 또는 좌표(x,y, viewport CSS px). 좌표면 elementFromPoint 로 대상 결정.
    click: function(target, x, y){
      var byXY = (typeof x === 'number' && typeof y === 'number');
      var el;
      if (byXY) {
        el = document.elementFromPoint(x, y);
        if (!el) throw new Error('좌표에 요소가 없음: ' + x + ',' + y);
      } else {
        el = resolve(target);
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      }
      var r = el.getBoundingClientRect();
      var cx = byXY ? x : r.x + r.width / 2;
      var cy = byXY ? y : r.y + r.height / 2;
      var opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return { clicked: byXY ? (cx + ',' + cy) : String(target) };
    },

    // 스크롤 — target 지정 시 그 요소를 화면 중앙으로. 아니면 window: dx/dy=상대(scrollBy), x/y=절대(scrollTo).
    scroll: function(spec){
      spec = spec || {};
      if (spec.target != null && spec.target !== '') {
        var el = resolve(spec.target);
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        return { x: window.scrollX, y: window.scrollY, into: true };
      }
      if (typeof spec.dx === 'number' || typeof spec.dy === 'number') window.scrollBy(spec.dx || 0, spec.dy || 0);
      else window.scrollTo(spec.x || 0, spec.y || 0);
      return { x: window.scrollX, y: window.scrollY };
    },

    // 키 입력 — keydown→(문자면 값 반영)→keyup 을 합성 KeyboardEvent 로. 합성 이벤트는 isTrusted:false 라
    //  앱 JS 핸들러엔 통하지만 브라우저 기본동작(폼 submit 등)은 발화 안 될 수 있음(GUIDE 명기).
    press: function(spec){
      spec = spec || {};
      var key = String(spec.key || '');
      if (!key) throw new Error('key 필요');
      var el = (spec.target != null && spec.target !== '') ? resolve(spec.target) : (document.activeElement || document.body);
      try { el.focus(); } catch (e) {}
      var mods = spec.modifiers || [];
      function has(m){ return mods.indexOf(m) >= 0; }
      var init = { key: key, code: (key.length === 1 ? 'Key' + key.toUpperCase() : key),
        bubbles: true, cancelable: true, ctrlKey: has('ctrl'), altKey: has('alt'), shiftKey: has('shift'), metaKey: has('meta') };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      var ins = spec.text != null ? String(spec.text) : (key.length === 1 && !has('ctrl') && !has('meta') && !has('alt') ? key : '');
      if (ins) {
        if ('value' in el && typeof el.value === 'string') setValue(el, String(el.value || '') + ins, false);
        else if (el.isContentEditable) { el.textContent = String(el.textContent || '') + ins; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      return { key: key };
    },

    // 타이핑 — 기존 값에 append + input 이벤트.
    type: function(target, text){
      var el = resolve(target);
      el.focus();
      text = String(text == null ? '' : text);
      if (el.isContentEditable) {
        el.textContent = String(el.textContent || '') + text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        setValue(el, String(el.value || '') + text, false);
      }
      return { typed: text };
    },

    // 값 채우기 — 통째 교체 + input/change 이벤트(React 호환).
    fill: function(target, value){
      var el = resolve(target);
      el.focus();
      value = String(value == null ? '' : value);
      if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        setValue(el, value, true);
      }
      return { filled: true, value: value };
    },

    // 임의 JS 평가(결과는 JSON 직렬화 가능해야 회수됨).
    eval: function(code){
      return (0, eval)(String(code));
    },

    // 대기 조건 단발 검사 — {selector}=존재+가시, {text}=본문 포함, {js}=truthy, 없으면 로드 완료.
    //  폴링은 호출측(ui-channel, 500ms) 책임.
    wait: function(spec){
      spec = spec || {};
      if (spec.selector) {
        var el = document.querySelector(spec.selector);
        return { ready: !!(el && visible(el)) };
      }
      if (spec.text) return { ready: String((document.body && document.body.innerText) || '').indexOf(spec.text) >= 0 };
      if (spec.js) return { ready: !!(0, eval)(String(spec.js)) };
      return { ready: document.readyState === 'complete' };
    },

    // 페이지 정보 조회 — url|title|text|html (selector 범위, 100KB 절삭).
    get: function(what, selector){
      var LIMIT = 100 * 1024;
      if (what === 'url') return { value: location.href };
      if (what === 'title') return { value: document.title };
      var root = selector ? document.querySelector(selector) : document.documentElement;
      if (!root) throw new Error('대상 없음: ' + selector);
      var s = what === 'html' ? String(root.outerHTML || '') : String(root.innerText || root.textContent || '');
      return { value: s.slice(0, LIMIT), truncated: s.length > LIMIT };
    }
  };
})();`;
