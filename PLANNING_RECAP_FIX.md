# Fix Daily Planning and Nightly Recap Forum Creation

## Context

**Both daily planning (`/daily-plan`) and nightly recap (`/recap`) are failing to create forum threads:**

- Daily planning: Should create task threads in TO-DO forum with checklist polls - doesn't work
- Nightly recap: Should create journal threads in Journal forum - doesn't work
- Both post summaries to the channel instead

**Root causes discovered:**
1. **Container tools not available**: New tools (`create_journal`, `breakdown_task`, etc.) added to source but Docker image not rebuilt
2. **Skills not loaded**: Commands use inline prompts instead of `defaultSkill`, so agent never sees proper instructions
3. **Non-deterministic**: Even if tools work, agent may forget to call them

## Discord.js Key Patterns Learned

From Discord.js Expert Guide (NotebookLM):

1. **Forum vs Text Channels**: Use `ChannelType.GuildForum` vs `ChannelType.GuildText`
2. **Creating Forum Thread with Poll**:
   ```typescript
   await forumChannel.threads.create({
     name: 'Task Title (max 100)',
     message: {
       content: 'Description',
       poll: {  // Poll can be in first message!
         question: { text: 'Question (max 300)' },
         answers: [
           { poll_media: { text: 'Answer (max 55)', emoji: { name: '✅' } } }
         ],
         allow_multiselect: true,  // Checklist mode
         duration: 24
       }
     }
   });
   ```
3. **Poll limits**: 10 answers max, 55 chars per answer, 300 char question

See `src/DISCORD_JS_PATTERNS.md` for complete reference.

## Recommended Approach: Dual Orchestrators

Create **two host-side orchestrators** that deterministically handle forum thread creation:

| Feature | Orchestrator | Responsibility |
|---------|--------------|----------------|
| Daily Planning | `DailyPlanningOrchestrator` | Create task threads with polls |
| Nightly Recap | `NightlyRecapOrchestrator` | Create journal threads |

**Why orchestrators:**
- Deterministic - always creates threads
- No dependency on agent remembering to call tools
- Follows existing pattern (`DailyPlanningOrchestrator` already exists)
- Host-side has direct access to Discord provider

## Implementation Plan

### Phase 1: Fix Daily Planning Orchestrator

**Current state**: `DailyPlanningOrchestrator` exists but `/daily-plan` command doesn't use it.

**Changes needed:**

1. **`src/index.ts` (lines 1196-1267)**: Modify `/daily-plan` to use orchestrator
2. **`src/daily-planning-orchestrator.ts`**: Add `runPlanningSession()` method
3. **`global/skills/daily-planning/SKILL.md`**: Update to output structured format

### Phase 2: Create Nightly Recap Orchestrator

**New file**: `src/nightly-recap-orchestrator.ts`

Key methods:
- `runRecapSession()`: Runs agent, parses response, creates journal thread
- `createJournalThread()`: Creates forum thread via Discord provider
- `parseJournalData()`: Extracts structured data from agent response

### Phase 3: Modify `/recap` Command

**`src/index.ts` (lines 907-988)**: Replace agent-run-only with orchestrator call

### Phase 4: Rebuild Docker Container

```bash
cd C:/Users/Fiznik/Development/DISCLAWD/dotclaw
./container/build.sh
npm run dev:down  # Kill stale containers
```

### Phase 5: Update Skills

Update skill files to output structured formats instead of calling tools.

## Critical Files

| File | Action |
|------|--------|
| `src/nightly-recap-orchestrator.ts` | **NEW** - Host-side journal orchestration |
| `src/daily-planning-orchestrator.ts` | **MODIFY** - Add `runPlanningSession()` |
| `src/index.ts` | **MODIFY** - `/recap` and `/daily-plan` to use orchestrators |
| `src/DISCORD_JS_PATTERNS.md` | **DONE** - Reference documentation |
| `container/` | **REBUILD** - New tools need Docker rebuild |
| `src/daily-planning-commands.ts` | **DONE** - Has `journal_forum_channel_id` config |
| `src/db.ts` | **DONE** - Has journal Discord refs migration |
| `src/ipc-dispatcher.ts` | **DONE** - Has `create_journal` with forum thread |

## Configuration

Users need to configure:

```bash
# TO-DO forum for task threads
/dotclaw configure-workflow forum <todo_channel_id>

# Journal forum for journal entries
/dotclaw configure-workflow journal-forum <journal_channel_id>
```

## Verification

1. Rebuild container: `./container/build.sh`
2. Configure forums: `/dotclaw configure-workflow forum ...` and `journal-forum ...`
3. Test daily planning: `/daily-plan` → should create task threads with polls
4. Test nightly recap: `/recap` → should create journal thread, no channel post
5. Check database for entries
6. Check Discord for forum threads

## Notes

- Orchestrators are **host-side only** - no container changes needed for this approach
- Container rebuild needed for previous changes (tools) but orchestrators bypass needing agent to call tools
- `create_journal` IPC/tool still exists for manual use
- Forum threads ARE channels - use thread ID directly as chatId
