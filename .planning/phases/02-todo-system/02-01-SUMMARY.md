# SUMMARY 02-01: Task Breakdown Subagent

## Completed

### Task Breakdown Skill
- Created `global/skills/task-breakdown/SKILL.md`
- Skill takes high-level tasks and breaks them into atomic subtasks
- Max 10 subtasks, each with emoji prefix
- Validates title length (max 55 chars)
- Emojis are semantic (🔧 fix, ✨ feature, 📝 doc)

### Task Breakdown Module
- Created `src/task-breakdown.ts`
- `extractEmoji()` - Extract emoji from task title
- `parseSubtasks()` - Parse and validate JSON output
- `getSubtaskTitles()` - Helper to extract titles

### IPC Action
- Added `breakdown_task` action to `src/ipc-dispatcher.ts`
- Validates `main_task` parameter
- Builds prompt with optional context (repo, url, description)
- Spawns agent run with `defaultSkill: 'task-breakdown'`
- Validates subtask count (≤10) and format (emoji prefix, length ≤55)
- Returns structured result with main task and subtasks array

## Files Created
- `global/skills/task-breakdown/SKILL.md`
- `src/task-breakdown.ts`

## Files Modified
- `src/ipc-dispatcher.ts` - Added breakdown_task case

## Verification
```bash
npm run build  # Success
```

## Example Usage
```typescript
// Agent can call via IPC:
{
  type: 'breakdown_task',
  main_task: 'Fix authentication bug',
  context: { repo: 'github.com/user/repo', description: 'Users cant login' }
}

// Returns:
{
  ok: true,
  result: {
    main_task: 'Fix authentication bug',
    subtasks: [
      { title: '🔍 Reproduce bug', emoji: '🔍' },
      { title: '🐛 Find root cause', emoji: '🐛' },
      { title: '💻 Write fix', emoji: '💻' }
    ]
  }
}
```
