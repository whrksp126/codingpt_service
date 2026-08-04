// i18n — 화면 문구의 언어 전환(PC). **한국어 원문이 곧 키다.**
//
// ⚠ 앱(`codingpt_app/src/i18n/index.ts`)에 같은 규율·같은 사전이 있고 **대조 테스트가 걸려 있다**
//   (`test/i18n-crossimpl.mjs`). 왜 원문을 키로 쓰는지, 왜 문장 조립을 금지하는지는 그 파일의
//   머리주석이 정본이다(요약: 놓친 자리가 식별자 날문자가 아니라 한국어로 남게, 사전을 사람이
//   읽을 수 있게, 추출이 결정적이게).
//
// PC 만의 사정:
//  · 번들러가 없어서 JSON import 를 못 쓴다(웹뷰 JSON 모듈 지원이 들쭉날쭉) → 사전은 `.js` 다.
//    내용은 앱의 `.json` 과 **한 글자도 다르면 안 된다**(scripts/i18n-sync.js 가 둘 다 쓴다).
//  · 화면이 명령형 DOM 이라 문구가 바뀌어도 저절로 다시 안 그려진다 → 언어 변경은 `location.reload()`.
//    전환은 드문 행위라 이 편이 화면마다 구독을 심는 것보다 확실하다.
import KO from "./ko.js";
import EN from "./en.js";
import JA from "./ja.js";
import ZH from "./zh-CN.js";
import ES from "./es.js";
import DE from "./de.js";
import FR from "./fr.js";

export const LANGS = ["ko", "en", "ja", "zh-CN", "es", "de", "fr"];

/** 설정 화면 이름은 **그 언어 자신의 표기**다(영어로 "Japanese" 라고 쓰면 못 찾는다). */
export const LANG_LABELS = {
  ko: "한국어",
  en: "English",
  ja: "日本語",
  "zh-CN": "简体中文",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
};

const CATALOGS = { ko: KO, en: EN, ja: JA, "zh-CN": ZH, es: ES, de: DE, fr: FR };

let lang = "ko";
let catalog = CATALOGS.ko;

export function getLang() { return lang; }

export function isLang(v) { return typeof v === "string" && LANGS.includes(v); }

/** 부팅 시·설정 변경 시. 모르는 값은 한국어. */
export function setLangRuntime(v) {
  lang = isLang(v) ? v : "ko";
  catalog = CATALOGS[lang] || CATALOGS.ko;
}

/** OS/브라우저 언어 → 우리 언어. 중국어 번체는 간체로 안 떨어뜨린다(글자가 아예 다르다). */
export function matchDeviceLang(raw) {
  const s = String(raw || "").replace(/_/g, "-");
  if (!s) return "en";
  const low = s.toLowerCase();
  if (low.startsWith("ko")) return "ko";
  if (low.startsWith("ja")) return "ja";
  if (low.startsWith("zh")) return /hant|-tw|-hk|-mo/.test(low) ? "en" : "zh-CN";
  if (low.startsWith("es")) return "es";
  if (low.startsWith("de")) return "de";
  if (low.startsWith("fr")) return "fr";
  if (low.startsWith("en")) return "en";
  return "en";
}

const VAR_RE = /\{(\w+)\}/g;

/**
 * 문구 조회. `text` 는 한국어 원문이고 그게 곧 사전의 키다.
 *  · 사전에 없으면 원문을 그대로 돌려준다(번역 안 된 화면도 읽을 수는 있어야 한다).
 *  · `{n}` 자리에 vars 를 끼운다. vars 에 없는 이름은 그대로 둔다(지우면 문장이 망가진다).
 */
export function t(text, vars) {
  const src = typeof text === "string" ? text : "";
  const hit = catalog[src];
  const out = typeof hit === "string" && hit ? hit : src;
  if (!vars) return out;
  return out.replace(VAR_RE, (whole, name) => {
    const v = vars[name];
    return v == null ? whole : String(v);
  });
}

export function translatedCount(l) {
  const c = CATALOGS[l];
  if (!c) return 0;
  let n = 0;
  for (const k of Object.keys(c)) if (c[k] && c[k] !== k) n++;
  return n;
}

export function catalogFor(l) { return CATALOGS[l] || CATALOGS.ko; }
