import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildSceneTimeline,
  buildSegmentPrompt,
  planClipDurations,
  planNarrationScenes,
} from './lib/scene-planning.ts';
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
            {
              text: 'Be like water.',
              visual_prompt: 'liquid gold reflections',
              timestamp_start: '0:00',
              timestamp_end: '0:03',
            },
            {
              text: 'Flow, adapt, and keep moving.',
              visual_prompt: 'surreal river canyon',
              timestamp_start: '0:03',
              timestamp_end: '0:10',
            },
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
    assert.equal(plan.narrationSegments[0].timestampStartSeconds, 0);
    assert.equal(plan.narrationSegments[0].timestampEndSeconds, 3);
    assert.equal(plan.narrationSegments[1].timestampStartSeconds, 3);
    assert.equal(plan.narrationSegments[1].timestampEndSeconds, 10);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('planNarrationScenes uses explicit segment timestamps to group narration first', () => {
  const scenes = planNarrationScenes(
    'Be like water. Flow around the obstacle. Then carve a new path.',
    'Surreal cinematic river world',
    18,
    {
      narrationSegments: [
        { text: 'Be like water.', promptText: 'liquid gold reflections', timestampStartSeconds: 0, timestampEndSeconds: 3 },
        { text: 'Flow around the obstacle.', promptText: 'river bending around stone', timestampStartSeconds: 3, timestampEndSeconds: 10 },
        { text: 'Then carve a new path.', promptText: 'canyon opening forward', timestampStartSeconds: 10, timestampEndSeconds: 18 },
      ],
    }
  );

  assert.equal(scenes.length, 2);
  assert.deepEqual(scenes.map(scene => scene.clipDuration), [10, 10]);
  assert.equal(scenes[0].narrationChunk, 'Be like water. Flow around the obstacle.');
  assert.equal(scenes[0].estimatedNarrationSecs, 10);
  assert.match(scenes[0].promptText, /liquid gold reflections river bending around stone/);
  assert.equal(scenes[1].narrationChunk, 'Then carve a new path.');
  assert.equal(scenes[1].estimatedNarrationSecs, 8);
  assert.match(scenes[1].promptText, /canyon opening forward/);
});

test('planNarrationScenes falls back to word-count planning when segment timestamps are absent', () => {
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
  assert.equal(scenes[0].estimatedNarrationSecs, 4.5);
  assert.equal(scenes[1].estimatedNarrationSecs, 7.5);
  assert.match(scenes[0].promptText, /liquid gold reflections/);
  assert.match(scenes[1].promptText, /surreal river canyon/);
});

test('planNarrationScenes populates coveredSegmentIndices from explicit segments', () => {
  const scenes = planNarrationScenes(
    'Be like water. Flow around the obstacle. Then carve a new path.',
    'Surreal cinematic river world',
    18,
    {
      narrationSegments: [
        { text: 'Be like water.', promptText: 'liquid gold reflections', timestampStartSeconds: 0, timestampEndSeconds: 3 },
        { text: 'Flow around the obstacle.', promptText: 'river bending around stone', timestampStartSeconds: 3, timestampEndSeconds: 10 },
        { text: 'Then carve a new path.', promptText: 'canyon opening forward', timestampStartSeconds: 10, timestampEndSeconds: 18 },
      ],
    }
  );

  // Scene 1 groups segments 0 and 1 (0–10s fits a 10s clip)
  assert.deepEqual(scenes[0].coveredSegmentIndices, [0, 1]);
  assert.equal(scenes[0].timestampStartSeconds, 0);
  assert.equal(scenes[0].timestampEndSeconds, 10);
  assert.equal(scenes[0].intendedNarrationDurationSecs, 10);

  // Scene 2 covers segment 2 (10–18s)
  assert.deepEqual(scenes[1].coveredSegmentIndices, [2]);
  assert.equal(scenes[1].timestampStartSeconds, 10);
  assert.equal(scenes[1].timestampEndSeconds, 18);
  assert.equal(scenes[1].intendedNarrationDurationSecs, 8);
});

test('planNarrationScenes coveredSegmentIndices are empty when no explicit segments are provided', () => {
  const scenes = planNarrationScenes(
    'Be like water. Flow, adapt, and keep moving.',
    'Surreal cinematic river world',
    12
  );

  // Auto-split mode: no sourceSegmentIndex, so coveredSegmentIndices is empty for all clips
  for (const scene of scenes) {
    assert.deepEqual(scene.coveredSegmentIndices, []);
    assert.equal(scene.timestampStartSeconds, undefined);
    assert.equal(scene.timestampEndSeconds, undefined);
    assert.equal(scene.intendedNarrationDurationSecs, undefined);
  }
});

