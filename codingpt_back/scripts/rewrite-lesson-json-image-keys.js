/**
 * codingpt_app/src/data/{html,css,js}_lesson/*.json 의
 * image/src/icon 키를 ObjectStore URL로 일괄 치환.
 *
 * 1회성 스크립트. git에 commit되는 JSON 파일들을 직접 수정한다.
 * 멱등: 이미 URL이면 건드리지 않음.
 *
 * 사용:
 *   node scripts/rewrite-lesson-json-image-keys.js
 */

const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.resolve(__dirname, '../../../codingpt_app/src/data');
const TARGET_DIRS = ['html_lesson', 'css_lesson', 'js_lesson'];

const OS_BASE = 'https://objectstore.ghmate.com/codingpt/lesson-assets/images';
const KEY_TO_URL = {
  student_full: `${OS_BASE}/student_full.png`,
  teacher_full: `${OS_BASE}/teacher_full.png`,
  html_role_img: `${OS_BASE}/html_role_img.png`,
  html_img: `${OS_BASE}/html_img.png`,
  css_img: `${OS_BASE}/css_img.png`,
  js_img: `${OS_BASE}/js_img.png`,
  html_lesson_02: `${OS_BASE}/html_lesson_02.png`,
  teacher_profile: `${OS_BASE}/teacher_profile.png`,
  html_lesson_03: `${OS_BASE}/html_lesson_03.png`,
  html_lesson_04: `${OS_BASE}/html_lesson_04.png`,
  html_lesson_09: `${OS_BASE}/html_lesson_09.png`,
  html_lesson_09_2: `${OS_BASE}/html_lesson_09_2.png`,
  css_lesson_01: `${OS_BASE}/css_lesson_01.png`,
  css_lesson_02: `${OS_BASE}/css_lesson_02.png`,
  css_lesson_04: `${OS_BASE}/css_lesson_04.png`,
  css_lesson_04_2: `${OS_BASE}/css_lesson_04_2.png`,
  css_lesson_04_3: `${OS_BASE}/css_lesson_04_3.png`,
  css_lesson_07: `${OS_BASE}/css_lesson_07.png`,
  css_lesson_08: `${OS_BASE}/css_lesson_08.png`,
  css_lesson_09_1: `${OS_BASE}/css_lesson_09_1.png`,
  css_lesson_09_2: `${OS_BASE}/css_lesson_09_2.png`,
  student_profile: `${OS_BASE}/student_profile.png`,
  js_lesson_02: `${OS_BASE}/js_lesson_02.png`,
  js_lesson_04_1: `${OS_BASE}/js_lesson_04_1.png`,
  js_lesson_04_2: `${OS_BASE}/js_lesson_04_2.png`,
  js_lesson_05_1: `${OS_BASE}/js_lesson_05_1.png`,
};
const TARGET_FIELDS = new Set(['image', 'src', 'icon']);

function transformTree(node) {
  if (node === null || node === undefined) return { node, changed: 0 };
  if (Array.isArray(node)) {
    let changed = 0;
    for (let i = 0; i < node.length; i++) {
      const r = transformTree(node[i]);
      node[i] = r.node;
      changed += r.changed;
    }
    return { node, changed };
  }
  if (typeof node === 'object') {
    let changed = 0;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && TARGET_FIELDS.has(k) && Object.prototype.hasOwnProperty.call(KEY_TO_URL, v)) {
        node[k] = KEY_TO_URL[v];
        changed += 1;
      } else {
        const r = transformTree(v);
        node[k] = r.node;
        changed += r.changed;
      }
    }
    return { node, changed };
  }
  return { node, changed: 0 };
}

function processFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  const { node, changed } = transformTree(data);
  if (changed > 0) {
    // 들여쓰기/줄바꿈 보존을 위해 2-space로 재직렬화
    fs.writeFileSync(filePath, JSON.stringify(node, null, 2) + '\n', 'utf8');
  }
  return changed;
}

function main() {
  let total = 0;
  for (const dir of TARGET_DIRS) {
    const full = path.join(DATA_ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(full, f);
      const c = processFile(p);
      console.log(`  · ${dir}/${f}: ${c} replacements`);
      total += c;
    }
  }
  console.log(`\n✅ 총 ${total}건 치환 완료`);
}

main();
