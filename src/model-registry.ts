import path from 'path';
import { DATA_DIR } from './config.js';
import { loadJson, saveJson } from './utils.js';

export interface ModelOverride {
  context_window?: number;
  max_output_tokens?: number;
  temperature?: number;
}

export interface ModelConfig {
  model: string;
  allowlist: string[];
  overrides?: Record<string, ModelOverride>;
  per_group?: Record<string, { model: string }>;
  per_user?: Record<string, { model: string }>;
  updated_at?: string;
}

const MODEL_CONFIG_PATH = path.join(DATA_DIR, 'model.json');

export function loadModelRegistry(defaultModel: string): ModelConfig {
  const fallback: ModelConfig = {
    model: defaultModel,
    allowlist: []
  };
  const config = loadJson<ModelConfig>(MODEL_CONFIG_PATH, fallback);
  config.model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : defaultModel;
  config.allowlist = Array.isArray(config.allowlist)
    ? config.allowlist.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  return config;
}

export function saveModelRegistry(config: ModelConfig): void {
  saveJson(MODEL_CONFIG_PATH, config);
}

export function resolveModel(params: {
  groupFolder: string;
  userId?: string | null;
  defaultModel: string;
}): { model: string; override?: ModelOverride } {
  const config = loadModelRegistry(params.defaultModel);
  let model = config.model;

  const groupOverride = config.per_group?.[params.groupFolder];
  if (groupOverride?.model) {
    model = groupOverride.model;
  }
  if (params.userId) {
    const userOverride = config.per_user?.[params.userId];
    if (userOverride?.model) {
      model = userOverride.model;
    }
  }

  if (config.allowlist.length > 0 && !config.allowlist.includes(model)) {
    model = config.model;
  }

  const override = config.overrides?.[model];
  return { model, override };
}
