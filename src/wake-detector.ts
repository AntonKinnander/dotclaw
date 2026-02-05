import { logger } from './logger.js';

const CHECK_INTERVAL_MS = 10_000;
const JUMP_THRESHOLD_MS = CHECK_INTERVAL_MS * 2; // 20s

let timer: NodeJS.Timeout | null = null;
let lastTick = 0;

/**
 * Detect sleep/wake by monitoring wall-clock jumps.
 * A setInterval fires every 10s; if the elapsed time since the last tick
 * exceeds 20s, we assume a sleep/wake transition occurred.
 */
export function startWakeDetector(onWake: (sleepDurationMs: number) => void): void {
  if (timer) return;
  lastTick = Date.now();

  timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;

    if (elapsed > JUMP_THRESHOLD_MS) {
      const sleepDurationMs = elapsed - CHECK_INTERVAL_MS;
      logger.info(
        { sleepDurationMs, elapsedMs: elapsed },
        'Sleep/wake detected: wall clock jumped'
      );
      onWake(sleepDurationMs);
    }
  }, CHECK_INTERVAL_MS);

  timer.unref();
  logger.info('Wake detector started');
}

export function stopWakeDetector(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
