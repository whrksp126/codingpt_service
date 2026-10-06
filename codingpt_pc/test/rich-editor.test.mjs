// rich-editor — 마크다운 ↔ 편집기 DOM 왕복(node 에는 DOM 이 없어 아주 작은 가짜 DOM 으로 돌린다).
//  지키는 것: 편집기에서 열었다 저장만 해도 본문이 바뀌지 않는다(왕복 안정) · 첨부 자리(att:ID)가 살아남는다.
import path from 'node:path';
const M = await import('file://' + path.resolve('src/js/rich-editor.js'));
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };

const VOID = new Set(['br', 'hr', 'img', 'input']);
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
function parse(html) {
  const el = (tag, attrs) => ({ nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [], checked: 'checked' in attrs,
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''); } });
  const root = el('div', {});
  const stack = [root];
  for (const m of html.matchAll(/<\/([a-z0-9]+)>|<([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/g)) {
    if (m[1]) stack.pop();
    else if (m[2]) {
      const attrs = {};
      for (const a of (m[3] || '').matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = unesc(a[2] || '');
      const n = el(m[2], attrs);
      stack[stack.length - 1].childNodes.push(n);
      if (!VOID.has(m[2])) stack.push(n);
    } else stack[stack.length - 1].childNodes.push({ nodeType: 3, nodeValue: unesc(m[4]) });
  }
  return root;
}
const round = (md) => M.domToMd(parse(M.mdToHtml(md)));

const DOC = ['# 로그인 리다이렉트', '', '재현: **홈**에서 *로그인* 후 ~~뒤로~~ `router.push` 가 두 번 돈다.', '둘째 줄', '', '- 크롬', '- 사파리', '',
  '- [ ] 원인 찾기', '- [x] 재현 영상', '', '1. 로그인', '2. 뒤로 가기', '', '> 기대: 원래 페이지', '> 실제: /home', '', '```', 'if (a < b) go();', '```', '',
  '---', '', '![오류 화면](att:aaaaaa1)', '참고 [문서](https://a.io/x)'].join('\n');
ok(round(DOC) === DOC, '왕복: 제목·굵게·기울임·취소선·코드·목록 3종·인용·코드 블록·구분선·이미지·링크', JSON.stringify(round(DOC)));
ok(round('') === '' && round('한 줄') === '한 줄' && round('a\nb\n\nc') === 'a\nb\n\nc', '빈 글 · 한 줄 · 빈 줄이 그대로');
ok(round(round(DOC)) === round(DOC), '두 번 돌려도 같다');
ok(M.mdToHtml('<script>x</script>').includes('&lt;script&gt;'), '본문의 html 은 글자로 들어간다(실행되지 않는다)');
ok(M.inlineToHtml('`a*b*c` **d**') === '<code>a*b*c</code> <b>d</b>', '코드 안의 기호는 서식으로 읽지 않는다');
// 웹뷰가 실제로 만드는 모양(편집 중) → 마크다운
ok(M.domToMd(parse('<div>가<b> 굵게 </b>나</div><div><br></div><ul><li>하나</li><li><div>둘</div></li></ul><div>끝</div>')) === '가 **굵게** 나\n\n- 하나\n- 둘\n\n끝', '편집 중 DOM: 공백을 낀 굵게 · 빈 줄 · 목록 안의 div', JSON.stringify(M.domToMd(parse('<div>가<b> 굵게 </b>나</div><div><br></div><ul><li>하나</li><li><div>둘</div></li></ul><div>끝</div>'))));
ok(M.domToMd(parse('맨 글자<br>둘째<h2>제목</h2><div><img data-att="bbbbbb2" alt="[캡처]"></div>')) === '맨 글자\n둘째\n\n## 제목\n\n![캡처](att:bbbbbb2)', '감싸지 않은 글자 · 제목 · 이미지(이름의 대괄호는 뺀다)', JSON.stringify(M.domToMd(parse('맨 글자<br>둘째<h2>제목</h2><div><img data-att="bbbbbb2" alt="[캡처]"></div>'))));
console.log(fail ? `\n${pass} PASS / ${fail} FAIL` : `\nALL PASS — pass ${pass} / fail 0`);
process.exit(fail ? 1 : 0);
