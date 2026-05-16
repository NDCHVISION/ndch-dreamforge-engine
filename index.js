let selectedStyle = 'style_1_fractal';
let selectedDuration = 38;
let manualStyleOverride = false;
let currentReel = null;

const STYLES = {
  style_1_fractal: {
    name: 'Fractal Gold Architecture',
    desc: 'Surreal, looping fractal visuals with liquid gold tones and sacred geometry.',
    keywords: ['water', 'flow', 'adapt', 'resilience', 'nature', 'universe', 'cosmos'],
    prompt: concept => `Create a surreal looping reel about ${concept} — liquid gold fractal geometry, sacred architecture dissolving into light, hyper-detailed cinematic motion, 4K, slow zoom, spiritual aesthetic, no text overlays.`,
    negative: 'text, words, logos, low-res, watermark, subtitles baked into frame',
    sceneNotes: 'Camera: slow push-in with orbital drift\nMotion: smooth and meditative\nKeep center clear for subtitles'
  },
  style_2_identity: {
    name: 'Identity & Shadow Self',
    desc: 'Dark cinematic portraiture, silhouettes, intense transformation energy.',
    keywords: ['identity', 'self', 'shadow', 'purpose', 'strength', 'warrior', 'discipline'],
    prompt: concept => `Create a cinematic reel about ${concept} — dark dramatic portraiture, silhouette against golden light, slow motion dust and fabric, intense personal transformation aesthetic, 4K, no text overlays.`,
    negative: 'text, words, logos, clutter, bright daytime, low detail',
    sceneNotes: 'Camera: centered portrait push-in\nMotion: emotionally escalating\nKeep headroom for subtitle safety margins'
  },
  style_3_hud: {
    name: 'HUD Neural Grid',
    desc: 'Futuristic HUD overlays and neural-grid sci-fi atmosphere.',
    keywords: ['mind', 'brain', 'focus', 'ai', 'future', 'system', 'code', 'logic'],
    prompt: concept => `Create a futuristic reel about ${concept} — HUD data overlays, neural network grid lines, electric blue and gold accents, cinematic motion, 4K, no readable text.`,
    negative: 'text, words, logos, noisy clutter, low-contrast lighting',
    sceneNotes: 'Camera: mostly locked with parallax\nMotion: precise data-layer evolution\nSubtitle-safe center region'
  }
  style_4_forge: {
    name: 'Forge & Ember',
    desc: 'Molten metal, falling sparks, raw craft under extreme pressure. Best for: hard work, effort, building, discipline.',
    keywords: ['forge', 'fire', 'heat', 'pressure', 'molten', 'iron', 'craft', 'hammer', 'steel', 'build', 'make'],
    prompt: concept => `Create a dramatic reel about ${concept} — extreme close-up of glowing molten metal and cascading sparks against pure black, liquid gold solidifying into form, slow motion ember drift, cinematic 4K, no text overlays.`,
    negative: 'text, words, logos, bright daylight, clean spaces, static imagery',
    sceneNotes: 'Camera: extreme macro close-up on forge details\nMotion: ultra-slow motion sparks and metal pour\nKeep center clear for subtitle safe zone'
  },
  style_5_blueprint: {
    name: 'Blueprint Architect',
    desc: 'Gold technical line drawings on black — systems, frameworks, deliberate construction. Best for: strategy, planning, systems.',
    keywords: ['plan', 'design', 'architect', 'framework', 'structure', 'system', 'strategy', 'foundation', 'construct', 'engineer'],
    prompt: concept => `Create a reel about ${concept} — precise gold architectural blueprint lines drawing themselves on deep black, geometric forms constructing from nothing, elegant technical diagrams morphing in sequence, cinematic 4K, no readable text.`,
    negative: 'text, words, messy clutter, noise, bright backgrounds, chaotic imagery',
    sceneNotes: 'Camera: slow reveal zoom on constructing line elements\nMotion: lines drawing themselves in real time\nSubtitle-safe center corridor'
  },
  style_6_obsidian: {
    name: 'Obsidian Mirror',
    desc: 'Polished dark reflective surfaces, confrontational stillness, bone-white light. Best for: self-honesty, truth, clarity.',
    keywords: ['reflection', 'mirror', 'truth', 'honest', 'confront', 'face', 'clarity', 'reveal', 'acknowledge', 'see'],
    prompt: concept => `Create a cinematic reel about ${concept} — polished obsidian and dark mirror surfaces, a figure standing before their distorted reflection, bone-white light source, deep crimson shadow accents, meditative stillness, 4K, no text overlays.`,
    negative: 'text, words, logos, bright colors, busy patterns, rapid cuts',
    sceneNotes: 'Camera: slow pull-back reveal, symmetrical framing\nMotion: minimal and contemplative\nMirror symmetry for maximum psychological impact'
  }
};

