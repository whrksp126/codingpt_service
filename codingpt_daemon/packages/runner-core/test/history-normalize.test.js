'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeResizePromptHistory } = require('../pty');

test('resize 재도장 프롬프트만 접고 동일한 일반 출력은 보존한다', () => {
  const prompt = '\x1b[32muser@host\x1b[0m ~/work/project main';
  const input = ['same log', 'same log', prompt, prompt, prompt, 'result', prompt, ''].join('\n');
  assert.equal(
    normalizeResizePromptHistory(input),
    ['same log', 'same log', prompt, 'result', prompt].join('\n'),
  );
});
