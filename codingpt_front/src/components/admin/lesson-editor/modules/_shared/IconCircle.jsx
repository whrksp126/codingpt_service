import * as SvgIcons from '@/assets/svgIcons';

const warned = new Set();
const warnUnknown = (name) => {
  if (warned.has(name)) return;
  warned.add(name);
  // eslint-disable-next-line no-console
  console.warn(`[IconCircle] Unknown SVG icon: "${name}" (codingpt_front/src/assets/svgIcons.jsx)`);
};

// RN ParagraghV2/HighlightParagraph 의 원형 아이콘 영역과 시각 매칭.
// icon.name 은 codingpt_app/src/assets/SvgIcon.tsx 의 컴포넌트 이름 (예: "KeyReturn", "Target")
// 웹은 동일 이름의 미러를 codingpt_front/src/assets/svgIcons.jsx 에서 lookup.
const IconCircle = ({ icon, align = 'center' }) => {
  if (!icon?.name) return null;
  const {
    name,
    size = 32,
    fill = '#08875D',
    backgroundSize = 64,
    backgroundColor = '#EDFDF8',
  } = icon;
  const Icon = SvgIcons[name];
  if (!Icon) warnUnknown(name);

  const wrapperStyle = {
    marginTop: 40,
    marginBottom: 20,
    display: 'flex',
    justifyContent: align === 'left' ? 'flex-start' : 'center',
    width: '100%',
  };
  const circleStyle = {
    width: backgroundSize,
    height: backgroundSize,
    backgroundColor,
    borderRadius: '9999px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div style={wrapperStyle}>
      <div style={circleStyle}>
        {Icon && <Icon width={size} height={size} fill={fill} />}
      </div>
    </div>
  );
};

export default IconCircle;