const DURATION_NOTES = {
  15: '15s — maximum completion rate for hook-led clips.',
  30: '30s — balanced reach and retention.',
  38: '38s — engine default sweet spot for full narrative arc.',
  60: '60s — deeper storytelling with lower completion rates.'
};

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureStyleCard(styleId) {
  if (document.querySelector(`.style-card[data-style="${styleId}"]`)) return;
  const style = STYLES[styleId];
  if (!style) return;
  const grid = document.getElementById('styleGrid');
  if (!grid) return;
  const card = document.createElement('div');
  card.className = 'style-card';
  card.dataset.style = styleId;
  card.innerHTML = `<div class="style-name">${escapeHtml(style.name)}</div><div class="style-desc">${escapeHtml(style.desc)}</div>`;
  grid.appendChild(card);
}

async function loadEngineConfig() {
  try {
    const res = await fetch('./engine/viral-reel-engine.json');
    if (!res.ok) return;
    const cfg = await res.json();
    const engine = cfg?.engine;
    if (!engine) return;

    const styleLibrary = engine.style_library;
    if (styleLibrary && typeof styleLibrary === 'object') {
      for (const [styleId, value] of Object.entries(styleLibrary)) {
        // Merge into existing STYLES entry (or create one if missing)
        if (!STYLES[styleId]) {
          STYLES[styleId] = {
            name: value.label || styleId,
            desc: value.description || '',
            keywords: [],
            prompt: concept => (value.base_prompt || '').replace(/\bQUOTE\b/g, concept),
            negative: 'text, words, logos, watermark',
            sceneNotes: value.camera_notes || ''
          };
        }
        if (typeof value.label === 'string') STYLES[styleId].name = value.label;
        if (typeof value.description === 'string') STYLES[styleId].desc = value.description;
        if (typeof value.base_prompt === 'string') {
          STYLES[styleId].prompt = concept => value.base_prompt.replace(/\bQUOTE\b/g, concept);
        }
        if (Array.isArray(value.keywords)) {
          STYLES[styleId].keywords = value.keywords.filter(item => typeof item === 'string');
        }
        if (typeof value.camera_notes === 'string') STYLES[styleId].sceneNotes = value.camera_notes;
        // Ensure DOM card exists for this style
        ensureStyleCard(styleId);
      }
    }

    const durationDefault = toNumber(engine?.virality_data?.duration_strategy?.engine_default_seconds);
    if (Number.isInteger(durationDefault) && durationDefault > 0) {
      if (!DURATION_NOTES[durationDefault]) {
        DURATION_NOTES[durationDefault] = `${durationDefault}s — engine default duration.`;
      }
      const defaultBtn = document.querySelector(`.dur-btn[data-dur="${durationDefault}"]`);
      if (defaultBtn) {
        selectedDuration = durationDefault;
        document.querySelectorAll('.dur-btn').forEach(btn => btn.classList.remove('active'));
        defaultBtn.classList.add('active');
        document.getElementById('durNote').textContent = DURATION_NOTES[durationDefault];
      }
    }

    refreshStyleCards();
  } catch {
    // fallback to static defaults
  }
}