test('planNarrationScenes intendedNarrationDurationSecs is undefined when timestamps are absent', () => {
  const scenes = planNarrationScenes(
    'Be like water. Flow, adapt, and keep moving.',
    'Surreal cinematic river world',
    12,
    {
      narrationSegments: [
        { text: 'Be like water.', promptText: 'liquid gold reflections' },
        { text: 'Flow, adapt, and keep moving.', promptText: 'surreal river canyon' },
      ],
    }
  );

  // Segments present but no timestamps: coveredSegmentIndices populated but intended duration absent
  assert.deepEqual(scenes[0].coveredSegmentIndices, [0]);
  assert.equal(scenes[0].timestampStartSeconds, undefined);
  assert.equal(scenes[0].intendedNarrationDurationSecs, undefined);
  assert.deepEqual(scenes[1].coveredSegmentIndices, [1]);
  assert.equal(scenes[1].timestampStartSeconds, undefined);
  assert.equal(scenes[1].intendedNarrationDurationSecs, undefined);
});

test('buildSceneTimeline produces correct allocation entries from scene plan and segments', () => {
  const narrationSegments = [
    { text: 'Be like water.', promptText: 'liquid gold reflections', timestampStartSeconds: 0, timestampEndSeconds: 3 },
    { text: 'Flow around the obstacle.', promptText: 'river bending around stone', timestampStartSeconds: 3, timestampEndSeconds: 10 },
    { text: 'Then carve a new path.', promptText: 'canyon opening forward', timestampStartSeconds: 10, timestampEndSeconds: 18 },
  ];

  const scenes = planNarrationScenes(
    'Be like water. Flow around the obstacle. Then carve a new path.',
    'Surreal cinematic river world',
    18,
    { narrationSegments }
  );

  const timeline = buildSceneTimeline(scenes, narrationSegments);

  assert.equal(timeline.length, 2);

  // Entry 0: covers segments 0 and 1
  assert.equal(timeline[0].clipIndex, 0);
  assert.equal(timeline[0].clipDuration, 10);
  assert.equal(timeline[0].timestampStartSeconds, 0);
  assert.equal(timeline[0].timestampEndSeconds, 10);
  assert.equal(timeline[0].intendedNarrationDurationSecs, 10);
  assert.equal(timeline[0].narrationText, 'Be like water. Flow around the obstacle.');
  assert.equal(timeline[0].coveredSegments.length, 2);
  assert.equal(timeline[0].coveredSegments[0].segmentIndex, 0);
  assert.equal(timeline[0].coveredSegments[0].text, 'Be like water.');
  assert.equal(timeline[0].coveredSegments[0].timestampStartSeconds, 0);
  assert.equal(timeline[0].coveredSegments[0].timestampEndSeconds, 3);
  assert.equal(timeline[0].coveredSegments[0].intendedDurationSecs, 3);
  assert.equal(timeline[0].coveredSegments[1].segmentIndex, 1);
  assert.equal(timeline[0].coveredSegments[1].text, 'Flow around the obstacle.');
  assert.equal(timeline[0].coveredSegments[1].intendedDurationSecs, 7);

  // Entry 1: covers segment 2
  assert.equal(timeline[1].clipIndex, 1);
  assert.equal(timeline[1].clipDuration, 10);
  assert.equal(timeline[1].timestampStartSeconds, 10);
  assert.equal(timeline[1].timestampEndSeconds, 18);
  assert.equal(timeline[1].intendedNarrationDurationSecs, 8);
  assert.equal(timeline[1].coveredSegments.length, 1);
  assert.equal(timeline[1].coveredSegments[0].segmentIndex, 2);
  assert.equal(timeline[1].coveredSegments[0].text, 'Then carve a new path.');
  assert.equal(timeline[1].coveredSegments[0].intendedDurationSecs, 8);
});

test('buildSceneTimeline produces empty coveredSegments when no explicit segments provided', () => {
  const scenes = planNarrationScenes(
    'Be like water. Flow, adapt, and keep moving.',
    'Surreal cinematic river world',
    12
  );

  const timeline = buildSceneTimeline(scenes, []);

  assert.equal(timeline.length, scenes.length);
  for (const entry of timeline) {
    assert.deepEqual(entry.coveredSegments, []);
    assert.equal(entry.timestampStartSeconds, undefined);
    assert.equal(entry.intendedNarrationDurationSecs, undefined);
  }
});

test('planClipDurations clamps long requests to configured max duration', () => {
  const durations = planClipDurations(220, 220);
  const total = durations.reduce((sum, value) => sum + value, 0);

  assert.equal(total, 90);
  assert.deepEqual(durations, [10, 10, 10, 10, 10, 10, 10, 10, 10]);
});

test('planNarrationScenes throws when script is empty after normalization', () => {
  assert.throws(
    () => planNarrationScenes('   \n\t   ', 'prompt', 12),
    /Narration script must contain non-whitespace content/
  );
});

test('planNarrationScenes assigns opening middle closing roles', () => {
  const scenes = planNarrationScenes(
    'First we rise. Then we adapt with precision. Finally we become undeniable.',
    'Cinematic transformation sequence',
    22,
    { targetDurationSecs: 26 }
  );

  assert.equal(scenes.length, 3);
  assert.deepEqual(scenes.map(scene => scene.role), ['opening', 'middle', 'closing']);
});

