// 앱 src/components/module/ide/fileTypeIcons.tsx 를 웹 SVG로 1:1 포팅.
// VS Code "Material Icon Theme" 스타일 — 접힌 모서리 문서 + 언어별 색/엠블럼.

const extOf = (name: string) => (name.split('.').pop() || '').toLowerCase();

type Spec = { base: string; fold: string; label?: string; dark?: boolean; image?: boolean };

const SPEC: Record<string, Spec> = {
  html: { base: '#E44D26', fold: '#B5391B', label: '<>' },
  htm: { base: '#E44D26', fold: '#B5391B', label: '<>' },
  css: { base: '#1572B6', fold: '#0E4F81', label: '#' },
  scss: { base: '#CD6799', fold: '#9E4E76', label: '#' },
  js: { base: '#F0DB4F', fold: '#C9B400', label: 'JS', dark: true },
  mjs: { base: '#F0DB4F', fold: '#C9B400', label: 'JS', dark: true },
  cjs: { base: '#F0DB4F', fold: '#C9B400', label: 'JS', dark: true },
  json: { base: '#F0DB4F', fold: '#C9B400', label: '{}', dark: true },
  ts: { base: '#3178C6', fold: '#235A97', label: 'TS' },
  tsx: { base: '#3178C6', fold: '#235A97', label: 'TSX' },
  jsx: { base: '#61C7E8', fold: '#3FA3C4', label: 'JSX', dark: true },
  py: { base: '#3776AB', fold: '#285A85', label: 'PY' },
  java: { base: '#E76F00', fold: '#B45600', label: 'JV' },
  rb: { base: '#CC342D', fold: '#9E2822', label: 'RB' },
  php: { base: '#777BB4', fold: '#565A8C', label: 'PHP' },
  sh: { base: '#4EAA25', fold: '#37791A', label: 'SH', dark: true },
  bash: { base: '#4EAA25', fold: '#37791A', label: 'SH', dark: true },
  go: { base: '#00ADD8', fold: '#0086A8', label: 'GO', dark: true },
  c: { base: '#5C6BC0', fold: '#3F4D9E', label: 'C' },
  cpp: { base: '#00599C', fold: '#003F70', label: 'C++' },
  cc: { base: '#00599C', fold: '#003F70', label: 'C++' },
  cxx: { base: '#00599C', fold: '#003F70', label: 'C++' },
  h: { base: '#5C6BC0', fold: '#3F4D9E', label: 'H' },
  hpp: { base: '#00599C', fold: '#003F70', label: 'H' },
  rs: { base: '#DEA584', fold: '#B07F60', label: 'RS', dark: true },
  kt: { base: '#7F52FF', fold: '#5E37CC', label: 'KT' },
  kts: { base: '#7F52FF', fold: '#5E37CC', label: 'KT' },
  cs: { base: '#68217A', fold: '#4C1759', label: 'C#' },
  md: { base: '#42A5F5', fold: '#2E7CC0', label: 'M↓' },
  xml: { base: '#8E9CA8', fold: '#6B7882', label: '<>' },
  svg: { base: '#FFB13B', fold: '#CC8A2E', label: 'SVG' },
  sql: { base: '#26A69A', fold: '#1B746B', label: 'SQL' },
  txt: { base: '#90A4AE', fold: '#6B7B85', label: 'T' },
  png: { base: '#26A69A', fold: '#1B746B', image: true },
  jpg: { base: '#26A69A', fold: '#1B746B', image: true },
  jpeg: { base: '#26A69A', fold: '#1B746B', image: true },
  gif: { base: '#26A69A', fold: '#1B746B', image: true },
  webp: { base: '#26A69A', fold: '#1B746B', image: true },
  bmp: { base: '#26A69A', fold: '#1B746B', image: true },
  ico: { base: '#26A69A', fold: '#1B746B', image: true },
};

const DEFAULT: Spec = { base: '#90A4AE', fold: '#6B7B85', label: '' };

export const FileTypeIcon = ({ name, size = 16 }: { name: string; size?: number }) => {
  const spec = SPEC[extOf(name)] || DEFAULT;
  const textColor = spec.dark ? '#222' : '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, display: 'block' }}>
      <path d="M6 2.5h7.4L19 8.1V20.4a1.3 1.3 0 0 1-1.3 1.3H6A1.3 1.3 0 0 1 4.7 20.4V3.8A1.3 1.3 0 0 1 6 2.5Z" fill={spec.base} />
      <path d="M13.4 2.5 19 8.1h-4.3a1.3 1.3 0 0 1-1.3-1.3z" fill={spec.fold} />
      {spec.image ? (
        <g>
          <circle cx={9.2} cy={13} r={1.5} fill="#fff" />
          <polygon points="6,18.5 10,14.5 12.5,17 15,13.5 17.5,18.5" fill="#fff" />
        </g>
      ) : spec.label ? (
        <text x={11.6} y={17} fill={textColor} fontSize={spec.label.length >= 3 ? 5.4 : 7} fontWeight={700} textAnchor="middle">{spec.label}</text>
      ) : null}
    </svg>
  );
};

export default FileTypeIcon;