function refreshStyleCards() {
  document.querySelectorAll('.style-card').forEach(card => {
    const id = card.dataset.style;
    const style = id ? STYLES[id] : undefined;
    if (!style) return;
    const name = card.querySelector('.style-name');
    const desc = card.querySelector('.style-desc');
    if (name) name.textContent = style.name;
    if (desc) desc.textContent = style.desc;
  });
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function selectStyle(styleId, manual) {
  if (!STYLES[styleId]) return;
  if (manual) manualStyleOverride = true;
  selectedStyle = styleId;
  document.querySelectorAll('.style-card').forEach(card => card.classList.remove('active', 'auto-selected'));
  const card = document.querySelector(`.style-card[data-style="${styleId}"]`);
  if (card) {
    card.classList.add('active');
    if (!manual) card.classList.add('auto-selected');
  }
}

function selectDuration(duration) {
  selectedDuration = duration;
  document.querySelectorAll('.dur-btn').forEach(btn => btn.classList.remove('active'));
  const btn = document.querySelector(`.dur-btn[data-dur="${duration}"]`);
  if (btn) btn.classList.add('active');
  document.getElementById('durNote').textContent = DURATION_NOTES[duration] ?? `${duration}s selected.`;
}

function autoSelectStyle(concept) {
  if (manualStyleOverride) return;
  const c = concept.toLowerCase();
  const scores = Object.fromEntries(Object.keys(STYLES).map(styleId => [styleId, 0]));

  for (const [styleId, style] of Object.entries(STYLES)) {
    for (const keyword of style.keywords) {
      if (c.includes(keyword.toLowerCase())) scores[styleId] += 1;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] ?? selectedStyle;
  selectStyle(best, false);
}

function parseTs(ts) {
  const [m, s] = ts.split(':').map(Number);
  return (m * 60) + s;
}

function fmtTs(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function scaleSegments(segments, targetSeconds, baseSeconds = 38) {
  const factor = targetSeconds / baseSeconds;
  return segments.map(seg => ({
    ...seg,
    start: fmtTs(parseTs(seg.start) * factor),
    end: fmtTs(parseTs(seg.end) * factor)
  }));
}

function getCoreMetaphor(concept) {
  const c = concept.toLowerCase();
  if (c.includes('water')) return 'Water does not fight the mountain.';
  if (c.includes('fire')) return 'Fire does not negotiate with the cold.';
  if (c.includes('river')) return 'The river does not ask permission.';
  return 'The force that moves worlds does not announce itself.';
}

function getIdentityClose(concept) {
  const c = concept.toLowerCase();
  if (c.includes('water')) return 'Be the water.';
  if (c.includes('fire')) return 'Be the fire.';
  if (c.match(/mountain|rock|stone/)) return 'Be the mountain.';
  if (c.match(/discipl|habit/)) return 'Be the discipline.';
  return 'Be the force.';
}

function getCorePrinciple(concept) {
  const c = concept.toLowerCase();
  if (c.match(/discipl|habit/)) return 'discipline';
  if (c.match(/focus|vision/)) return 'singular focus';
  if (c.match(/patience|slow|time/)) return 'patience';
  return 'relentless consistency';
}

function generateVoiceover(concept, duration) {
  const c = concept.toLowerCase();
  const isNature = c.match(/water|mountain|river|earth|wind|ocean|storm/);
  const isForge   = c.match(/forge|fire|heat|pressure|blacksmith|molten|iron|craft|hammer|steel|make|build/);
  const isTransform = c.match(/transform|become|fear|overcome|break|rise|courage|warrior|reflection|mirror|truth|honest/);
  const isBlueprint = c.match(/plan|design|architect|framework|structure|system|strategy|foundation|construct|engineer/);

  let segments;
  if (isForge) {
    segments = [
      { start: '0:00', end: '0:03', text: 'Nothing of value was ever made without heat.', note: 'Striking opener.' },
      { start: '0:03', end: '0:10', text: 'The blacksmith does not wish the iron were softer. He turns up the fire.', note: 'Core reframe.' },
      { start: '0:10', end: '0:18', text: 'Every blow is information. Every resistance is instruction.', note: 'Three-beat rhythm.' },
      { start: '0:18', end: '0:26', text: 'The people who complain about the pressure are the ones who never become the blade.', note: 'Contrast landing.' },
      { start: '0:26', end: '0:34', text: 'You are not being destroyed. You are being formed.', note: 'Reframe payoff.' },
      { start: '0:34', end: '0:38', text: 'Welcome the forge. Do the work.', note: 'Direct close.' }
    ];
  } else if (isBlueprint) {
    segments = [
      { start: '0:00', end: '0:03', text: 'Amateurs react. Architects design.', note: 'Contrast hook.' },
      { start: '0:03', end: '0:10', text: `The person who controls the blueprint controls the outcome.`, note: 'Core principle.' },
      { start: '0:10', end: '0:18', text: 'Start with the end in mind. Work backward. Remove everything that does not serve the structure.', note: 'Framework beat.' },
      { start: '0:18', end: '0:26', text: 'The most powerful move you will ever make is deciding on purpose — before the pressure arrives.', note: 'Depth moment.' },
      { start: '0:26', end: '0:34', text: 'Build the system. Trust the system. Become the system.', note: 'Triplet rhythm.' },
      { start: '0:34', end: '0:38', text: 'Draw the blueprint. Then build it.', note: 'Action close.' }
    ];
  } else if (isNature) {
    segments = [
      { start: '0:00', end: '0:03', text: 'What if the most unstoppable force in the world made no sound at all?', note: 'Calm opening hook.' },
      { start: '0:03', end: '0:10', text: `${getCoreMetaphor(concept)} It never stops showing up.`, note: 'Measured cadence.' },
      { start: '0:10', end: '0:18', text: 'It finds the smallest opening and returns tomorrow.', note: 'Emphasize persistence.' },
      { start: '0:18', end: '0:26', text: 'Given enough time, what looked immovable yields.', note: 'Land the payoff.' },
      { start: '0:26', end: '0:34', text: 'Results often appear right when people are about to quit.', note: 'Mirror moment.' },
      { start: '0:34', end: '0:38', text: `${getIdentityClose(concept)} Show up every day.`, note: 'Authoritative close.' }
    ];
  } else if (isTransform) {
    segments = [
      { start: '0:00', end: '0:03', text: 'The version of you that wins is already inside you.', note: 'Confident opener.' },
      { start: '0:03', end: '0:10', text: 'You are not failing. You are becoming.', note: 'Reframe.' },
      { start: '0:10', end: '0:18', text: 'Every setback was data. Every rejection was direction.', note: 'Three-beat rhythm.' },
      { start: '0:18', end: '0:26', text: 'When you stop asking why me and start asking what now, everything changes.', note: 'Pivot point.' },
      { start: '0:26', end: '0:34', text: 'You are not behind. You are mid-transformation.', note: 'Validation.' },
      { start: '0:34', end: '0:38', text: `${getIdentityClose(concept)} Do the work.`, note: 'Direct ending.' }
    ];
  } else {
    segments = [
      { start: '0:00', end: '0:03', text: 'Most people miss the real secret of success.', note: 'Curiosity hook.' },
      { start: '0:03', end: '0:10', text: `It is not intensity. It is ${getCorePrinciple(concept)}.`, note: 'Core principle.' },
      { start: '0:10', end: '0:18', text: 'One percent better every day. Not perfect. Just consistent.', note: 'Rhythmic sequence.' },
      { start: '0:18', end: '0:26', text: 'In a year, those small gains compound into something unrecognizable.', note: 'Compounding payoff.' },
      { start: '0:26', end: '0:34', text: 'You already know what to do. Build the habit.', note: 'Mirror + command.' },
      { start: '0:34', end: '0:38', text: `${getIdentityClose(concept)} Be the moment.`, note: 'Final line.' }
    ];
  }

  return duration === 38 ? segments : scaleSegments(segments, duration, 38);
}

function generateCaption(concept) {
  const c = concept.toLowerCase();
  if (c.match(/water|river|ocean/)) {
    return `The river does not rush. It just never stops.\n\nShow up on the quiet days. Those are the days that change everything.\n\nSave this for the day you want to quit. 💧\n\n#motivation #mindset #discipline #resilience #reels #growth`;
  }
  if (c.match(/transform|become|overcome/)) {
    return `You are not behind. You are mid-transformation.\n\nStop judging your chapter 1 against someone else's chapter 10.\n\nTag someone who needs this. 🔥\n\n#motivation #selfgrowth #discipline #mindset #reels #transformation`;
  }
  if (c.match(/forge|fire|heat|pressure|blacksmith|molten|iron|craft|hammer|steel/)) {
    return `Nothing of value was made without resistance.\n\nYou are not being destroyed. You are being formed.\n\nSave this for the days it gets heavy. 🔥\n\n#motivation #discipline #grind #mindset #reels #resilience`;
  }
  if (c.match(/plan|design|architect|framework|strategy|foundation|system/)) {
    return `Amateurs react. Architects design.\n\nBuild the plan before the pressure arrives.\n\nSave this for your next reset. 📐\n\n#motivation #strategy #mindset #discipline #reels #growth`;
  }
  return `Success is not an event. It is a direction.\n\nThe person you become is built in the quiet work.\n\nSave this and come back to it. 🏆\n\n#motivation #mindset #success #discipline #reels #consistency`;
}

function renderSuggestions() {
  const nextIdeas = [
    { concept: 'The value of silence — most people talk, winners are building', style: 'HUD Neural Grid' },
    { concept: 'Pressure creates diamonds — everything valuable was forged under weight', style: 'Identity & Shadow Self' },
    { concept: 'You were not built for comfort — discomfort is the signal you are growing', style: 'Fractal Gold Architecture' }
  ];

  document.getElementById('suggestions').innerHTML = nextIdeas.map(item => `
    <div class="suggestion" data-concept="${escapeHtml(item.concept)}">
      <div>
        <div class="sug-text">${escapeHtml(item.concept)}</div>
        <div class="sug-style">${escapeHtml(item.style)}</div>
      </div>
      <div class="sug-arrow">→</div>
    </div>
  `).join('');
}

function generateReel() {
  const conceptInput = document.getElementById('conceptInput');
  const concept = conceptInput.value.trim();
  if (!concept || concept.length < 15) {
    conceptInput.focus();
    conceptInput.style.borderColor = 'var(--crimson)';
    setTimeout(() => { conceptInput.style.borderColor = ''; }, 1500);
    return;
  }

  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating...';

  setTimeout(() => {
    const style = STYLES[selectedStyle];
    const segments = generateVoiceover(concept, selectedDuration);
    const fullScript = normalizeWhitespace(segments.map(seg => seg.text).join(' '));
    const caption = generateCaption(concept);
    const wordCount = fullScript.split(' ').filter(Boolean).length;

    currentReel = {
      reel_id: `reel_${Date.now()}`,
      createdDate: new Date().toISOString().split('T')[0],
      concept,
      style_id: selectedStyle,
      style_name: style.name,
      duration_seconds: selectedDuration,
      visual_prompt: style.prompt(concept),
      negative_prompt: style.negative,
      scene_notes: style.sceneNotes,
      voiceover: {
        segments,
        full_text: fullScript,
        word_count: wordCount
      },
      instagram_caption: caption,
      elevenLabs: {
        model: 'eleven_multilingual_v2',
        voice: 'Adam (pNInz6obpgDQGcFmaJgB)',
        stability: 0.42,
        similarity_boost: 0.8,
        style: 0.6,
        speed: 0.88
      }
    };

    document.getElementById('outputTitle').textContent = concept.slice(0, 50) + (concept.length > 50 ? '...' : '');
    document.getElementById('metaStyle').textContent = style.name;
    document.getElementById('metaDuration').textContent = `${selectedDuration}s`;
    document.getElementById('metaWords').textContent = `${wordCount} words`;

    document.getElementById('visualPrompt').textContent = style.prompt(concept);
    document.getElementById('negativePrompt').textContent = style.negative;
    document.getElementById('sceneNotes').textContent = style.sceneNotes;

    document.getElementById('fullScript').textContent = fullScript;
    document.getElementById('scriptTimeline').innerHTML = segments.map(seg => `
      <div class="segment">
        <div class="seg-time">${seg.start}–${seg.end}</div>
        <div>
          <div class="seg-text">${seg.text}</div>
          <div class="seg-note">${seg.note}</div>
        </div>
      </div>
    `).join('');

    document.getElementById('elSettings').textContent = `Model: eleven_multilingual_v2\nVoice: Adam (pNInz6obpgDQGcFmaJgB)\nStability: 0.42\nSimilarity Boost: 0.80\nStyle: 0.60\nSpeed: 0.88`;
    document.getElementById('igCaption').textContent = caption;

    document.getElementById('subtitleConfig').textContent = `Enabled: true\nFont: Montserrat-Bold\nMax words per line: 4\nHighlight color: #FFD700\nPosition: bottom_center`;

    const checks = [
      'Generate visual clips in Runway using the prompt',
      'Generate narration in ElevenLabs with listed settings',
      'Normalize audio to -14 LUFS and mix music at -18 dB',
      'Merge final reel at 1080x1920 H.264 + AAC',
      'Publish and engage comments in first 30 minutes'
    ];
    document.getElementById('checklist').innerHTML = checks.map((item, index) => `
      <div class="check-item">
        <div class="check-num">${index + 1}</div>
        <div class="check-text">${item}</div>
      </div>
    `).join('');

    const videoCost = selectedDuration <= 15 ? 0.9 : selectedDuration <= 30 ? 1.6 : selectedDuration <= 38 ? 2.1 : 2.9;
    const total = videoCost + 0.07 + 0.06;
    document.getElementById('costVideo').textContent = `$${videoCost.toFixed(2)}`;
    document.getElementById('costTotal').textContent = `~$${total.toFixed(2)}`;

    renderSuggestions();
    document.getElementById('output').classList.add('visible');
    document.getElementById('output').scrollIntoView({ behavior: 'smooth', block: 'start' });

    btn.disabled = false;
    btn.textContent = 'Generate Production Package';
  }, 600);
}

function loadSuggestion(concept) {
  const input = document.getElementById('conceptInput');
  input.value = concept;
  document.getElementById('charCount').textContent = concept.length;
  manualStyleOverride = false;
  autoSelectStyle(concept);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function switchTab(tab, tabButton) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  tabButton?.classList.add('active');
}

function copyBlock(id, button) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent ?? '').then(() => {
    button.textContent = 'Copied ✓';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('copied');
    }, 2000);
  });
}

