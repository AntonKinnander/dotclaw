import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

function makeMessage(content) {
  return {
    id: '1',
    chat_jid: 'chat-1',
    sender: 'user-1',
    sender_name: 'Alex',
    content,
    timestamp: new Date().toISOString()
  };
}

test('routeRequest chooses fast for greetings', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-router-'));
  await withTempHome(tempDir, async () => {
    const { routeRequest } = await importFresh(distPath('request-router.js'));
    const decision = routeRequest({
      prompt: 'Hi',
      lastMessage: makeMessage('Hi'),
      recentMessages: [makeMessage('Hi')],
      isGroup: false,
      chatType: 'private'
    });
    assert.equal(decision.profile, 'fast');
    assert.equal(decision.recallMaxResults, 0);
    assert.equal(decision.responseValidationMaxRetries, 0);
  });
});

test('routeRequest chooses background for research prompts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-router-'));
  await withTempHome(tempDir, async () => {
    const { routeRequest } = await importFresh(distPath('request-router.js'));
    const decision = routeRequest({
      prompt: 'Research the latest trends in agent orchestration and summarize.',
      lastMessage: makeMessage('Research the latest trends in agent orchestration and summarize.'),
      recentMessages: [makeMessage('Research the latest trends in agent orchestration and summarize.')],
      isGroup: false,
      chatType: 'private'
    });
    assert.equal(decision.profile, 'background');
    assert.equal(decision.shouldBackground, true);
  });
});

test('routeRequest respects routing disabled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-router-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: {
      routing: { enabled: false }
    }
  }, null, 2));
  await withTempHome(tempDir, async () => {
    const { routeRequest } = await importFresh(distPath('request-router.js'));
    const decision = routeRequest({
      prompt: 'Build a dashboard',
      lastMessage: makeMessage('Build a dashboard'),
      recentMessages: [makeMessage('Build a dashboard')],
      isGroup: false,
      chatType: 'private'
    });
    assert.equal(decision.profile, 'standard');
  });
});
