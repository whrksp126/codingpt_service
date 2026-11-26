// tts.js — 채팅 답변 [읽어 주기]. 엔진 = 웹뷰의 speechSynthesis(macOS 음성, 기기 안에서만 돈다).
//  앱 services/tts.ts 와 같은 규칙: 한 번에 하나만, 코드 블록은 읽지 않음, 한글이 섞이면 한국어 목소리.
const S = typeof window !== "undefined" ? window.speechSynthesis : null;
let current = null;
const subs = new Set();
function set(id) { if (current === id) return; current = id; subs.forEach((fn) => { try { fn(current); } catch (_) { /* noop */ } }); }

export function ttsAvailable() { return !!(S && typeof window.SpeechSynthesisUtterance === "function"); }

/** 마크다운 → 소리 내어 읽을 평문. 앱 speakable 과 같다. */
export function speakable(md) {
  return String(md || "")
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function langOf(text) {
  const ko = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return ko > 0 && ko * 3 >= latin ? "ko-KR" : "en-US";
}
export function stopSpeaking() { set(null); try { S && S.cancel(); } catch (_) { /* noop */ } }
export function speak(id, md) {
  if (!ttsAvailable()) return;
  const text = speakable(md);
  if (!text) return;
  try { S.cancel(); } catch (_) { /* noop */ }
  const u = new window.SpeechSynthesisUtterance(text);
  u.lang = langOf(text);
  const v = (S.getVoices() || []).find((x) => x.lang && x.lang.replace("_", "-").startsWith(u.lang.slice(0, 2)));
  if (v) u.voice = v;
  const done = () => { if (current === id) set(null); };
  u.onend = done; u.onerror = done;
  set(id);
  S.speak(u);
}
export function toggleSpeak(id, md) { if (current === id) stopSpeaking(); else speak(id, md); }
export function speakingId() { return current; }
/** 지금 읽는 id 가 바뀔 때 — 반환값으로 구독 해제. */
export function onSpeaking(fn) { subs.add(fn); return () => subs.delete(fn); }
