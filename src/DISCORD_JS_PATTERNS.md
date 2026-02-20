# Discord.js v14 Patterns for Productivity Bot

Reference guide for Discord.js v14.25.1 patterns used in daily planning and journal features.

## Forum Channels vs Regular Text Channels

### Key Differences

| Aspect | Text Channel | Forum Channel |
|--------|-------------|---------------|
| `ChannelType` | `ChannelType.GuildText` | `ChannelType.GuildForum` |
| Posting | `channel.send()` | Must create thread with `channel.threads.create()` |
| Content | Messages appear directly | Threads act as "posts" |
| Tags | None | `availableTags` array for categorization |

### Identifying Channel Types

```typescript
import { ChannelType } from 'discord.js';

function getChannelType(channel) {
  switch (channel.type) {
    case ChannelType.GuildText:
      return 'text';
    case ChannelType.GuildForum:
      return 'forum';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
      return 'thread';
    default:
      return 'other';
  }
}
```

### Creating Forum Threads

```typescript
import { EmbedBuilder } from 'discord.js';

// Find optional tag
const bugTag = forumChannel.availableTags.find(tag => tag.name === 'Bug Report');
const appliedTags = bugTag ? [bugTag.id] : [];

// Create forum post with starter message
const forumPost = await forumChannel.threads.create({
  // Thread Metadata
  name: 'Thread Title (max 100 chars)',
  autoArchiveDuration: 1440, // Archive after 24h of inactivity
  appliedTags: appliedTags,

  // Starter Message (REQUIRED for forums)
  message: {
    content: 'Post body content...',
    embeds: [
      new EmbedBuilder()
        .setTitle('Title')
        .setDescription('Description')
        .setColor(0x0099FF)
    ]
  }
});

// forumPost is a ThreadChannel
console.log(forumPost.url);
```

## Polls

### Creating a Poll (Regular Channel)

```typescript
await channel.send({
  content: '📋 **Daily Checklist**',
  poll: {
    question: { text: 'Tasks to complete (max 300 chars)' },
    answers: [
      { poll_media: { text: 'Task 1 (max 55 chars)', emoji: { name: '✅' } } },
      { poll_media: { text: 'Task 2', emoji: { name: '✅' } } },
      { poll_media: { text: 'Task 3' } }
    ],
    allow_multiselect: true, // Makes it a checklist
    duration: 24 // Hours poll is open (max 732 / 32 days)
  }
});
```

### Creating a Poll in Forum Thread (First Message)

```typescript
const forumPost = await forumChannel.threads.create({
  name: 'Task: Implement Feature X',
  message: {
    content: 'Vote on the implementation approach:',
    poll: {
      question: { text: 'Which approach?' },
      answers: [
        { poll_media: { text: 'Approach A', emoji: { name: '🅰️' } } },
        { poll_media: { text: 'Approach B', emoji: { name: '🅱️' } } }
      ],
      duration: 24,
      allow_multiselect: false
    }
  }
});
```

**Key**: The `message` parameter accepts `BaseMessageOptionsWithPoll` - poll can be included directly in thread creation!

### Poll Limits

| Property | Limit |
|----------|-------|
| Question text | 300 chars |
| Answer text | 55 chars |
| Max answers | 10 |
| Duration | 1-732 hours (up to 32 days) |
| Multiselect | Boolean (true = checklist mode) |

### Fetching Poll Results

```typescript
// Fetch the message with poll
const message = await channel.messages.fetch(messageId);
if (!message.poll) {
  console.log('No poll on this message');
  return;
}

const poll = message.poll;
console.log('Poll:', poll.question.text);
console.log('Finalized:', poll.results.is_finalized);

// Get vote counts per answer
poll.answers.forEach(answer => {
  const result = poll.results.answer_counts.find(c => c.id === answer.answer_id);
  const count = result ? result.count : 0;
  console.log(`${answer.poll_media.text}: ${count} votes`);
});
```

### Fetching Who Voted for What

```typescript
// Fetch users who voted for a specific answer
const voters = await channel.messages.fetchPollAnswerVoters({
  messageId: messageId,
  answerId: 1, // Answer IDs start at 1
  limit: 100 // Max per request
});

voters.forEach(user => {
  console.log(`${user.username} (${user.id}) voted for answer 1`);
});
```

**Important**: Requires `MESSAGE_CONTENT` intent in Discord Developer Portal.

### Ending a Poll Early

```typescript
const message = await channel.messages.fetch(messageId);
await message.poll.end();
```

## Productivity Bot Patterns

### Task Thread with Checklist Poll

```typescript
async function createTaskThread(forumChannel, taskTitle, subtasks) {
  // Format subtasks as poll answers (emoji + text, max 55 chars)
  const pollAnswers = subtasks.slice(0, 10).map(task => ({
    poll_media: {
      text: task.text.substring(0, 55),
      emoji: { name: '🔲' } // Empty checkbox
    }
  }));

  const thread = await forumChannel.threads.create({
    name: taskTitle.substring(0, 100),
    message: {
      content: `**Task**: ${taskTitle}\n\nCheck off subtasks as you complete them:`,
      poll: {
        question: { text: 'Subtasks' },
        answers: pollAnswers,
        allow_multiselect: true,
        duration: 168 // 7 days
      }
    }
  });

  return thread;
}
```

### Journal Entry Thread

```typescript
async function createJournalThread(forumChannel, date, journalData) {
  const sentimentEmoji = journalData.sentiment === 'positive' ? '😊'
                      : journalData.sentiment === 'negative' ? '😔'
                      : '😐';

  const content = `**Daily Journal — ${date}**

**Sentiment**: ${journalData.sentiment}

**✅ Completed**:
${journalData.tasks_completed.map(t => `• ${t}`).join('\n')}

**🔄 In Progress**:
${journalData.tasks_in_progress.map(t => `• ${t}`).join('\n')}

**🏆 Biggest Success**:
${journalData.biggest_success || 'None'}

**🐛 Challenge**:
${journalData.biggest_error || 'None'}

**🎯 Tomorrow's Focus**:
${journalData.focus_tomorrow || 'TBD'}`;

  const thread = await forumChannel.threads.create({
    name: `${sentimentEmoji} Journal — ${date}`,
    message: { content }
  });

  return thread;
}
```

## Channel Type Detection

```typescript
import { ChannelType } from 'discord.js';

// Check if channel is a forum
if (channel.type === ChannelType.GuildForum) {
  // Use threads.create()
} else if (channel.type === ChannelType.GuildText) {
  // Use send()
}
```

## Notes

- Forum threads **are** channels - use the thread ID directly as chatId
- Polls are **immutable** once created - cannot add/remove answers
- Answer IDs are **1-indexed** integers (1, 2, 3...)
- Poll results are finalized when Discord's background job completes counting
- Use `fetchPollAnswerVoters` for pagination if >100 voters per answer
