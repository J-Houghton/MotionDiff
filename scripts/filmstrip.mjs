#!/usr/bin/env node
// Dev-only visual tooling. Renders fixed moments of the reference clips
// through the running dev build and saves filmstrips, so a visual change can
// be judged before/after. See scripts/README.md.
//
//   node scripts/filmstrip.mjs clips
//   node scripts/filmstrip.mjs render  --scenes <file.json> --out <dir> [--tag name] [--url ...] [--only a,b]
//   node scripts/filmstrip.mjs compare --a <png> --b <png> [--original <jpg>] --meta <json> --scene <name>
//   node scripts/filmstrip.mjs shot    --out <png> [--url ...] [--w 1440 --h 900] [--mobile] [--dpr 3] [--run <body.js>] [--keys p,?] [--wait ms] [--move x,y]
//   node scripts/filmstrip.mjs eval    --run <body.js> [--url ...] [--args '{"k":1}']
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, readDataUrl, saveDataUrl } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIP_DIR = path.join(ROOT, 'ref-clips');
const DEFAULT_URL = 'http://localhost:5173/MotionDiff/';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const pageScript = (name) => fs.readFileSync(path.join(HERE, 'page', name), 'utf8');
const manifest = () => JSON.parse(fs.readFileSync(path.join(HERE, 'reference-clips.json'), 'utf8'));

async function ensureServer(url) {
  try {
    await fetch(url);
  } catch {
    throw new Error(`Nothing is answering at ${url}. Start the dev server first: npm run dev`);
  }
}

// ── clips: download or generate the reference clips ─────────────
async function cmdClips() {
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const clips = manifest().clips;
  let browser = null;
  for (const clip of clips) {
    const file = path.join(CLIP_DIR, clip.file);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
      console.log(`have  ${clip.id}  (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
      continue;
    }
    if (clip.url) {
      process.stdout.write(`fetch ${clip.id} … `);
      const res = await fetch(clip.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) { console.log(`FAILED (${res.status})`); continue; }
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      console.log(`${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
    } else if (clip.synthetic) {
      process.stdout.write(`make  ${clip.id} … `);
      browser ||= await launch();
      await browser.page.open('about:blank', 300);
      const result = await browser.page.eval(pageScript('synth.js'), { kind: clip.synthetic });
      saveDataUrl(file, result.dataUrl);
      console.log(`${(result.bytes / 1e6).toFixed(1)} MB, ${result.seconds}s at ${result.fps} fps`);
    }
  }
  await browser?.close();
}

// ── render: one filmstrip per scene ─────────────────────────────
async function cmdRender(args) {
  const url = args.url || DEFAULT_URL;
  await ensureServer(url);
  const { scenes } = JSON.parse(fs.readFileSync(args.scenes, 'utf8'));
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const clips = Object.fromEntries(manifest().clips.map((c) => [c.id, c]));
  const outDir = path.resolve(args.out || 'filmstrips');
  const tag = args.tag ? `${args.tag}-` : '';
  const metaFile = path.join(outDir, `${tag}meta.json`);
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};

  const browser = await launch();
  try {
    const { page } = browser;
    const base = new URL(url);
    await page.open(url, 2000);
    for (const scene of scenes) {
      if (only && !only.has(scene.name)) continue;
      const clip = clips[scene.clip];
      if (!clip) throw new Error(`Unknown clip "${scene.clip}" in scene "${scene.name}"`);
      if (!fs.existsSync(path.join(CLIP_DIR, clip.file))) throw new Error(`Missing ref-clips/${clip.file}: run "npm run filmstrip clips"`);
      const result = await page.eval(pageScript('render.js'), {
        clipUrl: new URL(`ref-clips/${clip.file}`, base).href,
        clipName: clip.file,
        fps: clip.fps,
        at: scene.at ?? clip.at ?? 1,
        frames: scene.frames ?? 6,
        every: scene.every ?? Math.max(1, Math.round(clip.fps / 10)),
        warmup: scene.warmup ?? 1.5,
        params: scene.params || {},
        display: scene.display || 'diff',
        width: scene.width,
        cell: scene.cell || 480,
        columns: scene.columns || 3,
      });
      saveDataUrl(path.join(outDir, `${tag}${scene.name}.png`), result.strip);
      saveDataUrl(path.join(outDir, `${tag}${scene.name}.original.jpg`), result.original);
      meta[scene.name] = result.meta;
      const note = result.meta.missed ? `  (${result.meta.missed} frames timed out)` : '';
      console.log(`${tag}${scene.name}: ${result.meta.count} frames, t=${result.meta.times[0]}..${result.meta.times.at(-1)} [${result.meta.renderer}]${note}`);
      for (const line of result.logs) console.log('   page:', line);
    }
  } finally {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
    await browser.close();
  }
}

// ── compare: the numeric guard ──────────────────────────────────
async function cmdCompare(args) {
  const meta = JSON.parse(fs.readFileSync(args.meta, 'utf8'))[args.scene];
  if (!meta) throw new Error(`No scene "${args.scene}" in ${args.meta}`);
  const browser = await launch();
  try {
    await browser.page.open('about:blank', 300);
    const result = await browser.page.eval(pageScript('compare.js'), {
      a: readDataUrl(args.a),
      b: args.b ? readDataUrl(args.b) : null,
      original: args.original ? readDataUrl(args.original) : null,
      meta,
    });
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}

// ── shot / eval: interface screenshots and one-off page checks ──
async function cmdShot(args, evalOnly = false) {
  const url = args.url || DEFAULT_URL;
  if (url.startsWith('http://localhost')) await ensureServer(url);
  const width = Number(args.w || 1440);
  const height = Number(args.h || 900);
  const browser = await launch({ width, height });
  try {
    const { page } = browser;
    // The emulated viewport is only applied when asked for: with it, headless
    // Chrome presents video frames at a few per second.
    if (args.w || args.h || args.mobile || args.dpr) await page.viewport({ width, height, dpr: Number(args.dpr || 1), mobile: Boolean(args.mobile) });
    await page.open(url, Number(args.settle || 1800));
    let value;
    if (args.run) value = await page.eval(fs.readFileSync(args.run, 'utf8'), args.args ? JSON.parse(args.args) : {});
    if (args.keys) for (const key of String(args.keys).split(',')) { await page.key(key === 'space' ? ' ' : key); await new Promise((r) => setTimeout(r, 250)); }
    if (args.move) { const [x, y] = String(args.move).split(',').map(Number); await page.mouseMove(x, y); }
    if (args.wait) await new Promise((r) => setTimeout(r, Number(args.wait)));
    if (!evalOnly && args.out) { await page.screenshot(path.resolve(args.out), { full: Boolean(args.full) }); console.log('saved', args.out); }
    if (value !== undefined) console.log(JSON.stringify(value, null, 1));
  } finally {
    await browser.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const commands = {
  clips: cmdClips,
  render: cmdRender,
  compare: cmdCompare,
  shot: (a) => cmdShot(a, false),
  eval: (a) => cmdShot(a, true),
};
if (!commands[command]) {
  console.log('Usage: node scripts/filmstrip.mjs <clips|render|compare|shot|eval> [options]  (see scripts/README.md)');
  process.exit(command ? 1 : 0);
}
commands[command](args).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
