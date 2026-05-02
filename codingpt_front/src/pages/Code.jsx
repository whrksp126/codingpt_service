import React, { useState, useEffect, useRef } from 'react';
import Prism from 'prismjs';
import 'prismjs/themes/prism.css';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-markup';
import codeFillGap from '../dummys/codeFillGap.json';
import { useParams } from 'react-router-dom';

const Code = () => {
  const { id } = useParams();
  const [code, setCode] = useState('');

  useEffect(() => {
    const code = codeFillGap[id];
    setCode(code);
  }, [id]);

  return (
    <div style={{ flex: 1, position: 'relative' }}>
      <style>{`
      body {
        height: 100vh;
        background: #272822;
      }
      pre {
          background: #272822;
          color: #fff;
          padding: 1rem;
          overflow-x: auto;
          font-size: 15px;
          font-family: 'Fira Mono', 'Menlo', monospace;
        }
        input.blank {
          width: auto;
          padding: 0 4px 0;
          border-radius: 6px;
          border: 1px solid #E5E5E5;
          outline: none;
          color: #4B4B4B;
          background: #fff;
          font-weight: 700;
          text-align: center;
        }
        input.blank.focus {
          background: #DDF4FF;
          border: 1px solid #84D8FF;
        }
        input.blank.correct {
          background: #D7FFB8b3;
          border: 1px solid #58CC02;
        }        
        input.blank.incorrect {
          background: #fee0e2b3;
          border: 1px solid #FE4C4A;
        }
      `}</style>
      <div className="">
        <pre>
          <code dangerouslySetInnerHTML={{ __html: code }} />
        </pre>
      </div>
    </div>
  );
}

export default Code;
