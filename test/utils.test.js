import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSafeGroupFolder, loadModelConfig, isModelAllowed } from '../dist/utils.js';

test('isSafeGroupFolder rejects invalid names and traversal', () => {
  const base = '/tmp/groups';
  assert.equal(isSafeGroupFolder('valid-name', base), true);
  assert.equal(isSafeGroupFolder('INVALID', base), false);
  assert.equal(isSafeGroupFolder('../escape', base), false);
});

test('loadModelConfig applies defaults and sanitizes allowlist', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-model-'));
  const filePath = path.join(tempDir, 'model.json');
  fs.writeFileSync(filePath, JSON.stringify({
    model: 'moonshotai/kimi-k2.5',
    allowlist: ['moonshotai/kimi-k2.5', '', 123],
    updated_at: '2026-02-01T00:00:00.000Z'
  }));

  const config = loadModelConfig(filePath, 'default-model');
  assert.equal(config.model, 'moonshotai/kimi-k2.5');
  assert.deepEqual(config.allowlist, ['moonshotai/kimi-k2.5']);
  assert.equal(config.updated_at, '2026-02-01T00:00:00.000Z');
  assert.equal(isModelAllowed(config, 'moonshotai/kimi-k2.5'), true);
  assert.equal(isModelAllowed(config, 'openai/gpt-4.1-mini'), false);
});
