import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { distPath } from './test-helpers.js';

test('dotclaw status --id targets a specific instance home', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-cli-flags-'));
  const baseHome = path.join(tempDir, '.dotclaw');
  fs.mkdirSync(baseHome, { recursive: true });

  const cliPath = distPath('cli.js');
  const result = spawnSync(process.execPath, [cliPath, 'status', '--id', 'dev'], {
    env: {
      ...process.env,
      DOTCLAW_HOME: baseHome,
      HOME: tempDir
    },
    encoding: 'utf-8'
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(`DOTCLAW_HOME: ${path.join(tempDir, '.dotclaw-dev')}`));
  assert.ok(result.stdout.includes('Instance ID: dev'));
});

test('dotclaw status --all runs for default and discovered instances', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-cli-flags-'));
  const baseHome = path.join(tempDir, '.dotclaw');
  const devHome = path.join(tempDir, '.dotclaw-dev');
  fs.mkdirSync(baseHome, { recursive: true });
  fs.mkdirSync(devHome, { recursive: true });

  const cliPath = distPath('cli.js');
  const result = spawnSync(process.execPath, [cliPath, 'status', '--all'], {
    env: {
      ...process.env,
      DOTCLAW_HOME: baseHome,
      HOME: tempDir
    },
    encoding: 'utf-8'
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(`DOTCLAW_HOME: ${baseHome}`));
  assert.ok(result.stdout.includes(`DOTCLAW_HOME: ${devHome}`));
});
