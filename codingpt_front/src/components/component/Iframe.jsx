import PropTypes from 'prop-types';
import { useEffect, useRef } from 'react';

const Iframe = ({ src, content, className = "w-full h-full" }) => {
  const iframeRef = useRef(null);


  return (
    <iframe
      ref={iframeRef}
      src={src}
      srcDoc={content}
      className={className}
      sandbox="allow-scripts allow-same-origin"
      title="Dynamic Iframe"
    />
  );
};

Iframe.propTypes = {
  src: PropTypes.string,
  content: PropTypes.string,
  className: PropTypes.string
};

export default Iframe;
