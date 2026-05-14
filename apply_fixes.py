import re, sys, pathlib

ROOT = pathlib.Path(r'C:\Users\nkrum\AppData\Local\Temp\dreamforge-fix')

# ── 1. lib/runway-resilience.ts ───────────────────────────────────────────
rr = ROOT / 'lib' / 'runway-resilience.ts'
src = rr.read_text(encoding='utf-8')

src = src.replace(
    'const THROTTLED_RUNWAY_POLL_DELAY_MS = 30_000; // back off harder when server is throttling',
    'const THROTTLED_RUNWAY_POLL_DELAY_MS = 45_000; // back off harder when server is throttling'
)
rr.write_text(src, encoding='utf-8')
print('OK lib/runway-resilience.ts')

# ── 2. generate-reel.ts ───────────────────────────────────────────────────
gr = ROOT / 'generate-reel.ts'
src = gr.read_text(encoding='utf-8')

# 2a: add unlinkSync to fs import
src = src.replace(
    "import { writeFileSync, readFileSync, existsSync, appendFileSync, copyFileSync } from 'node:fs';",
    "import { writeFileSync, readFileSync, existsSync, appendFileSync, copyFileSync, unlinkSync } from 'node:fs';"
)

# 2b: increase per-clip timeout 10 min -> 25 min
src = src.replace(
    "const RUNWAY_TIMEOUT_MS          = 600_000; // 10 min — THROTTLED tasks need time to queue",
    "const RUNWAY_TIMEOUT_MS          = 1_500_000; // 25 min — THROTTLED tasks can queue for a long time"
)

# 2c: add CLIP_CHECKPOINT_PATH constant
src = src.replace(
    "const RUNWAY_MAX_TASK_ATTEMPTS   = 4;",
    "const RUNWAY_MAX_TASK_ATTEMPTS   = 4;\n"
    "const CLIP_CHECKPOINT_PATH       = process.env.CLIP_CHECKPOINT_PATH ?? join(TMP, 'runway-clip-checkpoint.json');"
)

# 2d: add checkpoint helpers after sleep()
SLEEP_LINE = "const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));"
HELPERS = """

// ── Clip checkpoint -- persists completed clip paths across attempts/runs ──
function loadClipCheckpoint(): Record<number, string> {
  try {
    if (existsSync(CLIP_CHECKPOINT_PATH)) {
      const raw = JSON.parse(readFileSync(CLIP_CHECKPOINT_PATH, 'utf-8')) as Record<string, string>;
      return Object.fromEntries(Object.entries(raw).map(([k, v]) => [Number(k), v]));
    }
  } catch { /* ignore corrupt checkpoint */ }
  return {};
}

function saveClipCheckpoint(clipIndex: number, videoPath: string): void {
  const checkpoint = loadClipCheckpoint();
  checkpoint[clipIndex] = videoPath;
  writeFileSync(CLIP_CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
  console.log(`         checkpoint: clip[${clipIndex + 1}] saved`);
}
"""
src = src.replace(SLEEP_LINE, SLEEP_LINE + HELPERS)

# 2e: replace generateRunwayClipsBounded
OLD_FN = (
    "async function generateRunwayClipsBounded(scenePlan: ReelScenePlan[]): Promise<string[]> {\n"
    "  const { runwayConcurrency: concurrency } = getConfig();\n"
    "  const clipPaths = new Array<string>(scenePlan.length);\n"
    "  let nextIndex = 0;\n"
    "\n"
    "  console.log(`         runway concurrency: ${concurrency}`);\n"
    "\n"
    "  async function worker(): Promise<void> {\n"
    "    while (true) {\n"
    "      const currentIndex = nextIndex;\n"
    "      nextIndex += 1;\n"
    "      if (currentIndex >= scenePlan.length) return;\n"
    "      const scene = scenePlan[currentIndex];\n"
    "      clipPaths[currentIndex] = await generateRunwayClip(scene, scenePlan.length);\n"
    "    }\n"
    "  }\n"
    "\n"
    "  const workers = Array.from(\n"
    "    { length: Math.min(concurrency, scenePlan.length) },\n"
    "    () => worker()\n"
    "  );\n"
    "  await Promise.all(workers);\n"
    "\n"
    "  return clipPaths;\n"
    "}"
)

