// 앱(codingpt_app) src/components/module/ide/ideIcons.tsx 를 웹 SVG로 1:1 포팅.
// VS Code 스타일 상단바 아이콘 — 비활성=외곽선, 활성(filled)=채움. 채움 시 내부는 KO 로 knock-out.

type IconProps = { size?: number; color?: string; filled?: boolean };
const KO = '#11151F';

// 좌측 사이드바(탐색기) 토글
export const SidebarIcon = ({ size = 22, color = '#fff', filled = false }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x={3} y={4} width={18} height={16} rx={2} stroke={color} strokeWidth={1.6} fill="none" />
    {filled
      ? <rect x={4} y={5} width={5} height={14} rx={1} fill={color} />
      : <line x1={9} y1={4} x2={9} y2={20} stroke={color} strokeWidth={1.6} />}
  </svg>
);

// 터미널 토글
export const TerminalIcon = ({ size = 22, color = '#fff', filled = false }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x={3} y={4} width={18} height={16} rx={2} stroke={color} strokeWidth={1.6} fill={filled ? color : 'none'} />
    <path d="M7 9l3 3-3 3" stroke={filled ? KO : color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    <line x1={12} y1={16} x2={16} y2={16} stroke={filled ? KO : color} strokeWidth={1.6} strokeLinecap="round" />
  </svg>
);

// 브라우저(프리뷰)
export const BrowserIcon = ({ size = 22, color = '#fff', filled = false }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx={12} cy={12} r={9} stroke={color} strokeWidth={1.6} fill={filled ? color : 'none'} />
    <circle cx={12} cy={12} r={3.2} stroke={filled ? KO : color} strokeWidth={1.6} />
    <path d="M12 8.8h8M5.4 9.5l4 5.2M14.6 14.7l-4 0.2" stroke={filled ? KO : color} strokeWidth={1.6} strokeLinecap="round" />
  </svg>
);

// 설정 목록(List) 토글
export const ListIcon = ({ size = 22, color = '#fff' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <line x1={9} y1={6} x2={20} y2={6} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    <line x1={9} y1={12} x2={20} y2={12} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    <line x1={9} y1={18} x2={20} y2={18} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    <circle cx={4.5} cy={6} r={1.4} fill={color} />
    <circle cx={4.5} cy={12} r={1.4} fill={color} />
    <circle cx={4.5} cy={18} r={1.4} fill={color} />
  </svg>
);

// 저장(플로피)
export const SaveIcon = ({ size = 16, color = '#fff' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" stroke={color} strokeWidth={1.6} fill="none" strokeLinejoin="round" />
    <path d="M8 3v5h6V3" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    <rect x={7} y={13} width={10} height={6} rx={1} stroke={color} strokeWidth={1.6} fill="none" />
  </svg>
);

// 재생/실행 (삼각형)
export const PlayIcon = ({ size = 16, color = '#fff' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M7 5.5l11 6.5-11 6.5z" fill={color} />
  </svg>
);

// 넓게 보기(전체화면) 토글
export const FullscreenIcon = ({ size = 16, color = '#fff', expanded = false }: IconProps & { expanded?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    {expanded
      ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
      : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />}
  </svg>
);

// 채팅 토글(우측 채팅 패널) — 좌측 패널 채움 형태 재사용
export const ChatPanelIcon = ({ size = 22, color = '#fff', filled = false }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x={3} y={4} width={18} height={16} rx={2} stroke={color} strokeWidth={1.6} fill="none" />
    {filled
      ? <rect x={4} y={5} width={5} height={14} rx={1} fill={color} />
      : <line x1={9} y1={4} x2={9} y2={20} stroke={color} strokeWidth={1.6} />}
  </svg>
);
