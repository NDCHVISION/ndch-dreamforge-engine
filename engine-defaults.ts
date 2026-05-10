import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface EngineDefaults {
  defaultVoiceId: string;
  defaultModelId: string;
  defaultDurationSeconds: number;
  maxDurationSeconds: number;
}

const FALLBACKS: EngineDefaults = {
  defaultVoiceId: 'pNInz6obpgDQGcFmaJgB',
  defaultModelId: 'eleven_turbo_v2_5',
  defaultDurationSeconds: 38,
  maxDurationSeconds: 90,
};

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function loadEngineDefaults(): EngineDefaults {
  const configPath = resolve('engine/viral-reel-engine.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    const defaultVoiceIdValue = getPath(parsed, ['engine', 'production_stack', 'voiceover', 'default_voice_id']);
    const recommendedModelsValue = getPath(parsed, ['engine', 'production_stack', 'voiceover', 'recommended_models']);
    const defaultDurationValue = getPath(parsed, ['engine', 'virality_data', 'duration_strategy', 'engine_default_seconds']);
    const maxDurationValue = getPath(parsed, ['engine', 'virality_data', 'duration_strategy', 'maximum_seconds']);

    const defaultVoiceId = typeof defaultVoiceIdValue === 'string'
      ? defaultVoiceIdValue
      : FALLBACKS.defaultVoiceId;
    const recommendedModels = Array.isArray(recommendedModelsValue)
      ? recommendedModelsValue.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    const defaultModelId = recommendedModels[0] ?? FALLBACKS.defaultModelId;

    return {
      defaultVoiceId,
      defaultModelId,
      defaultDurationSeconds: toNumber(defaultDurationValue) ?? FALLBACKS.defaultDurationSeconds,
      maxDurationSeconds: toNumber(maxDurationValue) ?? FALLBACKS.maxDurationSeconds,
    };
  } catch {
    return FALLBACKS;
  }
}

export const ENGINE_DEFAULTS = loadEngineDefaults();
