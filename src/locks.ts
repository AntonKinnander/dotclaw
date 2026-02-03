type LockRelease = () => void;

type LockQueueEntry = {
  promise: Promise<void>;
  release: LockRelease;
};

const groupLocks = new Map<string, LockQueueEntry>();

function createQueueEntry(): LockQueueEntry {
  let release: LockRelease = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function withGroupLock<T>(groupFolder: string, fn: () => Promise<T>): Promise<T> {
  const previous = groupLocks.get(groupFolder);
  const current = createQueueEntry();
  groupLocks.set(groupFolder, current);

  if (previous) {
    await previous.promise;
  }

  try {
    return await fn();
  } finally {
    current.release();
    if (groupLocks.get(groupFolder) === current) {
      groupLocks.delete(groupFolder);
    }
  }
}
