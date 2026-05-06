import './rnHtml.css';

const RawHtmlPreview = ({ html, className = '' }) => {
  if (!html) return null;
  return (
    <div
      className={'rn-html ' + className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default RawHtmlPreview;
