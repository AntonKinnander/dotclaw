import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

/**
 * Tests for nightly recap & journal workflow.
 *
 * Tests the database functions that back the daily planning features:
 * - createDailyJournal / getDailyJournalByDate
 * - getActiveDailyTasks
 * - getLatestDailyJournal (used by planning context)
 *
 * These tests verify the DB layer works correctly for the nightly recap
 * and daily planning workflows.
 */

test('createDailyJournal creates a new journal entry', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { createDailyJournal, getDailyJournalByDate } = await importFresh(distPath('db.js'));
    const testDate = '2026-02-18';

    const journalId = createDailyJournal({
      group_folder: 'test-group',
      date: testDate,
      tasks_completed: ['task-1', 'task-2'],
      tasks_in_progress: ['task-3'],
      sentiment: 'positive',
      biggest_success: 'Fixed auth bug',
      focus_tomorrow: 'Write docs'
    });

    assert.ok(journalId);

    const journal = getDailyJournalByDate('test-group', testDate);
    assert.ok(journal);
    assert.equal(journal.id, journalId);
    assert.equal(journal.sentiment, 'positive');
    assert.equal(journal.biggest_success, 'Fixed auth bug');
    assert.equal(journal.focus_tomorrow, 'Write docs');

    const tasksCompleted = JSON.parse(journal.tasks_completed || '[]');
    assert.deepEqual(tasksCompleted, ['task-1', 'task-2']);
  });
});

test('createDailyJournal updates existing journal entry for same date', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { createDailyJournal, getDailyJournalByDate } = await importFresh(distPath('db.js'));
    const testDate = '2026-02-19';

    // Create initial journal
    createDailyJournal({
      group_folder: 'test-group',
      date: testDate,
      sentiment: 'neutral',
      focus_tomorrow: 'Initial focus'
    });

    // Update with new data
    createDailyJournal({
      group_folder: 'test-group',
      date: testDate,
      sentiment: 'negative',
      biggest_error: 'Deployment failed',
      focus_tomorrow: 'Fix deployment'
    });

    const journal = getDailyJournalByDate('test-group', testDate);
    assert.equal(journal.sentiment, 'negative');
    assert.equal(journal.biggest_error, 'Deployment failed');
    assert.equal(journal.focus_tomorrow, 'Fix deployment');
  });
});

test('getActiveDailyTasks returns non-completed tasks', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { createDailyTask, getActiveDailyTasks } = await importFresh(distPath('db.js'));

    // Create test tasks
    createDailyTask({
      group_folder: 'test-group',
      title: 'Test Task 1',
      status: 'pending'
    });
    createDailyTask({
      group_folder: 'test-group',
      title: 'Test Task 2',
      status: 'in_progress'
    });
    createDailyTask({
      group_folder: 'test-group',
      title: 'Completed Task',
      status: 'completed'
    });
    createDailyTask({
      group_folder: 'test-group',
      title: 'Cancelled Task',
      status: 'cancelled'
    });

    const tasks = getActiveDailyTasks('test-group');
    // getActiveDailyTasks returns all non-archived tasks (pending, in_progress, completed, cancelled)
    assert.equal(tasks.length, 4);

    const titles = tasks.map(t => t.title);
    assert.ok(titles.includes('Test Task 1'));
    assert.ok(titles.includes('Test Task 2'));
    assert.ok(titles.includes('Completed Task'));
    assert.ok(titles.includes('Cancelled Task'));
  });
});

test('getLatestDailyJournal returns most recent journal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { createDailyJournal, getLatestDailyJournal } = await importFresh(distPath('db.js'));

    // Use a unique group for this test to avoid conflicts
    const groupName = 'test-group-' + Date.now();

    // Create journals for multiple dates
    createDailyJournal({
      group_folder: groupName,
      date: '2026-02-15',
      sentiment: 'neutral',
      focus_tomorrow: 'Day 15 focus'
    });

    createDailyJournal({
      group_folder: groupName,
      date: '2026-02-17',
      sentiment: 'positive',
      tasks_completed: ['done-1'],
      focus_tomorrow: 'Day 17 focus'
    });

    createDailyJournal({
      group_folder: groupName,
      date: '2026-02-16',
      sentiment: 'negative',
      focus_tomorrow: 'Day 16 focus'
    });

    const latest = getLatestDailyJournal(groupName);
    assert.ok(latest);
    assert.equal(latest.date, '2026-02-17');
    assert.equal(latest.sentiment, 'positive');
    assert.equal(latest.focus_tomorrow, 'Day 17 focus');

    const tasksCompleted = JSON.parse(latest.tasks_completed || '[]');
    assert.deepEqual(tasksCompleted, ['done-1']);
  });
});

