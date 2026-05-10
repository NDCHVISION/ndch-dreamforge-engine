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
};

const DURATION_NOTES = {
  15: '15s — maximum completion rate for hook-led clips.',
  30: '30s — balanced reach and retention.',
  38: '38s — engine default sweet spot for full narrative arc.',
  60: '60s — deeper storytelling with lower completion rates.'
};

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
        if (!STYLES[styleId]) continue;
        if (typeof value.label === 'string') STYLES[styleId].name = value.label;
        if (typeof value.description === 'string') STYLES[styleId].desc = value.description;
        if (typeof value.base_prompt === 'string') {
          STYLES[styleId].prompt = concept => value.base_prompt.replace(/\bQUOTE\b/g, concept);
        }
        if (Array.isArray(value.keywords)) {
          STYLES[styleId].keywords = value.keywords.filter(item => typeof item === 'string');
        }
      }
    }

    const durationDefault = Number(engine?.virality_data?.duration_strategy?.engine_default_seconds);
    if (Number.isFinite(durationDefault) && durationDefault > 0) {
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
  const isNature = c.match(/water|mountain|river|fire|earth|wind|ocean|storm/);
  const isTransform = c.match(/transform|become|fear|overcome|break|rise|courage|warrior/);

  let segments;
  if (isNature) {
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
    return `You are not behind. You are mid-transformation.\n\nStop judging your chapter 1 against someone else\'s chapter 10.\n\nTag someone who needs this. 🔥\n\n#motivation #selfgrowth #discipline #mindset #reels #transformation`;
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
    <div class="suggestion" data-concept="${item.concept.replace(/"/g, '&quot;')}">
      <div>
        <div class="sug-text">${item.concept}</div>
        <div class="sug-style">${item.style}</div>
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
      created: new Date().toISOString().split('T')[0],
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

function setupUiEvents() {
  const conceptInput = document.getElementById('conceptInput');
  conceptInput.addEventListener('input', () => {
    const value = conceptInput.value;
    document.getElementById('charCount').textContent = String(value.length);
    if (value.length > 20) autoSelectStyle(value);
  });

  document.getElementById('generateBtn').addEventListener('click', generateReel);
  document.getElementById('exportBtn').addEventListener('click', exportJSON);

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
refreshStyleCards();
selectStyle('style_1_fractal', false);
selectDuration(38);
loadEngineConfig();
