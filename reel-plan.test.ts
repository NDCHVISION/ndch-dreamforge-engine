import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { planNarrationScenes } from './generate-reel.ts';
import { resolveProductionPlan } from './reel-plan.ts';

test('resolveProductionPlan falls back to env values when JSON paths are absent', () => {
  const plan = resolveProductionPlan(
    {
      REEL_SCRIPT: 'Move with patience and power.',
      REEL_PROMPT: 'A cinematic river at dawn.',
      REEL_CAPTION: 'Patience beats panic.',
    },
    {
      defaultVoiceId: 'voice-default',
      defaultModelId: 'model-default',
    }
  );

  assert.equal(plan.script, 'Move with patience and power.');
  assert.equal(plan.prompt, 'A cinematic river at dawn.');
  assert.equal(plan.instagram.caption, 'Patience beats panic.');
  assert.equal(plan.elevenLabs.voiceId, 'voice-default');
  assert.equal(plan.elevenLabs.modelId, 'model-default');
  assert.equal(plan.narrationSegments.length, 0);
});

test('resolveProductionPlan merges engine config and reel spec JSON', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ndch-reel-plan-'));

  try {
    const engineConfigPath = join(tempDir, 'engine.json');
    const reelSpecPath = join(tempDir, 'reel.json');

    writeFileSync(engineConfigPath, JSON.stringify({
      engine: {
        style_library: {
          style_1_fractal: {
            base_prompt: 'Create a surreal looping reel about QUOTE with gold text architecture.',
          },
        },
        style_selection_logic: {
          rules: [
            { priority: 1, trigger_keywords: ['water'], select: 'style_1_fractal' },
            { priority: 99, default: 'style_1_fractal' },
          ],
        },
        virality_data: {
          duration_strategy: {
            engine_default_seconds: 42,
          },
        },
        instagram_defaults: {
          cover_frame: 'capture at timestamp 00:03',
        },
      },
    }, null, 2));

    writeFileSync(reelSpecPath, JSON.stringify({
      concept: 'Be like water',
      voiceover: {
        script: {
          full_text: 'Be like water. Flow, adapt, and keep moving.',
          segments: [
            { text: 'Be like water.', visual_prompt: 'liquid gold reflections' },
            { text: 'Flow, adapt, and keep moving.', visual_prompt: 'surreal river canyon' },
          ],
        },
        elevenLabs_config: {
          voice_id: 'voice-from-spec',
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.42,
            similarity_boost: 0.8,
            style: 0.25,
            use_speaker_boost: true,
            speed: 1.05,
          },
        },
      },
      format: {
        target_duration_seconds: 38,
      },
      instagram_config: {
        caption: {
          full_caption: 'Be like water. Save this for the days you need flow.',
        },
      },
    }, null, 2));

    const plan = resolveProductionPlan(
      {
        ENGINE_CONFIG_PATH: engineConfigPath,
        REEL_SPEC_PATH: reelSpecPath,
        REEL_PROMPT: 'env fallback prompt',
      },
      {
        defaultVoiceId: 'voice-default',
        defaultModelId: 'model-default',
      }
    );

    assert.equal(plan.engineConfigPath, engineConfigPath);
    assert.equal(plan.reelSpecPath, reelSpecPath);
    assert.equal(plan.selectedStyleId, 'style_1_fractal');
    assert.match(plan.prompt, /Be like water/);
    assert.equal(plan.targetDurationSeconds, 38);
    assert.equal(plan.elevenLabs.voiceId, 'voice-from-spec');
    assert.equal(plan.elevenLabs.modelId, 'eleven_turbo_v2_5');
    assert.deepEqual(plan.elevenLabs.voiceSettings, {
      stability: 0.42,
      similarity_boost: 0.8,
      style: 0.25,
      use_speaker_boost: true,
      speed: 1.05,
    });
    assert.equal(plan.instagram.caption, 'Be like water. Save this for the days you need flow.');
    assert.equal(plan.instagram.coverFrameOffsetMs, 3000);
    assert.equal(plan.narrationSegments.length, 2);
    assert.equal(plan.narrationSegments[0].promptText, 'liquid gold reflections');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('planNarrationScenes uses explicit narration segments and prompt overrides', () => {
  const scenes = planNarrationScenes(
    'Be like water. Flow, adapt, and keep moving.',
    'Surreal cinematic river world',
    12,
    {
      targetDurationSecs: 20,
      narrationSegments: [
        { text: 'Be like water.', promptText: 'liquid gold reflections' },
        { text: 'Flow, adapt, and keep moving.', promptText: 'surreal river canyon' },
      ],
    }
  );

  assert.equal(scenes.length, 2);
  assert.deepEqual(scenes.map(scene => scene.clipDuration), [10, 10]);
  assert.match(scenes[0].promptText, /liquid gold reflections/);
  assert.match(scenes[1].promptText, /surreal river canyon/);
});
