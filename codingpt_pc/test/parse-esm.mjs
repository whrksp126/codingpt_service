// parse-esm.mjs — src/js/*.js 전량 ESM 파싱 검증. `npm test` 의 1단계.
//
// 왜 이 형태인가
//  · 번들러가 없어 "빌드가 문법 오류를 잡아 주는" 단계가 아예 없다(웹뷰가 런타임에 처음 파싱한다) →
//    타이포 하나가 앱을 흰 화면으로 만든다. 그래서 파싱만 따로 고정한다.
//  · `vm.SourceTextModule` 은 이 노드에서 못 쓴다(--experimental-vm-modules 필요) → 동적 import 로
//    실제 파서를 돌리고 **SyntaxError 만** 실패로 센다. ReferenceError(브라우저 전역 부재) 등
//    평가 단계 오류는 문법 문제가 아니므로 통과로 본다.
import { readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const dir = process.argv[2] || fileURLToPath(new URL('../src/js', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
let ok = 0;
const bad = [];
for (const f of files) {
  const url = pathToFileURL(`${dir}/${f}`).href;
  try { await import(url); ok++; }
  catch (e) {
    if (e instanceof SyntaxError) bad.push(`${f}: ${e.message}`);
    else ok++; // ReferenceError/브라우저 전역 부재 등은 문법 문제가 아니다
  }
}
console.log(`parsed ${ok}/${files.length}`);
for (const b of bad) console.log('SYNTAX ' + b);
process.exit(bad.length ? 1 : 0);
