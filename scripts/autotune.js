#!/usr/bin/env node
import 'dotenv/config';
import path from 'path';
import { runOnce } from '@dotsetlabs/autotune';

function setDefaultEnv(key, value) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

function mapEnv(sourceKey, targetKey) {
  if (process.env[sourceKey] && !process.env[targetKey]) {
    process.env[targetKey] = process.env[sourceKey];
  }
}

async function main() {
  const cwd = process.cwd();

  setDefaultEnv('AUTOTUNE_BEHAVIOR_CONFIG_PATH', path.join(cwd, 'data', 'behavior.json'));
  setDefaultEnv('AUTOTUNE_BEHAVIOR_REPORT_DIR', path.join(cwd, 'data'));
  setDefaultEnv('AUTOTUNE_BEHAVIOR_ENABLED', '1');

  mapEnv('DOTCLAW_AUTOTUNE_DAYS', 'AUTOTUNE_BEHAVIOR_DAYS');
  mapEnv('DOTCLAW_AUTOTUNE_PROMPTS', 'AUTOTUNE_BEHAVIOR_PROMPT_PACKS');
  mapEnv('DOTCLAW_AUTOTUNE_EVAL_MODEL', 'AUTOTUNE_BEHAVIOR_EVAL_MODEL');
  mapEnv('DOTCLAW_AUTOTUNE_EVAL_SAMPLES', 'AUTOTUNE_BEHAVIOR_EVAL_SAMPLES');
  mapEnv('DOTCLAW_TRACE_DIR', 'AUTOTUNE_TRACE_DIR');
  mapEnv('DOTCLAW_PROMPT_PACKS_DIR', 'AUTOTUNE_OUTPUT_DIR');
  mapEnv('DOTCLAW_PROMPT_PACKS_CANARY_RATE', 'AUTOTUNE_CANARY_FRACTION');

  await runOnce();
  console.log('Autotune complete.');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
