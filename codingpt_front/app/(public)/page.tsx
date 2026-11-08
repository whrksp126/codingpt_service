// 랜딩 — 정적(Static) 렌더. "내 머신의 코딩 에이전트를 폰·태블릿에서 이어받아 지휘" 제품 소개 + 다운로드.
// 순수 서버 컴포넌트 — 외부 import 없음(lib/api 등 import 시 prod SSG 가 빈 본문이 되는 문제 회피).
// 샘플 다크 디자인(codingpt-sample.html)의 <div id="view-landing"> 섹션을 그대로 포팅.
// CSS 는 .cpt-landing 스코프로 격리(globals/Nav/Footer 와 충돌 방지).

import CheckoutButtons from '@/components/CheckoutButtons';

const APP_STORE_URL = 'https://apps.apple.com/app/id6751457159';

const css = `
html{scroll-behavior:smooth}
.cpt-landing{--border-2:#252C3A;--line:#141926;--add:#3FB27F;--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard','Noto Sans KR',sans-serif;}
.cpt-landing .container{max-width:1080px;margin:0 auto;padding:0 24px;}
.cpt-landing .muted{color:var(--text3);}
.cpt-landing a{color:inherit;text-decoration:none;cursor:pointer;}
.cpt-landing img{max-width:100%;}
.cpt-landing h1,.cpt-landing h2,.cpt-landing h3,.cpt-landing h4{margin:0;letter-spacing:-0.03em;text-wrap:balance;font-weight:750;}
.cpt-landing ::selection{background:rgba(148,163,184,0.24);}
.cpt-landing :focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:5px;}
.cpt-landing section{scroll-margin-top:90px;}

/* 다운로드(채움) ↔ 문서 보기(아웃라인) — 같은 형태의 반대 쌍 */
.cpt-landing .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:10px;padding:12px 21px;font-size:14.5px;font-weight:680;cursor:pointer;font-family:inherit;letter-spacing:-0.01em;color:var(--on-accent);background:var(--accent);border:1px solid var(--accent);transition:transform .12s ease, background .15s ease, border-color .15s ease;}
.cpt-landing .btn:hover{background:var(--accent-hover);border-color:var(--accent-hover);transform:translateY(-1px);}
.cpt-landing .btn:active{transform:translateY(0);}
.cpt-landing .btn svg{opacity:.85;}
.cpt-landing .btn.ghost{background:var(--elevated);color:var(--text2);border:1px solid var(--border-2);}
.cpt-landing .btn.ghost:hover{background:var(--hover);border-color:var(--dim);color:var(--text);transform:translateY(-1px);}
.cpt-landing .btn.sm{padding:8px 16px;font-size:13.5px;}

/* Hero */
.cpt-landing .hero{text-align:center;padding:72px 0 0;}
.cpt-landing .hero .kick{font-size:13px;color:var(--text3);font-weight:600;margin-bottom:18px;}
.cpt-landing .hero h1{font-size:clamp(30px,5.4vw,46px);line-height:1.1;max-width:18ch;margin:0 auto;font-weight:780;}
.cpt-landing .hero .sub{color:var(--text3);font-size:clamp(15.5px,2.1vw,18px);line-height:1.65;max-width:52ch;margin:20px auto 0;}
.cpt-landing .hero .ctas{display:flex;gap:11px;justify-content:center;margin-top:30px;flex-wrap:wrap;}
.cpt-landing .hero .avail{margin-top:16px;font-size:12.5px;color:var(--dim);}
.cpt-landing .hero .avail b{color:var(--text3);font-weight:600;}

/* 큰 워크스페이스 목업 */
.cpt-landing .shot-wrap{position:relative;width:min(92vw,1300px);margin:60px 0 0 50%;transform:translateX(-50%);}
.cpt-landing .shot-glow{display:none;}
.cpt-landing .app{position:relative;background:var(--surface);border:1px solid var(--border-2);border-radius:14px;overflow:hidden;box-shadow:0 40px 90px -30px rgba(0,0,0,.75);}
.cpt-landing .app-bar{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--border);background:var(--elevated);}
.cpt-landing .dots{display:flex;gap:6px;}
.cpt-landing .dots i{width:11px;height:11px;border-radius:50%;display:block;}
.cpt-landing .dots .r{background:#ff5f57;}
.cpt-landing .dots .y{background:#febc2e;}
.cpt-landing .dots .g{background:#28c840;}
.cpt-landing .app-bar .ttl{margin-left:8px;font-size:12px;color:var(--text3);font-weight:600;}
.cpt-landing .app-bar .rt{margin-left:auto;display:flex;gap:12px;color:var(--dim);font-size:12px;}
.cpt-landing .app-body{display:grid;grid-template-columns:52px 148px 1fr 1fr 236px;min-height:392px;font-family:var(--mono);font-size:11.5px;}
.cpt-landing .shot-img{display:block;width:100%;height:auto;}
.cpt-landing .rail{border-right:1px solid var(--line);background:var(--base);display:flex;flex-direction:column;align-items:center;gap:16px;padding:14px 0;color:var(--dim);}
.cpt-landing .rail .ico{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;background:var(--elevated);}
.cpt-landing .rail .ico.on{background:var(--hover);color:var(--text2);}
.cpt-landing .rail .dev{margin-top:auto;display:flex;flex-direction:column;gap:9px;align-items:center;}
.cpt-landing .rail .dev span{width:8px;height:8px;border-radius:50%;background:var(--border-2);}
.cpt-landing .rail .dev span.live{background:var(--accent);}
.cpt-landing .tree{border-right:1px solid var(--line);background:var(--base);padding:14px 12px;color:var(--text3);display:flex;flex-direction:column;gap:8px;}
.cpt-landing .tree .h{color:var(--dim);font-size:10px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:2px;}
.cpt-landing .tree .f{color:var(--text3);}
.cpt-landing .tree .f.on{color:var(--text);}
.cpt-landing .tree .in{padding-left:12px;}
.cpt-landing .pane{border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0;}
.cpt-landing .pane .ph{display:flex;border-bottom:1px solid var(--line);background:var(--elevated);}
.cpt-landing .pane .ph .t{padding:7px 13px;font-size:11px;color:var(--text3);border-right:1px solid var(--line);}
.cpt-landing .pane .ph .t.on{color:var(--text);background:var(--surface);}
.cpt-landing .pane .bd{padding:14px 15px;line-height:1.85;color:var(--text2);overflow:hidden;flex:1;}
.cpt-landing .kw{color:var(--info);}
.cpt-landing .st{color:#C9A879;}
.cpt-landing .cm{color:#5D6E63;}
.cpt-landing .fn{color:#9DD7BE;}
.cpt-landing .ln{color:var(--dim);display:inline-block;width:18px;user-select:none;}
.cpt-landing .add{background:rgba(63,178,127,0.12);color:var(--add);display:block;margin:0 -15px;padding:0 15px;}
.cpt-landing .term .p{color:var(--accent);}
.cpt-landing .term .path{color:var(--dim);}
.cpt-landing .term .ok{color:var(--add);}
.cpt-landing .term .cm2{color:#5D6E63;}
.cpt-landing .cur{display:inline-block;width:7px;height:13px;background:var(--accent);vertical-align:-2px;animation:cptBlink 1.1s step-end infinite;}
@keyframes cptBlink{50%{opacity:0;}}
.cpt-landing .prev{background:var(--base);display:flex;flex-direction:column;}
.cpt-landing .prev .pb{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--elevated);}
.cpt-landing .prev .pb .u{flex:1;font-size:10px;color:var(--dim);background:var(--base);border:1px solid var(--line);border-radius:5px;padding:3px 8px;}
.cpt-landing .prev .render{padding:18px 16px;font-family:var(--sans);}
.cpt-landing .prev .render .b{height:10px;width:66%;border-radius:5px;background:var(--text2);opacity:.9;}
.cpt-landing .prev .render .l{height:7px;border-radius:5px;background:var(--border-2);margin-top:9px;}
.cpt-landing .prev .render .cbtn{margin-top:15px;display:inline-block;background:var(--cta);color:#fff;font-size:11px;font-weight:650;padding:6px 13px;border-radius:7px;}
.cpt-landing .phone{position:absolute;right:-30px;bottom:-56px;width:290px;padding:10px;border-radius:46px;background:linear-gradient(150deg,#544f66 0%,#2c2a3a 38%,#15151e 72%,#0d0d13 100%);box-shadow:0 56px 104px -26px rgba(0,0,0,.95),0 0 0 1px rgba(255,255,255,.05),inset 0 1px 1px rgba(255,255,255,.14);}
.cpt-landing .phone::before{content:"";position:absolute;top:34px;right:-2px;width:3px;height:56px;border-radius:2px;background:linear-gradient(#3a3748,#232030);}
.cpt-landing .phone::after{content:"";position:absolute;top:150px;left:-2px;width:3px;height:34px;border-radius:2px;background:linear-gradient(#3a3748,#232030);}
.cpt-landing .phone-shot{display:block;width:100%;height:auto;border-radius:37px;}
.cpt-landing .phone .notch{position:absolute;top:8px;left:50%;transform:translateX(-50%);width:56px;height:5px;border-radius:99px;background:#05070b;z-index:2;}
.cpt-landing .phone .top{padding:16px 12px 8px;font-size:9.5px;color:var(--dim);font-family:var(--mono);display:flex;justify-content:space-between;}
.cpt-landing .phone .body{padding:2px 11px 12px;font-family:var(--mono);font-size:9.5px;line-height:1.75;color:var(--text2);}
.cpt-landing .phone .p{color:var(--accent);}
.cpt-landing .phone .ok{color:var(--add);}
.cpt-landing .phone .cm2{color:#5D6E63;}
.cpt-landing .phone .kbar{margin-top:10px;display:flex;gap:4px;}
.cpt-landing .phone .kbar span{flex:1;height:16px;border-radius:4px;background:var(--elevated2);border:1px solid var(--line);}
.cpt-landing .cap{font-size:12px;color:var(--dim);text-align:center;margin-top:14px;}

/* 신뢰 한 줄 */
.cpt-landing .oneline{margin-top:96px;display:flex;justify-content:center;gap:34px;flex-wrap:wrap;color:var(--text3);font-size:14px;}
.cpt-landing .oneline b{color:var(--text);font-weight:650;}

/* 기능 행 */
.cpt-landing .rows{margin-top:60px;display:flex;flex-direction:column;gap:8px;}
.cpt-landing .row2{display:grid;grid-template-columns:0.9fr 1.1fr;gap:56px;align-items:center;padding:44px 0;border-top:1px solid var(--border);}
.cpt-landing .row2.rev .fig{order:-1;}
.cpt-landing .row2 h3{font-size:21px;font-weight:720;}
.cpt-landing .row2 p{color:var(--text3);font-size:15px;line-height:1.72;margin:12px 0 0;max-width:42ch;}
.cpt-landing .row2 .more{display:inline-block;margin-top:16px;color:var(--text2);font-weight:650;font-size:14px;border-bottom:1px solid var(--border-2);padding-bottom:2px;}
.cpt-landing .row2 .more:hover{color:var(--text);border-color:var(--dim);}
.cpt-landing .feat-img{display:block;width:100%;height:auto;border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 44px -24px rgba(0,0,0,.6);}
.cpt-landing .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
.cpt-landing .card .cbar{display:flex;align-items:center;gap:7px;padding:9px 12px;border-bottom:1px solid var(--line);background:var(--elevated);}
.cpt-landing .card .cbar .u{margin-left:6px;font-family:var(--mono);font-size:10.5px;color:var(--dim);}
.cpt-landing .card .cbody{padding:15px 16px;font-family:var(--mono);font-size:12px;line-height:1.9;color:var(--text2);}
.cpt-landing .cdot{width:9px;height:9px;border-radius:50%;display:inline-block;}

.cpt-landing .chat-demo{padding:16px;display:flex;flex-direction:column;gap:10px;}
.cpt-landing .bubble{max-width:86%;padding:10px 12px;border-radius:11px;font-size:12.5px;line-height:1.55;}
.cpt-landing .bubble.user{align-self:flex-end;background:var(--elevated2);border:1px solid var(--border-2);color:var(--text);font-family:var(--sans);font-weight:650;}
.cpt-landing .bubble.agent{align-self:flex-start;background:var(--elevated);border:1px solid var(--line);color:var(--text2);font-family:var(--sans);}
.cpt-landing .tool-row{font-family:var(--mono);font-size:11px;color:var(--text3);border:1px solid var(--line);background:var(--base);border-radius:8px;padding:8px 10px;}

/* 새 기능 목업 카드 — 무채색, 점 색은 상태 신호만 */
.cpt-landing .mock{padding:14px 14px 16px;display:flex;flex-direction:column;gap:7px;font-family:var(--sans);}
.cpt-landing .mock .grp{font-size:11px;color:var(--dim);font-weight:650;letter-spacing:0.04em;margin:2px 2px 2px;}
.cpt-landing .mock .r{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--line);background:var(--base);border-radius:9px;font-size:13px;color:var(--text2);}
.cpt-landing .mock .r.in{margin-left:16px;}
.cpt-landing .mock .r .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cpt-landing .mock .r .stt{font-size:11.5px;color:var(--text3);}
.cpt-landing .mock .r .tag{font-family:var(--mono);font-size:10.5px;color:var(--dim);border:1px solid var(--line);border-radius:5px;padding:1px 6px;}
.cpt-landing .mock .d{width:7px;height:7px;border-radius:50%;background:var(--border-2);flex:none;}
.cpt-landing .mock .d.run{background:var(--accent);}
.cpt-landing .mock .d.ask{background:#febc2e;}
.cpt-landing .mock .d.done{background:var(--text3);}
.cpt-landing .mock .ask-box{margin-left:16px;font-size:12.5px;color:var(--text2);border:1px solid var(--border-2);background:var(--elevated);border-radius:9px;padding:9px 11px;line-height:1.55;}
.cpt-landing .mock .ask-box small{display:block;color:var(--dim);font-size:11px;margin-bottom:3px;}
.cpt-landing .surfaces{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:14px;}
.cpt-landing .surfaces .sf{border:1px solid var(--line);background:var(--base);border-radius:9px;padding:11px;font-family:var(--sans);}
.cpt-landing .surfaces .sf b{display:block;font-size:12.5px;color:var(--text);font-weight:650;}
.cpt-landing .surfaces .sf span{display:block;font-size:11.5px;color:var(--text3);line-height:1.5;margin-top:5px;}
.cpt-landing .surfaces .log{grid-column:1/-1;font-family:var(--mono);font-size:11px;line-height:1.8;color:var(--text3);border:1px solid var(--line);background:var(--base);border-radius:9px;padding:9px 11px;}
.cpt-landing .surfaces .log .p{color:var(--text2);}
@media(max-width:560px){.cpt-landing .surfaces{grid-template-columns:1fr;}}

/* 후원 — 무료 사용 안내 + 단일 선택 후원 */
.cpt-landing .pricing-sec{margin-top:96px;padding:72px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--surface);}
.cpt-landing .pricing-head{text-align:center;}
.cpt-landing .pricing-head h2{font-size:clamp(25px,4vw,32px);}
.cpt-landing .pricing-head p{max-width:48ch;margin:13px auto 0;color:var(--text3);font-size:15px;line-height:1.7;}
.cpt-landing .support-card{max-width:560px;margin:34px auto 0;background:var(--base);border:1px solid var(--border-2);border-radius:16px;padding:25px;display:flex;align-items:center;gap:24px;}
.cpt-landing .support-card .copy{flex:1;min-width:0;}
.cpt-landing .support-card .label{font-size:13px;color:var(--text3);font-weight:680;}
.cpt-landing .support-card .title{font-size:19px;font-weight:740;margin-top:7px;}
.cpt-landing .support-card .desc{color:var(--text3);font-size:13.5px;line-height:1.65;margin:7px 0 0;}
.cpt-landing .support-card .action{flex:none;text-align:right;}
.cpt-landing .support-card .price{font-size:18px;font-weight:750;margin-bottom:10px;}
.cpt-landing .support-card .price small{font-size:12px;color:var(--text3);font-weight:550;}
.cpt-landing .support-card .btn{padding:10px 17px;}
.cpt-landing .pricing-note{text-align:center;color:var(--text3);font-size:12.5px;line-height:1.65;margin:18px auto 0;}
.cpt-landing .pricing-note a{color:var(--text2);border-bottom:1px solid var(--border-2);}

/* FAQ */
.cpt-landing .faq-sec{margin-top:96px;}
.cpt-landing .faq-sec h2{font-size:26px;font-weight:750;text-align:center;}
.cpt-landing .faq{max-width:720px;margin:32px auto 0;border-top:1px solid var(--border);}
.cpt-landing details{border-bottom:1px solid var(--border);}
.cpt-landing summary{list-style:none;cursor:pointer;padding:20px 2px;font-weight:650;font-size:15.5px;display:flex;justify-content:space-between;gap:14px;align-items:center;color:var(--text);}
.cpt-landing summary::-webkit-details-marker{display:none;}
.cpt-landing summary .ic{color:var(--dim);font-size:16px;transition:transform .2s;}
.cpt-landing details[open] summary .ic{transform:rotate(45deg);color:var(--text2);}
.cpt-landing details p{margin:0 2px 20px;color:var(--text3);font-size:14.5px;line-height:1.72;max-width:64ch;}

/* 시작하기 (단일 다운로드 섹션) */
.cpt-landing .start{margin-top:104px;padding:76px 0 80px;background:var(--surface);border-top:1px solid var(--border);}
.cpt-landing .start .head{text-align:center;margin-bottom:40px;}
.cpt-landing .start .head h2{font-size:clamp(24px,4vw,32px);font-weight:770;}
.cpt-landing .start .head p{color:var(--text3);font-size:15.5px;line-height:1.65;margin:12px auto 0;max-width:44ch;}
.cpt-landing .dlz{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:720px;margin:0 auto;}
.cpt-landing .dlgroup{background:var(--base);border:1px solid var(--border-2);border-radius:16px;padding:22px;}
.cpt-landing .dlh{font-size:11.5px;color:var(--text3);font-weight:650;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:14px;}
.cpt-landing .badge{display:flex;align-items:center;gap:13px;background:#080B11;border:1px solid var(--border-2);border-radius:12px;padding:12px 16px;margin-bottom:10px;transition:border-color .15s,transform .05s;}
.cpt-landing .badge:last-child{margin-bottom:0;}
.cpt-landing .badge:hover{border-color:var(--dim);}
.cpt-landing .badge:active{transform:translateY(1px);}
.cpt-landing .badge.off{opacity:.45;pointer-events:none;}
.cpt-landing .badge .ic{width:22px;display:flex;justify-content:center;align-items:center;flex-shrink:0;color:var(--text2);}
.cpt-landing .badge .ic svg{display:block;}
.cpt-landing .badge .tt{display:flex;flex-direction:column;line-height:1.14;}
.cpt-landing .badge .tt small{font-size:10px;color:var(--text3);letter-spacing:0.01em;}
.cpt-landing .badge .tt b{font-size:15px;color:var(--text);font-weight:600;letter-spacing:-0.01em;}
.cpt-landing .badge .arw{margin-left:auto;color:var(--dim);font-size:15px;}
.cpt-landing .start-note{max-width:720px;margin:20px auto 0;text-align:center;color:var(--text3);font-size:13.5px;line-height:1.6;}
.cpt-landing .start-note b{color:var(--text2);font-weight:650;}
.cpt-landing .start .free{text-align:center;color:var(--dim);font-size:12.5px;margin-top:14px;}

@media(max-width:820px){.cpt-landing .app-body{min-width:760px;} .cpt-landing .app-scroll{overflow-x:auto;}}
@media(max-width:780px){.cpt-landing .row2,.cpt-landing .row2.rev{grid-template-columns:1fr;gap:26px;} .cpt-landing .row2.rev .fig{order:0;}}
@media(max-width:680px){.cpt-landing .dlz{grid-template-columns:1fr;}}
@media(max-width:680px){.cpt-landing .support-card{align-items:flex-start;flex-direction:column;}.cpt-landing .support-card .action{width:100%;text-align:left;}.cpt-landing .support-card .btn{width:100%;}}
@media(max-width:820px){.cpt-landing .phone{display:none;}}
@media(prefers-reduced-motion:reduce){.cpt-landing .cur{animation:none;}}
`;