NEW_FN = (
    "async function generateRunwayClipsBounded(scenePlan: ReelScenePlan[]): Promise<string[]> {\n"
    "  const { runwayConcurrency: concurrency } = getConfig();\n"
    "  const checkpoint = loadClipCheckpoint();\n"
    "  const clipPaths = new Array<string>(scenePlan.length);\n"
    "\n"
    "  // Pre-fill any clips that already completed in a previous run\n"
    "  for (const [idxStr, cachedPath] of Object.entries(checkpoint)) {\n"
    "    const idx = Number(idxStr);\n"
    "    if (idx < scenePlan.length && existsSync(cachedPath)) {\n"
    "      console.log(`         RESUME clip ${idx + 1}/${scenePlan.length}: loaded from checkpoint, skipping Runway`);\n"
    "      clipPaths[idx] = cachedPath;\n"
    "    }\n"
    "  }\n"
    "\n"
    "  let nextIndex = 0;\n"
    "  console.log(`         runway concurrency: ${concurrency}`);\n"
    "\n"
    "  async function worker(): Promise<void> {\n"
    "    while (true) {\n"
    "      const currentIndex = nextIndex;\n"
    "      nextIndex += 1;\n"
    "      if (currentIndex >= scenePlan.length) return;\n"
    "      if (clipPaths[currentIndex]) continue; // already loaded from checkpoint\n"
    "      const scene = scenePlan[currentIndex];\n"
    "      const path = await generateRunwayClip(scene, scenePlan.length);\n"
    "      saveClipCheckpoint(currentIndex, path);\n"
    "      clipPaths[currentIndex] = path;\n"
    "    }\n"
    "  }\n"
    "\n"
    "  const workers = Array.from(\n"
    "    { length: Math.min(concurrency, scenePlan.length) },\n"
    "    () => worker()\n"
    "  );\n"
    "  await Promise.all(workers);\n"
    "\n"
    "  return clipPaths;\n"
    "}"
)

if OLD_FN not in src:
    print('ERROR: generateRunwayClipsBounded not found - content mismatch', file=sys.stderr)
    # show what we have around the function for debug
    idx = src.find('generateRunwayClipsBounded')
    print(repr(src[idx:idx+600]), file=sys.stderr)
    sys.exit(1)
src = src.replace(OLD_FN, NEW_FN)

# 2f: clear checkpoint before the final "Reel ready" log line
REEL_READY = "  console.log(`\U0001f7e0  Reel ready"
if REEL_READY not in src:
    # Try fallback encoding
    REEL_READY = "  console.log(`"
    idx = src.rfind(REEL_READY + "Reel ready")
    if idx == -1:
        idx = src.rfind("Reel ready")
    print(f"  DEBUG reel-ready search idx={idx}")

# find the line
for line in src.splitlines():
    if 'Reel ready' in line and 'console.log' in line:
        REEL_READY = line
        break

src = src.replace(
    REEL_READY,
    "  // Clear checkpoint -- full reel published successfully.\n"
    "  try { unlinkSync(CLIP_CHECKPOINT_PATH); } catch { /* already gone */ }\n\n"
    + REEL_READY
)

gr.write_text(src, encoding='utf-8')
print('OK generate-reel.ts')

# ── 3. .github/workflows/publish-reel.yml ────────────────────────────────
wf = ROOT / '.github' / 'workflows' / 'publish-reel.yml'
src = wf.read_text(encoding='utf-8')

# 3a: add job timeout
src = src.replace(
    '    runs-on: ubuntu-latest',
    '    runs-on: ubuntu-latest\n    timeout-minutes: 120'
)

# 3b: cache restore before generate step
CACHE_RESTORE = (
    "      - name: Restore Runway clip checkpoint\n"
    "        id: cache-clips\n"
    "        uses: actions/cache/restore@v4\n"
    "        with:\n"
    "          path: |\n"
    "            /tmp/runway-clip-checkpoint.json\n"
    "            /tmp/runway-01.mp4\n"
    "            /tmp/runway-02.mp4\n"
    "            /tmp/runway-03.mp4\n"
    "            /tmp/runway-04.mp4\n"
    "            /tmp/runway-05.mp4\n"
    "            /tmp/runway-06.mp4\n"
    "          key: runway-clips-${{ inputs.reel_spec_path || 'env' }}-${{ github.run_id }}\n"
    "          restore-keys: |\n"
    "            runway-clips-${{ inputs.reel_spec_path || 'env' }}-\n"
    "\n"
)
src = src.replace(
    "      - name: Generate voiceover + video",
    CACHE_RESTORE + "      - name: Generate voiceover + video"
)

# 3c: add CLIP_CHECKPOINT_PATH env to generate step
src = src.replace(
    "          REEL_CAPTION:       ${{ inputs.caption }}",
    "          REEL_CAPTION:       ${{ inputs.caption }}\n"
    "          CLIP_CHECKPOINT_PATH: /tmp/runway-clip-checkpoint.json"
)

# 3d: cache save after generate step
CACHE_SAVE = (
    "\n"
    "      - name: Save Runway clip checkpoint\n"
    "        if: always()\n"
    "        uses: actions/cache/save@v4\n"
    "        with:\n"
    "          path: |\n"
    "            /tmp/runway-clip-checkpoint.json\n"
    "            /tmp/runway-01.mp4\n"
    "            /tmp/runway-02.mp4\n"
    "            /tmp/runway-03.mp4\n"
    "            /tmp/runway-04.mp4\n"
    "            /tmp/runway-05.mp4\n"
    "            /tmp/runway-06.mp4\n"
    "          key: runway-clips-${{ inputs.reel_spec_path || 'env' }}-${{ github.run_id }}\n"
    "\n"
)
src = src.replace(
    "      - name: Surface resolved production plan",
    CACHE_SAVE + "      - name: Surface resolved production plan"
)

wf.write_text(src, encoding='utf-8')
print('OK .github/workflows/publish-reel.yml')
print()
print('All patches applied.')
