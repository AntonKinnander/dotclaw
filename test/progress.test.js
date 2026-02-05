import { test } from 'node:test';
import assert from 'node:assert/strict';

import { distPath, importFresh } from './test-helpers.js';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('parseProgressMessages handles JSON and pipe formats', async () => {
  const { parseProgressMessages, DEFAULT_PROGRESS_MESSAGES } = await importFresh(distPath('progress.js'));

  const jsonMessages = parseProgressMessages('["one", "two"]', DEFAULT_PROGRESS_MESSAGES);
  assert.deepEqual(jsonMessages, ['one', 'two']);

  const pipeMessages = parseProgressMessages('first | second | third', DEFAULT_PROGRESS_MESSAGES);
  assert.deepEqual(pipeMessages, ['first', 'second', 'third']);

  const fallback = parseProgressMessages('', DEFAULT_PROGRESS_MESSAGES);
  assert.deepEqual(fallback, DEFAULT_PROGRESS_MESSAGES);
});

test('formatProgressWithPlan uses steps and falls back to stage text', async () => {
  const { formatProgressWithPlan, formatPlanStepList, DEFAULT_PROGRESS_STAGES } = await importFresh(distPath('progress.js'));

  const message = formatProgressWithPlan({
    steps: ['Search for sources', 'Analyze findings', 'Draft response'],
    currentStep: 2,
    stage: 'planning'
  });
  assert.ok(message.includes('step 2/3'));
  assert.ok(message.includes('-> Analyze findings'));

  const fallback = formatProgressWithPlan({ steps: [], stage: 'planning' });
  assert.equal(fallback, DEFAULT_PROGRESS_STAGES.planning);

  const list = formatPlanStepList({ steps: ['One', 'Two'], currentStep: 1 });
  assert.ok(list.split('\n')[0].startsWith('->'));
});

test('createProgressNotifier sends limited progress updates', async () => {
  const { createProgressNotifier } = await importFresh(distPath('progress.js'));

  const sent = [];
  const notifier = createProgressNotifier({
    enabled: true,
    initialDelayMs: 5,
    intervalMs: 10,
    maxUpdates: 2,
    messages: ['first', 'second', 'third'],
    send: async (text) => {
      sent.push(text);
    }
  });

  notifier.start();
  await wait(40);
  notifier.stop();

  assert.deepEqual(sent, ['first', 'second']);
});

test('createProgressManager sends stage updates and respects max updates', async () => {
  const { createProgressManager } = await importFresh(distPath('progress.js'));

  const sent = [];
  const manager = createProgressManager({
    enabled: true,
    initialDelayMs: 5,
    intervalMs: 10,
    maxUpdates: 2,
    messages: ['fallback'],
    stageMessages: { planning: 'Planning now.' },
    stageThrottleMs: 0,
    send: async (text) => {
      sent.push(text);
    }
  });

  manager.start();
  manager.setStage('planning');
  await wait(20);
  manager.stop();

  assert.equal(sent[0], 'Planning now.');
  assert.ok(sent.length <= 2);
});