export default function Home() {
  return (
    <div className="cpt-landing">
      <style dangerouslySetInnerHTML={{ __html: css }} />

      <section className="hero">
        <div className="container">
          <div className="kick">PC에서 하던 AI 코딩을, 어디서나 그대로</div>
          <h1>내 PC의 코딩 에이전트를 폰에서 이어서</h1>
          <p className="sub">Claude Code·Codex가 돌아가는 PC를 그대로 원격으로 사용하세요. 터미널·채팅·파일·미리보기는 물론, 여러 에이전트에게 나눠 맡긴 일까지 폰에서 지휘합니다.</p>
          <div className="ctas">
            <a className="btn" href="/#start"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" /></svg>다운로드</a>
            <a className="btn ghost" href="/docs">문서 보기</a>
          </div>
          <div className="avail"><b>Apple Silicon Mac · iOS · Android</b> 지원 · Windows 호스트 준비 중 · 개인 무료 &amp; BYO</div>
        </div>

        <div className="shot-bleed">
          <div className="shot-wrap">
            <div className="shot-glow" />
            <div className="app-scroll">
              <div className="app">
                <img className="shot-img" src="/hero-workspace.png" alt="CodingPT 데스크톱 앱 워크스페이스 — 워크스페이스 사이드바, 터미널의 AI 에이전트 세션, 코드 에디터의 실시간 diff, 개발자도구를 연 미리보기" />
              </div>
            </div>
            <div className="phone">
              <img className="phone-shot" src="/mobile-workspace.png" alt="같은 AI 에이전트 세션을 폰에서 이어받아 지휘하는 CodingPT 모바일 앱" />
            </div>
            <p className="cap">실제 CodingPT 워크스페이스 — 터미널의 AI 에이전트를 폰·태블릿에서 그대로 이어받아요</p>
          </div>
        </div>
      </section>

      {/* 신뢰 한 줄 */}
      <div className="container">
        <div className="oneline">
          <span><b>내 머신에서 실행</b> · 소스와 AI 자격증명은 내 PC에</span>
          <span><b>BYO 에이전트</b> · claude·codex 구독 그대로</span>
          <span><b>개인 무료</b> · 외부망 연결과 푸시 포함</span>
        </div>
      </div>

      {/* 기능 행 */}
      <div className="container" id="features">
        <div className="rows">
          <div className="row2">
            <div className="txt">
              <h3>터미널 속 에이전트를, 폰에서 이어받기</h3>
              <p>내 머신에서 돌던 claude·codex 세션이 끊기지 않아요. 폰에서 그대로 이어받아 지휘하고, TUI·특수키까지 손안에서 조작합니다.</p>
              <a className="more" href="/docs">터미널 문서 →</a>
            </div>
            <img className="fig feat-img" src="/feat-terminal.png" alt="폰에서 이어받은 터미널의 AI 에이전트(claude) 세션 — 파일 수정과 diff" />
          </div>

          <div className="row2 rev">
            <div className="txt">
              <h3>복잡한 TUI 대신, 편한 채팅 화면으로</h3>
              <p>claude·codex와 채팅 화면으로 바로 대화해요. 도구 실행과 승인 요청은 카드로 오고, 모델·추론 강도도 고를 수 있어요. 필요하면 같은 대화를 터미널로 이어갑니다.</p>
            </div>
            <div className="fig card chat-demo" aria-label="터미널 에이전트 대화를 모바일 채팅 UI로 보여주는 예시">
              <div className="bubble user">로그인 오류를 찾아서 고쳐줘</div>
              <div className="bubble agent">관련 파일을 확인하고 원인을 찾고 있어요.</div>
              <div className="tool-row">✓ Read · authService.ts</div>
              <div className="tool-row">✓ Edit · login.ts</div>
              <div className="bubble agent">토큰 갱신 오류를 수정했어요. 변경 내용을 확인해 주세요.</div>
            </div>
          </div>

          <div className="row2 rev">
            <div className="txt">
              <h3>에이전트가 짠 코드를, 바로 확인하고 고치기</h3>
              <p>파일 트리에서 바뀐 파일을 바로 보고, diff를 열어 확인하고, 그 자리에서 고쳐요. 파일은 터미널 옆 pane 으로 열리고, 저장하면 내 머신에 즉시 반영돼요.</p>
              <a className="more" href="/docs/editor">파일 문서 →</a>
            </div>
            <img className="fig feat-img" src="/feat-ide.png" alt="에이전트가 만든 변경을 보여주는 코드 에디터의 실시간 git diff" />
          </div>

          <div className="row2">
            <div className="txt">
              <h3>돌아가는 결과를, 실시간으로 미리보기</h3>
              <p>개발 서버를 앱 안 브라우저로. 포트 포워딩으로 진짜 localhost 그대로 — 에이전트가 고치면 화면에 즉시 반영됩니다.</p>
              <a className="more" href="/docs">미리보기 문서 →</a>
            </div>
            <img className="fig feat-img" src="/feat-preview.png" alt="개발자도구로 요소를 검사하는 실시간 미리보기 — 진짜 localhost 렌더" />
          </div>

          <div className="row2">
            <div className="txt">
              <h3>여러 에이전트에게 나눠 맡기고, 폰에서 지켜보기</h3>
              <p>에이전트가 작업자를 띄워 일을 나누고 결과를 모아요. 작업자마다 자기 브랜치·작업 폴더에서 일하고, 질문이 오면 폰에서 답하면 됩니다. 진행 현황과 diff·PR까지 한곳에서 확인해요.</p>
            </div>
            <div className="fig card" aria-label="코디네이터와 작업자 세 명이 일을 나눠 진행하는 사이드바 예시">
              <div className="cbar"><span className="cdot" style={{ background: '#ff5f57' }} /><span className="cdot" style={{ background: '#febc2e' }} /><span className="cdot" style={{ background: '#28c840' }} /><span className="u">shopmate-web · 결제 흐름 개편</span></div>
              <div className="mock">
                <div className="grp">묶음</div>
                <div className="r"><span className="d run" /><span className="nm">코디네이터</span><span className="stt">나누는 중</span></div>
                <div className="r in"><span className="d run" /><span className="nm">작업자 · 결제 API</span><span className="tag">wt/api</span><span className="stt">작업 중</span></div>
                <div className="r in"><span className="d ask" /><span className="nm">작업자 · 장바구니 UI</span><span className="tag">wt/ui</span><span className="stt">질문 대기</span></div>
                <div className="ask-box"><small>작업자 · 장바구니 UI</small>무료배송 기준을 3만원으로 둘까요, 설정값으로 뺄까요?</div>
                <div className="r in"><span className="d done" /><span className="nm">작업자 · 테스트</span><span className="tag">wt/test</span><span className="stt">완료</span></div>
              </div>
            </div>
          </div>

          <div className="row2 rev">
            <div className="txt">
              <h3>할 일을 적어 두면, 에이전트가 이어받기</h3>
              <p>내 작업 목록과 GitHub 이슈를 한 화면에서 보고, 바로 에이전트에게 맡겨요. &quot;매일 아침&quot;, &quot;새 이슈가 오면&quot; 같은 조건을 걸어 두면 알아서 시작하고 끝나면 알려줍니다.</p>
            </div>
            <div className="fig card" aria-label="작업 목록과 자동화 예시">
              <div className="cbar"><span className="cdot" style={{ background: '#ff5f57' }} /><span className="cdot" style={{ background: '#febc2e' }} /><span className="cdot" style={{ background: '#28c840' }} /><span className="u">Tasks</span></div>
              <div className="mock">
                <div className="grp">진행 중</div>
                <div className="r"><span className="d run" /><span className="nm">쿠폰 적용 순서 버그</span><span className="tag">#42 GitHub</span><span className="stt">claude</span></div>
                <div className="grp">할 일</div>
                <div className="r"><span className="d" /><span className="nm">상품 상세 이미지 지연 로딩</span><span className="stt">높음</span></div>
                <div className="r"><span className="d" /><span className="nm">주문 내역 CSV 내보내기</span><span className="stt">보통</span></div>
                <div className="grp">자동화</div>
                <div className="r"><span className="d done" /><span className="nm">매일 09:00 · 의존성 점검 후 요약</span><span className="stt">켜짐</span></div>
              </div>
            </div>
          </div>

          <div className="row2">
            <div className="txt">
              <h3>에이전트가 직접 보고, 눌러 보고, 확인하기</h3>
              <p>에이전트가 미리보기 브라우저를 클릭하고 콘솔을 읽고, 에뮬레이터·시뮬레이터의 앱을 조작하고, 맥 안의 가상 macOS·Linux(에이전트 PC)에서 데스크톱 앱까지 다뤄요. 그 화면을 폰·태블릿에서 그대로 지켜볼 수 있습니다.</p>
            </div>
            <div className="fig card" aria-label="에이전트가 조작하는 세 가지 화면 — 미리보기 브라우저, 모바일 에뮬레이터, 에이전트 PC">
              <div className="cbar"><span className="cdot" style={{ background: '#ff5f57' }} /><span className="cdot" style={{ background: '#febc2e' }} /><span className="cdot" style={{ background: '#28c840' }} /><span className="u">에이전트가 조작하는 화면</span></div>
              <div className="surfaces">
                <div className="sf"><b>미리보기 브라우저</b><span>클릭·입력·콘솔·네트워크·스크린샷</span></div>
                <div className="sf"><b>에뮬레이터</b><span>Android·iOS 앱 화면을 보고 탭</span></div>
                <div className="sf"><b>에이전트 PC</b><span>맥 안의 가상 macOS·Linux 데스크톱</span></div>
                <div className="log"><span className="p">$</span> cpt browser click &quot;결제하기&quot;<br />콘솔 오류 0 · 주문 완료 화면 확인</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 선택 후원 */}
      <section className="pricing-sec" id="pricing">
        <div className="container">
          <div className="pricing-head">
            <h2>개인 사용은 무료예요</h2>
            <p>기기 수와 핵심 기능에 제한이 없습니다. CodingPT가 계속 운영되길 바란다면 선택적으로 후원해 주세요.</p>
          </div>
          <article className="support-card">
            <div className="copy">
              <div className="label">선택 후원</div>
              <div className="title">CodingPT 응원하기</div>
            </div>
            <div className="action">
              <div className="price">월 ₩4,900</div>
              <CheckoutButtons code="supporter" label="후원하기" />
            </div>
          </article>
          <p className="pricing-note">결제는 Lemon Squeezy에서 안전하게 처리됩니다. 해지와 환불은 서로 다른 절차예요. <a href="/legal/refund">환불·취소 정책 보기</a></p>
        </div>
      </section>

      {/* FAQ */}
      <section className="faq-sec">
        <div className="container">
          <h2>자주 묻는 질문</h2>
          <div className="faq">
            <details open><summary>제 코드나 에이전트가 클라우드에서 실행되나요?<span className="ic">+</span></summary><p>아니요. 에이전트와 소스 파일은 내 머신에서 실행·보관됩니다. 외부망에서는 CodingPT 서버가 기기 사이의 연결을 중계하며, 계정의 기기 인증과 E2EE 연결 상태를 앱에서 확인할 수 있어요.</p></details>
            <details><summary>어떤 코딩 에이전트를 쓸 수 있나요?<span className="ic">+</span></summary><p>claude·codex·gemini·aider 등 터미널에서 도는 CLI라면 무엇이든. 구독과 API 키는 그대로 내 머신에 있고, CodingPT가 대신 호출하지 않아요.</p></details>
            <details><summary>데스크톱 에이전트 도구(ADE)와 뭐가 다른가요?<span className="ic">+</span></summary><p>그런 도구는 PC 앞에 앉아서 쓰죠. CodingPT는 내 머신의 그 환경을 폰·태블릿에서 원격으로 이어받게 해, 자리를 떠나도 에이전트를 계속 지휘하게 합니다.</p></details>
            <details><summary>외부에서 연결할 때 CodingPT 서버를 사용하나요?<span className="ic">+</span></summary><p>네. 서로 다른 네트워크에 있는 내 기기를 찾고 연결하기 위해 CodingPT의 관리형 릴레이와 푸시 서버를 사용합니다. 소스 파일과 AI 자격증명은 내 머신에 보관돼요.</p></details>
            <details><summary>정말 무료인가요?<span className="ic">+</span></summary><p>네. 개인 사용은 기기 수와 핵심 기능 제한 없이 무료예요. 월 4,900원 후원은 CodingPT의 개발과 서버 운영을 돕고 싶은 분만 선택하면 됩니다.</p></details>
            <details><summary>다른 서비스에서 내 PC의 에이전트를 쓸 수 있나요?<span className="ic">+</span></summary><p>네. 설정의 외부 연동에서 API 키를 만들면, 내 다른 프로젝트나 서비스가 AI API 키 대신 이 PC의 에이전트와 구독으로 일을 맡길 수 있어요. 승인 요청은 호출한 쪽으로 돌아가고, 키는 언제든 폐기할 수 있습니다.</p></details>
            <details><summary>후원은 어떻게 해지하거나 환불받나요?<span className="ic">+</span></summary><p>결제 후 Lemon Squeezy에서 제공하는 구독 관리 링크로 언제든 다음 결제를 해지할 수 있어요. 환불은 별도 요청 후 주문과 이용 내역을 확인해 처리합니다. 자세한 기준은 <a href="/legal/refund" style={{ color: 'var(--text2)', textDecoration: 'underline' }}>환불·취소 정책</a>에서 확인할 수 있습니다.</p></details>
          </div>
        </div>
      </section>

      {/* 시작하기 (단일 다운로드) */}
      <section className="start" id="start">
        <div className="container">
          <div className="head">
            <h2>2분이면 시작해요</h2>
            <p>내 머신과 모바일에 앱을 설치하고 같은 계정으로 로그인하면, 인증을 거쳐 내 기기끼리 프라이빗하게 연결돼요.</p>
          </div>

          <div className="dlz">
            <div className="dlgroup">
              <div className="dlh">데스크톱</div>
              <a className="badge" href="https://objectstore.ghmate.com/codingpt/common/downloads/CodingPT.dmg">
                <span className="ic"><svg width="19" height="23" viewBox="0 0 20 24" fill="currentColor" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" /></svg></span>
                <span className="tt"><small>다운로드 · .dmg</small><b>macOS</b></span>
                <span className="arw">↓</span>
              </a>
              <a className="badge off" aria-disabled="true">
                <span className="ic"><svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5.4 10.6 4.3v6.9H3zM11.6 4.1 21 2.8v8.4h-9.4zM3 12.8h7.6v6.9L3 18.6zM11.6 12.8H21v8.4l-9.4-1.3z" /></svg></span>
                <span className="tt"><small>준비 중</small><b>Windows</b></span>
              </a>
            </div>
            <div className="dlgroup">
              <div className="dlh">모바일 · 태블릿</div>
              <a className="badge" href={APP_STORE_URL}>
                <span className="ic"><svg width="19" height="23" viewBox="0 0 20 24" fill="currentColor" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" /></svg></span>
                <span className="tt"><small>App Store</small><b>iOS · iPadOS</b></span>
                <span className="arw">→</span>
              </a>
              <a className="badge" href="https://play.google.com/store/apps/details?id=com.ghmate.codingpt.app">
                <span className="ic"><svg width="18" height="20" viewBox="0 0 17 19" aria-hidden="true"><path fill="#00C3FF" d="M0 1.1 0 17.9 8.9 9.5Z" /><path fill="#FF3D47" d="M0 1.1 11.6 7.6 8.9 9.5Z" /><path fill="#00E676" d="M0 17.9 11.6 11.4 8.9 9.5Z" /><path fill="#FFCE00" d="M8.9 9.5 11.6 7.6 15 9.5 11.6 11.4Z" /></svg></span>
                <span className="tt"><small>Google Play</small><b>Android</b></span>
                <span className="arw">→</span>
              </a>
            </div>
          </div>

          <p className="start-note">같은 계정으로 로그인하면 내 머신이 자동으로 나타납니다. 앱의 간단한 인증 안내를 마치면 <b>내 기기끼리 열쇠를 나눠 가진 프라이빗 연결</b>이 완성되고, 원격 제어 요청은 종단 간 암호화돼요.</p>
          <div className="free">개인 무료 · 외부망 연결과 푸시 포함 · BYO 에이전트</div>
        </div>
      </section>
    </div>
  );
}