function exportJSON() {
  if (!currentReel) return;
  const blob = new Blob([JSON.stringify(currentReel, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${currentReel.reel_id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}



// ══════════════════════════════════════════════════════════════
// ADAPTATION SUGGESTION ENGINE
// ══════════════════════════════════════════════════════════════

const STYLE_TONE_VERBS = {
  style_1_fractal:  ['dissolves', 'expands', 'spirals', 'returns', 'flows'],
  style_2_identity: ['rises', 'transforms', 'emerges', 'becomes', 'chooses'],
  style_3_hud:      ['calculates', 'executes', 'optimizes', 'processes', 'deploys'],
  style_4_forge:    ['hammers', 'shapes', 'forges', 'endures', 'hardens'],
  style_5_blueprint:['designs', 'builds', 'constructs', 'architects', 'engineers'],
  style_6_obsidian: ['reflects', 'confronts', 'reveals', 'acknowledges', 'faces']
};

const EXTENSION_TEMPLATES = {
  style_1_fractal: [
    { placement: 'After the opening hook', text: 'Every pattern in nature repeats this truth — at every scale, the same principle holds. Nothing is exempt. Nothing escapes the geometry.' },
    { placement: 'Middle — consequence beat', text: 'The people who understand this stop fighting the current. They read it. They let it carry them further than effort alone ever could.' },
    { placement: 'Before the close', text: 'This is not philosophy. This is physics. The universe runs on this rule whether you acknowledge it or not.' }
  ],
  style_2_identity: [
    { placement: 'After the opening hook', text: 'The version of you that wins already exists. It was forged in the moments you kept going when every signal said stop.' },
    { placement: 'Middle — consequence beat', text: 'Most people wait for the feeling. The person who wins shows up before the feeling arrives — and that is the entire difference.' },
    { placement: 'Before the close', text: 'Identity is not what you say you are. It is the pattern of what you do when no one is watching and nothing is guaranteed.' }
  ],
  style_3_hud: [
    { placement: 'After the opening hook', text: 'The mind is a system. Every input creates an output. Control the inputs long enough and the outputs stop surprising you.' },
    { placement: 'Middle — consequence beat', text: 'Emotion is data. Discipline is a protocol. The person who separates the two gets to operate without interference from either.' },
    { placement: 'Before the close', text: 'You already have the processing power. What most people lack is the clarity to run the right program.' }
  ],
  style_4_forge: [
    { placement: 'After the opening hook', text: 'The blacksmith does not curse the iron for being hard. The resistance is the material. The resistance is the point.' },
    { placement: 'Middle — consequence beat', text: 'Every time you wanted to quit and did not — that was a strike. You were building something. You may not have known it yet.' },
    { placement: 'Before the close', text: 'The ones who cannot handle the heat never find out what they could have become. You are still here. That means something.' }
  ],
  style_5_blueprint: [
    { placement: 'After the opening hook', text: 'The mistake most people make is starting to build before they have the blueprint. Then they wonder why the structure keeps collapsing.' },
    { placement: 'Middle — consequence beat', text: 'Clarity is not a luxury. It is load-bearing. Remove it and the entire system shifts. Install it and everything downstream becomes easier.' },
    { placement: 'Before the close', text: 'Design your environment, your inputs, your defaults. The person who architects their own context does not need motivation — the system provides direction.' }
  ],
  style_6_obsidian: [
    { placement: 'After the opening hook', text: 'The mirror does not lie. It only shows what you have been unwilling to look at long enough to understand.' },
    { placement: 'Middle — consequence beat', text: 'The patterns you keep repeating are not accidents. They are answers to questions you have not asked yourself yet.' },
    { placement: 'Before the close', text: 'This is not about judgment. It is about information. What you see in that reflection is the exact data you need to move forward.' }
  ]
};

function getStyleAlignment(concept, selectedStyleId) {
  if (!concept || concept.length < 10) return null;
  const c = concept.toLowerCase();
  const scores = {};
  for (const [styleId, style] of Object.entries(STYLES)) {
    scores[styleId] = 0;
    for (const kw of (style.keywords || [])) {
      if (c.includes(kw.toLowerCase())) scores[styleId]++;
    }
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestId, bestScore] = sorted[0] || [];
  if (bestId && bestId !== selectedStyleId && bestScore > 0) {
    return { suggestedId: bestId, suggestedName: STYLES[bestId]?.name, score: bestScore };
  }
  return null;
}

function getScriptExtensions(styleId, wordGap) {
  const templates = EXTENSION_TEMPLATES[styleId] || EXTENSION_TEMPLATES.style_1_fractal;
  // Pick how many lines based on gap
  const linesNeeded = wordGap <= 30 ? 1 : wordGap <= 60 ? 2 : 3;
  return templates.slice(0, linesNeeded);
}

function getPlatformFormatNotes(target) {
  const notes = [];
  if (target < 15) {
    notes.push({ type: 'format', title: 'Duration very short: < 15s', body: 'Under 15s limits narrative arc. Consider 30s minimum for a complete message.' });
  } else if (target > 60) {
    notes.push({ type: 'format', title: 'Duration over 60s — completion rate risk', body: 'Instagram Reels above 60s see significantly lower watch-through rates. 38s is the engine sweet spot. Consider splitting into two reels.' });
  } else if (target >= 35 && target <= 42) {
    notes.push({ type: 'format', title: `${target}s — optimal range`, body: 'This duration sits in the 35-42s sweet spot: enough for a full narrative arc while maintaining strong completion rates.' });
  }
  return notes;
}

function buildAdaptationSuggestions(spec) {
  const concept = spec.concept || spec.theme || '';
  const styleId  = spec.style_id || selectedStyle;
  const target   = spec.target_duration_seconds || spec.duration_seconds || 38;
  const voiceText = spec.voiceover?.full_text || spec.voiceover_script || spec.script || '';
  const { words, seconds } = voiceText ? estimateAudioDuration(voiceText) : { words: 0, seconds: 0 };
  const wordsNeeded = Math.ceil(target * WORDS_PER_SECOND);
  const wordGap = wordsNeeded - words;

  const suggestions = [];

  // A. Style alignment
  const alignment = getStyleAlignment(concept, styleId);
  if (alignment) {
    suggestions.push({
      type: 'style',
      badge: 'Style',
      title: `Keyword match suggests: ${alignment.suggestedName}`,
      body: `Your concept keywords align more closely with "${alignment.suggestedName}" (${alignment.score} keyword hit${alignment.score > 1 ? 's' : ''}). Your current style is "${STYLES[styleId]?.name || styleId}". Both can work — this is a suggestion.`,
      switchTo: alignment.suggestedId
    });
  }

  // B. Script extensions (only if there is an actual gap)
  if (voiceText && wordGap > 15) {
    const lines = getScriptExtensions(styleId, wordGap);
    suggestions.push({
      type: 'script',
      badge: 'Script',
      title: `Add ~${wordGap} words to reach ${target}s — ${lines.length} insertion point${lines.length > 1 ? 's' : ''}`,
      body: `At ${WORDS_PER_SECOND} words/sec, you need ~${wordsNeeded} words for ${target}s. Current script is ${words} words (~${seconds}s). Insert the lines below in the indicated positions.`,
      insertions: lines.map(l => ({
        ...l,
        words: l.text.split(' ').length
      }))
    });
  }

  // C. Platform format notes
  const formatNotes = getPlatformFormatNotes(target);
  for (const note of formatNotes) {
    suggestions.push({ type: 'format', badge: 'Format', title: note.title, body: note.body });
  }

  return suggestions;
}

function renderAdaptationSuggestions(suggestions) {
  const container = document.getElementById('adaptationPanel');
  if (!container) return;
  if (!suggestions || suggestions.length === 0) {
    container.innerHTML = '';
    return;
  }

  const itemsHtml = suggestions.map(s => {
    const insertHtml = s.insertions ? s.insertions.map(ins => `
      <div class="adapt-insert">
        <div class="adapt-insert-label">${escapeHtml(ins.placement)}</div>
        <div class="adapt-insert-line">"${escapeHtml(ins.text)}"</div>
        <div class="adapt-insert-word-count">+${ins.words} words (~${Math.round(ins.words / WORDS_PER_SECOND)}s)</div>
      </div>
    `).join('') : '';

    const switchHtml = s.switchTo ? `
      <div class="adapt-style-switch">
        <button type="button" class="btn-switch-style" onclick="selectStyle('${escapeHtml(s.switchTo)}', true)">
          Switch to ${escapeHtml(STYLES[s.switchTo]?.name || s.switchTo)}
        </button>
      </div>
    ` : '';

    return `
      <div class="adapt-item">
        <div class="adapt-item-header">
          <div class="adapt-badge ${s.type}">${s.badge}</div>
          <div class="adapt-item-title">${escapeHtml(s.title)}</div>
        </div>
        <div class="adapt-item-body">${escapeHtml(s.body)}</div>
        ${insertHtml}
        ${switchHtml}
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="adapt-panel">
      <div class="adapt-panel-header">
        <div class="adapt-panel-label">Adaptation Suggestions</div>
        <div class="adapt-panel-sub">${suggestions.length} recommendation${suggestions.length > 1 ? 's' : ''}</div>
      </div>
      <div class="adapt-suggestions">${itemsHtml}</div>
    </div>
  `;
}

// ── SPEAKING RATE ── ~2.3 words/second for motivational content
const WORDS_PER_SECOND = 2.3;

function estimateAudioDuration(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return { words, seconds: Math.round(words / WORDS_PER_SECOND) };
}

function buildValidationReport(spec) {
  const rows = [];
  const concept = spec.concept || spec.theme || '';
  const styleId = spec.style_id || '';
  const target = spec.target_duration_seconds || spec.duration_seconds || 38;
  const voiceoverText = spec.voiceover?.full_text || spec.voiceover_script || spec.script || '';

  // 1. Concept present
  if (concept.trim().length > 10) {
    rows.push({ status: 'ok', icon: '✓', title: 'Concept found', detail: `"${concept.slice(0, 80)}${concept.length > 80 ? '…' : ''}"` });
  } else {
    rows.push({ status: 'warn', icon: '⚠', title: 'Concept missing or too short', detail: 'No concept text found. Fill in the concept field manually.' });
  }

  // 2. Style valid
  if (styleId && STYLES[styleId]) {
    rows.push({ status: 'ok', icon: '✓', title: `Style: ${STYLES[styleId].name}`, detail: `style_id: ${styleId}` });
  } else if (styleId) {
    rows.push({ status: 'warn', icon: '⚠', title: `Unknown style: ${styleId}`, detail: 'This style ID is not in the current library. Style_1_fractal will be used.' });
  } else {
    rows.push({ status: 'warn', icon: '⚠', title: 'No style_id specified', detail: 'Auto-select will be used based on concept keywords.' });
  }

  // 3. Duration vs script length
  if (voiceoverText.trim().length > 0) {
    const { words, seconds } = estimateAudioDuration(voiceoverText);
    const ratio = seconds / target;
    const wordsNeeded = Math.ceil(target * WORDS_PER_SECOND);
    const wordGap = wordsNeeded - words;

    if (ratio >= 0.88) {
      rows.push({ status: 'ok', icon: '✓', title: `Duration looks good: ~${seconds}s audio vs ${target}s target`, detail: `${words} words at ${WORDS_PER_SECOND} w/s ≈ ${seconds}s` });
    } else if (ratio >= 0.65) {
      rows.push({
        status: 'warn', icon: '⚠',
        title: `Script short: ~${seconds}s audio vs ${target}s target`,
        detail: `${words} words → ~${seconds}s. Target needs ~${wordsNeeded} words.`,
        fix: `Add ~${wordGap} words to the voiceover script.\nTip: extend the middle section — add a second example or deeper consequence beat.`
      });
    } else {
      rows.push({
        status: 'error', icon: '✗',
        title: `Script too short: ~${seconds}s audio vs ${target}s target`,
        detail: `${words} words → ~${seconds}s. Reel will be ${target - seconds}s shorter than intended.`,
        fix: `Add ~${wordGap} words (${Math.round(wordGap / WORDS_PER_SECOND)}s of extra speech).\nConsider: set target_duration_seconds to ${seconds} to match the existing script, OR\nextend the script with 2-3 more sentences in the middle.`
      });
    }
  } else {
    rows.push({ status: 'warn', icon: '⚠', title: 'No voiceover script found', detail: 'Cannot estimate audio duration. The engine will generate a new script.' });
  }

  // 4. Credits check
  const clips = Math.ceil(target / 10);
  const credits = clips * 120;
  rows.push({ status: 'ok', icon: '◆', title: `Estimated cost: ${credits} Runway credits`, detail: `${clips} clips × 120 credits = ${credits} total for ${target}s` });

  return rows;
}

function renderValidationReport(rows) {
  const container = document.getElementById('validationReport');
  if (!container) return;
  container.innerHTML = rows.map(row => `
    <div class="val-row ${row.status}">
      <div class="val-icon">${row.icon}</div>
      <div class="val-text">
        <strong>${escapeHtml(row.title)}</strong>
        ${escapeHtml(row.detail)}
        ${row.fix ? `<div class="val-fix">${escapeHtml(row.fix)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function loadSpec() {
  const raw = document.getElementById('jsonPasteArea')?.value?.trim();
  if (!raw) return;

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    renderValidationReport([{ status: 'error', icon: '✗', title: 'Invalid JSON', detail: `Parse error: ${e.message}` }]);
    return;
  }

  // Populate fields
  const concept = spec.concept || spec.theme || '';
  if (concept) {
    const input = document.getElementById('conceptInput');
    if (input) {
      input.value = concept;
      document.getElementById('charCount').textContent = String(concept.length);
    }
  }

  const styleId = spec.style_id || '';
  if (styleId && STYLES[styleId]) {
    selectStyle(styleId, true);
  } else if (concept) {
    manualStyleOverride = false;
    autoSelectStyle(concept);
  }

  const duration = spec.target_duration_seconds || spec.duration_seconds;
  if (duration && DURATION_NOTES[duration] !== undefined || duration) {
    // Add to DURATION_NOTES if not present
    if (!DURATION_NOTES[duration]) DURATION_NOTES[duration] = `${duration}s — from imported spec.`;
    selectDuration(duration);
  }

  // Run validation
  const rows = buildValidationReport(spec);
  renderValidationReport(rows);

  // Run adaptation suggestions
  const suggestions = buildAdaptationSuggestions(spec);
  renderAdaptationSuggestions(suggestions);

  // Scroll to form
  document.getElementById('importCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setupImportPanel() {
  const toggle = document.getElementById('importToggle');
  const body = document.getElementById('importBody');
  const chevron = document.getElementById('importChevron');
  const loadBtn = document.getElementById('loadSpecBtn');

  if (toggle && body && chevron) {
    toggle.addEventListener('click', () => {
      const isOpen = body.classList.toggle('open');
      chevron.classList.toggle('open', isOpen);
    });
  }

  if (loadBtn) loadBtn.addEventListener('click', loadSpec);
}

function setupUiEvents() {
  const conceptInput = document.getElementById('conceptInput');
  conceptInput.addEventListener('input', () => {
    const value = conceptInput.value;
    document.getElementById('charCount').textContent = String(value.length);
    if (value.length > 20) autoSelectStyle(value);
  });

  document.getElementById('generateBtn').addEventListener('click', generateReel);
  document.getElementById('exportBtn').addEventListener('click', exportJSON);

  // Direct listeners on style cards (belt-and-suspenders alongside delegation)
  document.querySelectorAll('.style-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.style) selectStyle(card.dataset.style, true);
    });
  });

  // Direct listeners on dur-btns
  document.querySelectorAll('.dur-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.dur) selectDuration(Number(btn.dataset.dur));
    });
  });

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const styleCard = target.closest('.style-card');
    if (styleCard instanceof HTMLElement && styleCard.dataset.style) {
      selectStyle(styleCard.dataset.style, true);
      return;
    }

    const durationButton = target.closest('.dur-btn');
    if (durationButton instanceof HTMLElement && durationButton.dataset.dur) {
      selectDuration(Number(durationButton.dataset.dur));
      return;
    }

    const tab = target.closest('.tab');
    if (tab instanceof HTMLElement && tab.dataset.tab) {
      switchTab(tab.dataset.tab, tab);
      return;
    }

    const copyButton = target.closest('.btn-copy');
    if (copyButton instanceof HTMLElement && copyButton.dataset.copyTarget) {
      copyBlock(copyButton.dataset.copyTarget, copyButton);
      return;
    }

    const suggestion = target.closest('.suggestion');
    if (suggestion instanceof HTMLElement && suggestion.dataset.concept) {
      loadSuggestion(suggestion.dataset.concept);
    }
  });
}

setupUiEvents();
setupImportPanel();
refreshStyleCards();
selectStyle('style_1_fractal', false);
selectDuration(38);
loadEngineConfig();
