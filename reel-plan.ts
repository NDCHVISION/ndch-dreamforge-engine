import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;
const MAX_STYLE_QUOTE_WORDS = 24;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPath(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function pickValue(source: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickString(source: unknown, paths: string[][]): string | undefined {
  const value = pickValue(source, paths);
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function pickNumber(source: unknown, paths: string[][]): number | undefined {
  const value = pickValue(source, paths);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function pickBoolean(source: unknown, paths: string[][]): boolean | undefined {
  const value = pickValue(source, paths);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function pickStringArray(source: unknown, paths: string[][]): string[] {
  const value = pickValue(source, paths);
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimToWords(text: string, maxWords: number): string {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function isValidClockComponent(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 0 && value < 60);
}

function parseJsonFile(path: string, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Failed to load ${label} JSON from ${path}: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${label} JSON at ${path} must contain an object at the root`);
  }

  return parsed;
}

function extractSegments(source: unknown): ResolvedNarrationSegment[] {
  const rawSegments = pickValue(source, [
    ['voiceover', 'script', 'segments'],
    ['voiceover', 'segments'],
    ['segments'],
    ['narration', 'segments'],
  ]);

  if (!Array.isArray(rawSegments)) return [];

  return rawSegments.flatMap(segment => {
    if (typeof segment === 'string') {
      const text = normalizeWhitespace(segment);
      return text ? [{ text }] : [];
    }

    if (!isRecord(segment)) return [];

    const text = pickString(segment, [
      ['text'],
      ['script'],
      ['narration'],
      ['voiceover_text'],
      ['full_text'],
    ]);
    if (!text) return [];

    const promptText = pickString(segment, [
      ['visual_prompt'],
      ['prompt'],
      ['scene_prompt'],
      ['runway_prompt'],
      ['visual_prompt', 'primary_prompt'],
      ['visual_prompt', 'prompt'],
    ]);

    const timestampStartSeconds = parseTimestampSeconds(pickValue(segment, [
      ['timestamp_start'],
      ['timestampStart'],
      ['start_timestamp'],
      ['start_time'],
    ]));
    const timestampEndSeconds = parseTimestampSeconds(pickValue(segment, [
      ['timestamp_end'],
      ['timestampEnd'],
      ['end_timestamp'],
      ['end_time'],
    ]));

    return [{ text, promptText, timestampStartSeconds, timestampEndSeconds }];
  });
}

function selectVoiceSettings(source: unknown): ResolvedVoiceSettings | undefined {
  const config = pickValue(source, [
    ['voiceover', 'elevenLabs_config', 'voice_settings'],
    ['voiceover', 'elevenlabs_config', 'voice_settings'],
    ['elevenLabs_config', 'voice_settings'],
    ['elevenlabs_config', 'voice_settings'],
    ['voice_settings'],
  ]);

  if (!isRecord(config)) return undefined;

  const resolved: ResolvedVoiceSettings = {};
  const numericKeys = ['stability', 'similarity_boost', 'style', 'speed'] as const;
  for (const key of numericKeys) {
    const value = config[key];
    if (typeof value === 'number' && Number.isFinite(value)) resolved[key] = value;
  }

  if (typeof config.use_speaker_boost === 'boolean') {
    resolved.use_speaker_boost = config.use_speaker_boost;
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function parseTimestampSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;

  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const colonMatch = trimmed.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (colonMatch) {
    const [, first, second, third] = colonMatch;
    const firstNumber = Number(first);
    const secondNumber = Number(second);
    const thirdNumber = third !== undefined ? Number(third) : undefined;

    if (!isValidClockComponent(secondNumber) || !isValidClockComponent(thirdNumber)) {
      return undefined;
    }

    if (thirdNumber !== undefined) return (firstNumber * 3600) + (secondNumber * 60) + thirdNumber;
    return (firstNumber * 60) + secondNumber;
  }

  const secondsMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?/i);
  if (secondsMatch) return Number(secondsMatch[1]);

  return undefined;
}

function selectStyleId(engineConfig: JsonRecord | undefined, reelSpec: JsonRecord | undefined, fallbackText: string): string | undefined {
  const explicitStyleId = pickString(reelSpec, [
    ['chosen_style'],
    ['style_id'],
    ['style'],
    ['style', 'id'],
    ['visual_prompt', 'style_id'],
    ['visual_prompt', 'style'],
  ]);
  if (explicitStyleId) return explicitStyleId;

  if (!engineConfig) return undefined;

  const rules = pickValue(engineConfig, [['engine', 'style_selection_logic', 'rules']]);
  if (!Array.isArray(rules)) return undefined;

  const text = fallbackText.toLowerCase();
  const prioritizedRules = rules
    .map((rule, index) => ({ rule, index }))
    .filter((entry): entry is { rule: JsonRecord; index: number } => isRecord(entry.rule))
    .sort((left, right) => {
      const leftPriority = typeof left.rule.priority === 'number' ? left.rule.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = typeof right.rule.priority === 'number' ? right.rule.priority : Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .map(entry => entry.rule);

  let defaultStyleId: string | undefined;
  for (const rule of prioritizedRules) {
    if (!defaultStyleId && typeof rule.default === 'string' && rule.default.trim()) {
      defaultStyleId = rule.default.trim();
    }

    if (typeof rule.select !== 'string') continue;
    const keywords = Array.isArray(rule.trigger_keywords)
      ? rule.trigger_keywords.filter((item): item is string => typeof item === 'string')
      : [];
    if (keywords.some(keyword => text.includes(keyword.toLowerCase()))) {
      return rule.select.trim();
    }
  }

  return defaultStyleId;
}

function buildBasePrompt(
  engineConfig: JsonRecord | undefined,
  reelSpec: JsonRecord | undefined,
  selectedStyleId: string | undefined,
  fallbackPrompt: string | undefined,
  fallbackQuote: string
): string | undefined {
  const promptFromSpec = pickString(reelSpec, [
    ['final_visual_prompt'],
    ['visual_prompt', 'primary_prompt'],
    ['visual_prompt', 'final_prompt'],
    ['visual_prompt', 'prompt'],
    ['visual_prompt'],
    ['runway', 'prompt'],
    ['prompt'],
  ]);
  if (promptFromSpec) return promptFromSpec;

  const styles = pickValue(engineConfig, [['engine', 'style_library']]);
  const style = selectedStyleId && isRecord(styles) && isRecord(styles[selectedStyleId])
    ? styles[selectedStyleId]
    : undefined;
  const stylePrompt = pickString(style, [['base_prompt']]);

  if (stylePrompt) {
    return stylePrompt.replace(/\bQUOTE\b/g, trimToWords(fallbackQuote, MAX_STYLE_QUOTE_WORDS));
  }

  return fallbackPrompt;
}

export interface ResolvedVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

export interface ResolvedNarrationSegment {
  text: string;
  promptText?: string;
  timestampStartSeconds?: number;
  timestampEndSeconds?: number;
}

export interface ResolvedProductionPlan {
  engineConfigPath?: string;
  reelSpecPath?: string;
  concept?: string;
  selectedStyleId?: string;
  script: string;
  narrationSegments: ResolvedNarrationSegment[];
  prompt: string;
  targetDurationSeconds?: number;
  elevenLabs: {
    voiceId?: string;
    modelId: string;
    voiceSettings?: ResolvedVoiceSettings;
  };
  instagram: {
    caption?: string;
    coverFrameOffsetMs?: number;
    shareToFeed?: boolean;
  };
  subtitles?: unknown;
}

interface ResolveProductionPlanOptions {
  defaultVoiceId: string;
  defaultModelId: string;
}

export function resolveProductionPlan(
  env: NodeJS.ProcessEnv,
  options: ResolveProductionPlanOptions
): ResolvedProductionPlan {
  const engineConfigPath = env.ENGINE_CONFIG_PATH?.trim() || undefined;
  const reelSpecPath = env.REEL_SPEC_PATH?.trim() || undefined;

  const engineConfig = engineConfigPath ? parseJsonFile(engineConfigPath, 'engine config') : undefined;
  const reelSpec = reelSpecPath ? parseJsonFile(reelSpecPath, 'reel spec') : undefined;

  const explicitSegments = extractSegments(reelSpec);
  const scriptFromSpec = pickString(reelSpec, [
    ['voiceover', 'script', 'full_text'],
    ['voiceover', 'script', 'text'],
    ['voiceover', 'full_text'],
    ['voiceover', 'text'],
    ['script', 'full_text'],
    ['script'],
    ['narration'],
  ]);
  const fallbackScript = env.REEL_SCRIPT?.trim() || undefined;
  const scriptFromSegments = explicitSegments.length > 0
    ? explicitSegments.map(segment => segment.text).join(' ')
    : undefined;
  const script = normalizeWhitespace(
    scriptFromSpec
      ?? scriptFromSegments
      ?? fallbackScript
      ?? ''
  );

  if (!script) {
    throw new Error(
      'Missing narration text. Provide REEL_SCRIPT or a reel spec with voiceover/script content.'
    );
  }

  const concept = pickString(reelSpec, [
    ['concept'],
    ['theme'],
    ['title'],
    ['brief', 'concept'],
  ]);
  const selectedStyleId = selectStyleId(
    engineConfig,
    reelSpec,
    [concept, script, env.REEL_PROMPT ?? ''].filter(Boolean).join(' ')
  );

  const prompt = buildBasePrompt(
    engineConfig,
    reelSpec,
    selectedStyleId,
    env.REEL_PROMPT?.trim() || undefined,
    concept ?? script
  );

  if (!prompt) {
    throw new Error(
      'Missing visual prompt. Provide REEL_PROMPT or a reel spec/global config that resolves a prompt.'
    );
  }

  const recommendedModels = pickStringArray(engineConfig, [
    ['engine', 'production_stack', 'voiceover', 'recommended_models'],
  ]);
  const modelId = pickString(reelSpec, [
    ['voiceover', 'elevenLabs_config', 'model_id'],
    ['voiceover', 'elevenlabs_config', 'model_id'],
    ['elevenLabs_config', 'model_id'],
    ['elevenlabs_config', 'model_id'],
  ]) ?? recommendedModels[0] ?? options.defaultModelId;

  const voiceId = pickString(reelSpec, [
    ['voiceover', 'elevenLabs_config', 'voice_id'],
    ['voiceover', 'elevenlabs_config', 'voice_id'],
    ['elevenLabs_config', 'voice_id'],
    ['elevenlabs_config', 'voice_id'],
  ]) ?? options.defaultVoiceId;

  const targetDurationSeconds = pickNumber(reelSpec, [
    ['format', 'target_duration_seconds'],
    ['target_duration_seconds'],
    ['duration_seconds'],
  ]) ?? pickNumber(engineConfig, [
    ['engine', 'virality_data', 'duration_strategy', 'engine_default_seconds'],
  ]);

  const caption = pickString(reelSpec, [
    ['instagram_config', 'caption', 'full_caption'],
    ['instagram_config', 'caption'],
    ['instagram', 'caption', 'full_caption'],
    ['instagram', 'caption'],
    ['caption'],
  ]) ?? (env.REEL_CAPTION?.trim() || undefined);

  const coverFrameSeconds = pickNumber(reelSpec, [
    ['instagram_config', 'cover_frame_timestamp_seconds'],
    ['instagram_config', 'cover_frame_seconds'],
    ['instagram_config', 'cover_frame', 'timestamp_seconds'],
  ]) ?? parseTimestampSeconds(
    pickValue(reelSpec, [
      ['instagram_config', 'cover_frame'],
      ['instagram', 'cover_frame'],
    ]) ?? pickValue(engineConfig, [
      ['engine', 'instagram_defaults', 'cover_frame'],
    ])
  );

  const shareToFeed = pickBoolean(reelSpec, [
    ['instagram_config', 'share_to_feed'],
    ['instagram', 'share_to_feed'],
  ]);

  const subtitles = pickValue(reelSpec, [
    ['subtitle_config'],
    ['subtitles'],
  ]) ?? pickValue(engineConfig, [
    ['engine', 'subtitle_system'],
  ]);

  return {
    engineConfigPath: engineConfigPath ? resolve(engineConfigPath) : undefined,
    reelSpecPath: reelSpecPath ? resolve(reelSpecPath) : undefined,
    concept,
    selectedStyleId,
    script,
    narrationSegments: explicitSegments,
    prompt,
    targetDurationSeconds,
    elevenLabs: {
      voiceId,
      modelId,
      voiceSettings: selectVoiceSettings(reelSpec),
    },
    instagram: {
      caption,
      coverFrameOffsetMs: coverFrameSeconds !== undefined ? Math.round(coverFrameSeconds * 1000) : undefined,
      shareToFeed,
    },
    subtitles,
  };
}