test('buildSegmentPrompt uses opening-focused cinematic direction', () => {
  const prompt = buildSegmentPrompt(
    'Dark cinematic city under stormlight',
    'We begin now.',
    0,
    3
  );

  assert.match(prompt, /Opening scene/);
  assert.match(prompt, /Hook instantly with a striking first image/);
  assert.match(prompt, /Composition: Bold composition/);
});

test('buildSegmentPrompt uses middle progression and motion direction', () => {
  const prompt = buildSegmentPrompt(
    'Dark cinematic city under stormlight',
    'We adapt with purpose.',
    1,
    3
  );

  assert.match(prompt, /Scene 2 of 3/);
  assert.match(prompt, /Advance the narrative with visible progression/);
  assert.match(prompt, /Motion: Cinematic tracking\/orbit\/parallax movement/);
});

test('buildSegmentPrompt uses closing-focused cinematic direction', () => {
  const prompt = buildSegmentPrompt(
    'Dark cinematic city under stormlight',
    'This is who we are.',
    2,
    3
  );

  assert.match(prompt, /Closing scene/);
  assert.match(prompt, /resolved final image/);
  assert.match(prompt, /Simplified final tableau/);
});

test('buildSegmentPrompt adapts to transformation-oriented content', () => {
  const prompt = buildSegmentPrompt(
    'Cinematic forge of identity',
    'Through fire we emerge and become unbreakable.',
    1,
    3
  );

  assert.match(prompt, /Frames morph from one state into the next/);
  assert.match(prompt, /Metamorphic motion/);
});

test('buildSegmentPrompt adapts to confrontation-oriented content', () => {
  const prompt = buildSegmentPrompt(
    'Cinematic arena at dusk',
    'We clash against resistance and push through force.',
    1,
    3
  );

  assert.match(prompt, /Opposing forces collide/);
  assert.match(prompt, /Aggressive surges/);
});

test('buildSegmentPrompt adapts to stillness-oriented content', () => {
  const prompt = buildSegmentPrompt(
    'Cinematic temple in mist',
    'In quiet stillness we reflect and breathe.',
    1,
    3
  );

  assert.match(prompt, /Centered restraint with breathing negative space/);
  assert.match(prompt, /Slow drift or near-still holds/);
  assert.match(prompt, /meditative air/);
  assert.match(prompt, /Reflective, grounded, emotionally composed/);
});

test('buildSegmentPrompt adapts to revelation-oriented content', () => {
  const prompt = buildSegmentPrompt(
    'Cinematic chamber of mirrors',
    'The truth is revealed as light opens the room.',
    1,
    3
  );

  assert.match(prompt, /Composition clears toward legible truth/);
  assert.match(prompt, /Motion parts obscurity then settles/);
  assert.match(prompt, /Light opens surfaces as haze recedes/);
  assert.match(prompt, /Ambiguity resolves into lucid conviction/);
});

test('buildSegmentPrompt keeps role language visible while adapting to content', () => {
  const prompt = buildSegmentPrompt(
    'Dark cinematic city under stormlight',
    'We confront the obstacle and force a breakthrough.',
    0,
    3
  );

  assert.match(prompt, /Opening scene/);
  assert.match(prompt, /Hook instantly with a striking first image/);
  assert.match(prompt, /Opposing forces collide/);
});

test('buildSegmentPrompt stays under runway prompt limit', () => {
  // Repeat enough times to force anchor truncation so we verify the hard 1000-char cap.
  const prompt = buildSegmentPrompt(
    'Hyper-detailed neon megacity skyline '.repeat(80),
    'A procession of silhouetted riders crossing a floating bridge at dusk.',
    0,
    3
  );

  assert.ok(prompt.length <= 1000);
});

test('buildSegmentPrompt compacts visual focus by trimming weak lead-ins and filler words', () => {
  const prompt = buildSegmentPrompt(
    'Cinematic dreamscape with impossible architecture',
    'Narration fallback text',
    0,
    2,
    'In this scene we see just really a lone astronaut framed against a burning horizon with shattered satellites.'
  );

  assert.match(prompt, /Visual focus: .*lone astronaut.*burning horizon.*shattered satellites/i);
  assert.doesNotMatch(prompt, /Visual focus: In this scene we see/i);
});

test('planNarrationScenes preserves short punchy opening line as its own scene when possible', () => {
  const scenes = planNarrationScenes(
    'Move. Build the future with relentless precision and calm execution every day.',
    'Cinematic future foundry',
    14,
    { targetDurationSecs: 20 }
  );

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].narrationChunk, 'Move.');
  assert.equal(scenes[0].role, 'opening');
});

test('planNarrationScenes preserves short declarative closing line as final beat when possible', () => {
  const scenes = planNarrationScenes(
    'We rise through pressure and discipline, every single day. We win.',
    'Cinematic training arc',
    16,
    { targetDurationSecs: 20 }
  );

  assert.equal(scenes.length, 2);
  assert.equal(scenes[1].narrationChunk, 'We win.');
  assert.equal(scenes[1].role, 'closing');
});