test('getLatestDailyJournal returns undefined when no journals exist', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { getLatestDailyJournal } = await importFresh(distPath('db.js'));

    const latest = getLatestDailyJournal('nonexistent-group');
    assert.equal(latest, undefined);
  });
});

test('listDailyJournals returns journals in date order', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { createDailyJournal, listDailyJournals } = await importFresh(distPath('db.js'));

    // Use a unique group for this test to avoid conflicts
    const groupName = 'test-group-list-' + Date.now();

    // Create journals
    createDailyJournal({
      group_folder: groupName,
      date: '2026-02-15',
      sentiment: 'neutral'
    });

    createDailyJournal({
      group_folder: groupName,
      date: '2026-02-17',
      sentiment: 'positive'
    });

    createDailyJournal({
      group_folder: groupName,
      date: '2026-02-16',
      sentiment: 'negative'
    });

    const journals = listDailyJournals(groupName, 10);
    assert.equal(journals.length, 3);
    // Should be ordered by date DESC
    assert.equal(journals[0].date, '2026-02-17');
    assert.equal(journals[1].date, '2026-02-16');
    assert.equal(journals[2].date, '2026-02-15');
  });
});

test('createDailyJournal handles all optional fields', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { createDailyJournal, getDailyJournalByDate } = await importFresh(distPath('db.js'));
    const testDate = '2026-02-20';

    const journalId = createDailyJournal({
      group_folder: 'test-group',
      date: testDate,
      tasks_completed: ['task-a', 'task-b', 'task-c'],
      tasks_in_progress: ['task-d'],
      sentiment: 'positive',
      biggest_success: 'Launched feature',
      biggest_error: 'Minor typo in docs',
      focus_tomorrow: 'Write tests',
      diary_entry: 'Today was productive. Fixed bugs and shipped features.'
    });

    const journal = getDailyJournalByDate('test-group', testDate);
    assert.ok(journal);
    assert.equal(journal.sentiment, 'positive');
    assert.equal(journal.biggest_success, 'Launched feature');
    assert.equal(journal.biggest_error, 'Minor typo in docs');
    assert.equal(journal.focus_tomorrow, 'Write tests');
    assert.equal(journal.diary_entry, 'Today was productive. Fixed bugs and shipped features.');

    const tasksCompleted = JSON.parse(journal.tasks_completed || '[]');
    assert.deepEqual(tasksCompleted, ['task-a', 'task-b', 'task-c']);

    const tasksInProgress = JSON.parse(journal.tasks_in_progress || '[]');
    assert.deepEqual(tasksInProgress, ['task-d']);
  });
});

test('createDailyJournal defaults to today when no date provided', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { createDailyJournal, getDailyJournalByDate } = await importFresh(distPath('db.js'));
    const today = new Date().toISOString().split('T')[0];

    const journalId = createDailyJournal({
      group_folder: 'test-group',
      sentiment: 'neutral',
      diary_entry: 'Test entry'
    });

    const journal = getDailyJournalByDate('test-group', today);
    assert.ok(journal);
    assert.equal(journal.diary_entry, 'Test entry');
  });
});

test('getActiveDailyTasks handles empty task list', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { getActiveDailyTasks } = await importFresh(distPath('db.js'));

    const tasks = getActiveDailyTasks('empty-group');
    assert.equal(tasks.length, 0);
  });
});

test('updateDailyJournal modifies existing journal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-journal-'));
  await withTempHome(tempDir, async () => {
    const { createDailyJournal, updateDailyJournal, getDailyJournalByDate } = await importFresh(distPath('db.js'));
    const testDate = '2026-02-21';

    const journalId = createDailyJournal({
      group_folder: 'test-group',
      date: testDate,
      sentiment: 'neutral',
      diary_entry: 'Initial entry'
    });

    updateDailyJournal(journalId, {
      sentiment: 'positive',
      biggest_success: 'Great achievement'
    });

    const journal = getDailyJournalByDate('test-group', testDate);
    assert.equal(journal.sentiment, 'positive');
    assert.equal(journal.biggest_success, 'Great achievement');
    assert.equal(journal.diary_entry, 'Initial entry'); // Unchanged
  });
});
