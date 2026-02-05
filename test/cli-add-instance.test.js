import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { distPath } from './test-helpers.js';

test('dotclaw add-instance creates isolated home and runtime config', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-cli-'));
  const baseHome = path.join(tempDir, '.dotclaw');
  const baseConfigDir = path.join(baseHome, 'config');
  fs.mkdirSync(baseConfigDir, { recursive: true });
  fs.writeFileSync(path.join(baseConfigDir, 'runtime.json'), JSON.stringify({
    host: {
      metrics: {
        port: 3001,
        enabled: true
      }
    }
  }, null, 2));

  const cliPath = distPath('cli.js');
  const result = spawnSync(process.execPath, [cliPath, 'add-instance', 'dev'], {
    env: {
      ...process.env,
      DOTCLAW_HOME: baseHome,
      HOME: tempDir,
      DOTCLAW_TEST_MODE: '1'
    },
    stdio: 'pipe'
  });

  assert.equal(result.status, 0);

  const instanceHome = path.join(tempDir, '.dotclaw-dev');
  const runtimePath = path.join(instanceHome, 'config', 'runtime.json');

  assert.equal(fs.existsSync(instanceHome), true);
  assert.equal(fs.existsSync(runtimePath), true);

  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
  assert.equal(runtime.host.container.instanceId, 'dev');
  assert.equal(typeof runtime.host.metrics.port, 'number');
  assert.equal(runtime.host.metrics.port > 3001, true);
});
