// JXA — 앞 앱(또는 인자 pid)의 접근성 트리를 JSON 으로. ObjC 브리지로 AXUIElement C API 를 직접 부른다(System Events 보다 훨씬 빠름).
//  실측 함정(2026-09-19): 기본 바인딩은 JS 문자열을 CFStringRef 로 안 받고(-25201), Ref 재사용은 "incompatible type" —
//  요소는 void*, 값은 void** 로 다시 바인딩하고 castRefToObject 로 읽는다. 좌표(AXValue)는 CFCopyDescription 문자열을 파싱한다.
ObjC.import('ApplicationServices'); ObjC.import('Cocoa');
ObjC.bindFunction('AXUIElementCreateApplication', ['void*', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['void*', 'id', 'void**']]);
ObjC.bindFunction('CFCopyDescription', ['id', ['void*']]);
function run(argv) {
  const maxNodes = 2000, maxDepth = 30;
  //  인자: 없으면 앞 앱, 숫자면 pid, 아니면 앱 이름(localizedName, 대소문자 무시).
  let pid = 0; const want = argv && argv[0] ? String(argv[0]) : '';
  if (/^\d+$/.test(want)) pid = Number(want);
  else if (want) { const apps = ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications); for (const a of apps) { if (ObjC.unwrap(a.localizedName).toLowerCase() === want.toLowerCase()) { pid = a.processIdentifier; break; } } if (!pid) return JSON.stringify({ error: 'app not running: ' + want }); }
  if (!pid) pid = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  const ra = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  const appName = ra.isNil() ? '' : ObjC.unwrap(ra.localizedName);
  const scr = $.NSScreen.mainScreen.frame; const SW = scr.size.width, SH = scr.size.height;   // 포인트(레티나 2x 면 1440→720)
  const NS = {}; const ns = (s) => NS[s] || (NS[s] = $(s));
  function attr(el, name) { const r = Ref(); const err = $.AXUIElementCopyAttributeValue(el, ns(name), r); return err === 0 ? r[0] : null; }
  function plain(v) { if (v === null || v === undefined) return null; try { const u = ObjC.unwrap(ObjC.castRefToObject(v)); return (typeof u === 'string' || typeof u === 'number' || typeof u === 'boolean') ? u : null; } catch (_) { return null; } }
  function xy(v) { if (!v) return null; const d = ObjC.unwrap($.CFCopyDescription(v)); const m = /x:(-?[\d.]+) y:(-?[\d.]+)/.exec(d); return m ? [Number(m[1]), Number(m[2])] : null; }
  function wh(v) { if (!v) return null; const d = ObjC.unwrap($.CFCopyDescription(v)); const m = /w:(-?[\d.]+) h:(-?[\d.]+)/.exec(d); return m ? [Number(m[1]), Number(m[2])] : null; }
  const out = []; let n = 0;
  function walk(el, depth, parent) {
    if (n >= maxNodes || depth > maxDepth) return;
    const role = plain(attr(el, 'AXRole')); if (!role) return;
    const node = { i: n++, p: parent, role: String(role).replace(/^AX/, '') };
    const sub = plain(attr(el, 'AXSubrole')); if (sub) node.subrole = String(sub).replace(/^AX/, '');
    for (const [k, a] of [['title', 'AXTitle'], ['desc', 'AXDescription'], ['id', 'AXIdentifier'], ['ph', 'AXPlaceholderValue'], ['help', 'AXHelp']]) { const v = plain(attr(el, a)); if (v !== null && v !== '') node[k] = String(v).slice(0, 200); }
    const val = plain(attr(el, 'AXValue')); if (val !== null && val !== '') node.value = String(val).slice(0, 200);
    if (plain(attr(el, 'AXEnabled')) === false) node.disabled = true;
    if (plain(attr(el, 'AXFocused')) === true) node.focused = true;
    const p = xy(attr(el, 'AXPosition')), s = wh(attr(el, 'AXSize'));
    if (p && s && s[0] > 0 && s[1] > 0) { node.x = +(p[0] / SW).toFixed(4); node.y = +(p[1] / SH).toFixed(4); node.w = +(s[0] / SW).toFixed(4); node.h = +(s[1] / SH).toFixed(4); }
    out.push(node);
    const chRef = attr(el, 'AXChildren'); if (!chRef) return;
    let ch; try { ch = ObjC.castRefToObject(chRef); } catch (_) { return; }
    const cnt = ch.count;
    for (let i = 0; i < cnt && n < maxNodes; i++) walk(ObjC.castObjectToRef(ch.objectAtIndex(i)), depth + 1, node.i);
  }
  walk($.AXUIElementCreateApplication(pid), 0, -1);
  return JSON.stringify({ app: appName, pid, screen: { w: SW, h: SH }, truncated: n >= maxNodes, nodes: out });
}
