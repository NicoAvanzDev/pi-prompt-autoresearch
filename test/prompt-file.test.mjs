import test from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_FILE_NAME } from '../prompt-file.ts';

test('PROMPT_FILE_NAME has the expected value', () => {
  assert.equal(PROMPT_FILE_NAME, 'AUTORESEARCH_PROMPT.md');
});
