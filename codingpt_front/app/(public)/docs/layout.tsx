import DocsSidebar from '@/components/DocsSidebar';

// 문서 라우트 셸 — 좌측 사이드바 + 우측 본문 2컬럼. 모든 CSS 는 .cpt-docs 로 스코프해
// globals.css 를 건드리지 않고 샘플 문서 디자인 토큰/마크업을 그대로 포팅한다.
const css = `
.cpt-docs{
  --border-2:#252C3A;
  --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  display:grid;grid-template-columns:240px 1fr;gap:0;min-height:80vh;
}
@media(max-width:820px){
  .cpt-docs{grid-template-columns:1fr;}
  .cpt-docs .dx-side{display:none;}
}

/* 사이드바 */
.cpt-docs .dx-side{border-right:1px solid var(--border);padding:30px 18px 60px;position:sticky;top:78px;align-self:start;max-height:calc(100vh - 78px);overflow-y:auto;}
.cpt-docs .dx-grp{margin-bottom:22px;}
.cpt-docs .dx-gt{font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--dim);font-weight:650;margin-bottom:8px;padding-left:10px;}
.cpt-docs .dx-link{display:block;padding:7px 10px;border-radius:8px;color:var(--text3);font-size:14px;font-weight:600;}
.cpt-docs .dx-link:hover{background:var(--hover);color:var(--text);}
.cpt-docs .dx-link.on{background:var(--hover);color:var(--text);box-shadow:inset 2px 0 0 var(--accent);}

/* 본문 컨테이너 */
.cpt-docs .dx-main{padding:36px 40px 80px;min-width:0;max-width:760px;}
@media(max-width:560px){.cpt-docs .dx-main{padding:28px 22px 60px;}}

/* 본문 요소 (평범한 h1/h2/p/ul/li/code 만 써도 스타일 적용) */
.cpt-docs h1{font-size:30px;font-weight:780;letter-spacing:-0.03em;}
.cpt-docs h2{font-size:19px;font-weight:730;margin:36px 0 0;letter-spacing:-0.02em;}
.cpt-docs p{color:var(--text2);font-size:15px;line-height:1.75;margin:12px 0 0;}
.cpt-docs ul,.cpt-docs ol{color:var(--text2);font-size:15px;line-height:1.8;margin:12px 0 0;padding-left:20px;}
.cpt-docs li{margin:0;}
.cpt-docs code{font-family:var(--mono);color:var(--accent);}

/* 헬퍼 */
.cpt-docs .dx-crumb{font-size:13px;color:var(--dim);margin-bottom:12px;}
.cpt-docs .dx-crumb b{color:var(--text3);font-weight:600;}
.cpt-docs .dx-lead{color:var(--text3);font-size:16px;line-height:1.7;margin-top:12px;}
.cpt-docs .dx-callout{border:1px solid var(--border-2);background:var(--elevated);border-radius:10px;padding:14px 16px;margin-top:18px;font-size:14px;color:var(--text2);line-height:1.6;display:flex;gap:10px;}
.cpt-docs .dx-callout .dx-cb{color:var(--accent);font-weight:700;white-space:nowrap;}
.cpt-docs .dx-callout a{color:var(--text);border-bottom:1px solid var(--dim);}
.cpt-docs .dx-code{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;font-family:var(--mono);font-size:13px;color:var(--text2);overflow-x:auto;line-height:1.8;margin-top:16px;}
.cpt-docs .dx-code .c{color:#5D6E63;}
.cpt-docs .dx-code .p{color:var(--accent);}

/* 문서 하단 이전/다음 */
.cpt-docs .dx-docnav{display:flex;justify-content:space-between;gap:12px;margin-top:46px;padding-top:22px;border-top:1px solid var(--border);}
.cpt-docs .dx-docnav a{flex:1;border:1px solid var(--border);border-radius:10px;padding:14px 16px;color:var(--text2);}
.cpt-docs .dx-docnav a:hover{background:var(--elevated);}
.cpt-docs .dx-nav-lbl{font-size:11.5px;color:var(--dim);}
.cpt-docs .dx-nav-tt{font-weight:680;margin-top:3px;}

/* 작동 원리 다이어그램 */
.cpt-docs .dx-relay{display:flex;align-items:center;justify-content:center;margin-top:22px;flex-wrap:wrap;}
.cpt-docs .dx-node{border:1px solid var(--border-2);background:var(--elevated);border-radius:11px;padding:15px 16px;text-align:center;min-width:112px;}
.cpt-docs .dx-node .t{font-weight:680;font-size:13.5px;}
.cpt-docs .dx-node .s{font-size:11.5px;color:var(--dim);margin-top:3px;}
.cpt-docs .dx-node-mid .t{color:var(--accent);}
.cpt-docs .dx-wire{color:var(--dim);font-family:var(--mono);padding:0 12px;font-size:12px;white-space:nowrap;}

/* 인덱스 카드 그리드 */
.cpt-docs .dx-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:26px;}
.cpt-docs .dx-card{border:1px solid var(--border);background:var(--surface);border-radius:12px;padding:18px;display:block;transition:border-color .15s ease,transform .05s ease;}
.cpt-docs .dx-card:hover{border-color:var(--dim);transform:translateY(-1px);}
.cpt-docs .dx-card .k{font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--dim);font-weight:650;}
.cpt-docs .dx-card .t{font-size:16px;font-weight:720;color:var(--text);margin-top:6px;}
.cpt-docs .dx-card .d{font-size:13.5px;color:var(--text3);line-height:1.6;margin-top:6px;}
`;

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="cpt-docs">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <DocsSidebar />
      <main className="dx-main">{children}</main>
    </div>
  );
}
