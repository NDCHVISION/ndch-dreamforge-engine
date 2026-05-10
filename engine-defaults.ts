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

function loadEngineDefaults(): EngineDefaults {
  const configPath = resolve('engine/viral-reel-engine.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
    const engine = parsed?.engine ?? {};
    const voiceover = engine?.production_stack?.voiceover ?? {};
    const duration = engine?.virality_data?.duration_strategy ?? {};

    const defaultVoiceId = typeof voiceover.default_voice_id === 'string'
      ? voiceover.default_voice_id
      : FALLBACKS.defaultVoiceId;
    const recommendedModels = Array.isArray(voiceover.recommended_models)
      ? voiceover.recommended_models.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    const defaultModelId = recommendedModels[0] ?? FALLBACKS.defaultModelId;

    return {
      defaultVoiceId,
      defaultModelId,
      defaultDurationSeconds: toNumber(duration.engine_default_seconds) ?? FALLBACKS.defaultDurationSeconds,
      maxDurationSeconds: toNumber(duration.maximum_seconds) ?? FALLBACKS.maxDurationSeconds,
    };
  } catch {
    return FALLBACKS;
  }
}

export const ENGINE_DEFAULTS = loadEngineDefaults();
