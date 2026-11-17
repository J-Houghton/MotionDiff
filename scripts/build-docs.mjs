// Builds the documentation site: the markdown in docs/ becomes static HTML in
// dist/docs/, served beside the app at <base>/docs/.
//
//   npm run docs     this script alone
//   npm run build    the app (vite build), then this script
//
// One dependency, markdown-it. No search and no client-side framework: the
// site is a handful of short pages with every page in the sidebar.
//
// The same markdown has to read well on GitHub, so pages link to each other
// with ordinary relative links (`../guide/controls.md`) and this script
// rewrites them:
//   a .md file inside docs/      ->  the matching .html page
//   a file in public/            ->  the copy deployed beside the app
//   anything else in the repo    ->  its page on GitHub (source files, records)
//   the demo's public address    ->  a relative link, so a local preview
//                                    opens the local build
// A picture on a line of its own gets its alt text as a visible caption, and
// a filmstrip gets a line between its frames.
// The build fails on a link to a page, heading or file that does not exist,
// and on a markdown file in docs/ that is missing from NAV.
//
// To add a page: write the .md file under docs/ and list it in NAV.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

/** The sidebar, in reading order. A page's label is its first `# heading`. */
const NAV = [
  { title: '', pages: ['index.md'] },
  {
    title: 'Concepts',
    pages: [
      'concepts/motion-extraction.md',
      'concepts/highlight.md',
      'concepts/cutout.md',
      'concepts/trails.md',
      'concepts/speed.md',
      'concepts/magnify.md',
      'concepts/heat.md',
    ],
  },
  {
    title: 'Using the demo',
    pages: [
      'guide/getting-started.md',
      'guide/controls.md',
      'guide/recipes.md',
      'guide/counting-and-export.md',
      'guide/experimental-models.md',
      'guide/troubleshooting.md',
    ],
  },
  {
    title: 'Technical',
    pages: ['technical/architecture.md', 'technical/how-the-modes-work.md', 'technical/developing.md'],
  },
];

const DEMO_URL = 'https://j-houghton.github.io/MotionDiff/';
const REPO_URL = 'https://github.com/J-Houghton/MotionDiff';
const BRANCH = 'master';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'docs');
const outDir = join(root, 'dist', 'docs');

const md = new MarkdownIt({ html: false, linkify: false });
// A picture alone in a paragraph becomes a figure, with its description (the
// markdown alt text, which GitHub keeps hidden) printed under it as a caption.
md.renderer.rules.paragraph_open = (tokens, at, options, env, self) => (figureOf(tokens, at) ? '' : self.renderToken(tokens, at, options));
md.renderer.rules.paragraph_close = (tokens, at, options, env, self) => (figureOf(tokens, at - 2) ? '' : self.renderToken(tokens, at, options));
md.renderer.rules.image = (tokens, at, options, env, self) => {
  const token = tokens[at];
  const caption = self.renderInlineAsText(token.children, options, env);
  token.attrSet('alt', caption);
  const frames = token.meta?.frames ?? 1;
  const strip = frames > 1 ? ` class="strip" style="--frames:${frames}"` : '';
  return `<figure${strip}><span><img${self.renderAttrs(token)}></span><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
};
/** The image token of a paragraph that holds one picture and nothing else. */
function figureOf(tokens, at) {
  const inline = tokens[at + 1];
  return tokens[at]?.type === 'paragraph_open' && inline?.children?.length === 1 && inline.children[0].type === 'image';
}

const errors = [];
const toPosix = (p) => p.split('\\').join('/');
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The pixel size of a PNG or JPEG, read from its header. */
function imageSize(path) {
  const b = readFileSync(path);
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  // JPEG: walk the segments to the start-of-frame marker, which holds the size.
  for (let at = 2; at < b.length - 9;) {
    const marker = b[at + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
    }
    at += 2 + b.readUInt16BE(at + 2);
  }
  return { width: 0, height: 0 };
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
const slug = (text) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** The plain text of an inline token (a heading's words, without the markup). */
const plain = (inline) => inline.children.filter((t) => t.type === 'text' || t.type === 'code_inline').map((t) => t.content).join('');

// ---- Pass 1: read every page; collect its title and heading anchors. --------

const order = NAV.flatMap((section) => section.pages);
const pages = new Map();
for (const file of order) {
  const path = join(docsDir, file);
  if (!existsSync(path)) { errors.push(`NAV lists docs/${file}, which does not exist`); continue; }
  const tokens = md.parse(readFileSync(path, 'utf8'), {});
  const anchors = new Set();
  let title = '';
  tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return;
    const text = plain(tokens[i + 1]);
    if (token.tag === 'h1' && !title) title = text;
    let id = slug(text);
    for (let n = 1; anchors.has(id); n++) id = `${slug(text)}-${n}`;
    anchors.add(id);
    token.attrSet('id', id);
  });
  if (!title) errors.push(`docs/${file} has no "# Title" heading`);
  pages.set(file, { file, title, tokens, anchors, out: file.replace(/\.md$/, '.html') });
}

// A markdown file that is not in NAV would be written but never linked.
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
for (const path of walk(docsDir)) {
  const file = toPosix(relative(docsDir, path));
  if (file.endsWith('.md') && !pages.has(file)) errors.push(`docs/${file} is not listed in NAV (scripts/build-docs.mjs)`);
}

// ---- Pass 2: rewrite links and pictures, then render. -----------------------

/** A relative path from one output page to another output file. */
const rel = (fromOut, toOut) => posix.relative(posix.dirname(fromOut), toOut) || posix.basename(toOut);

function rewriteLink(page, href) {
  if (href.startsWith(DEMO_URL)) return rel(page.out, '../' + href.slice(DEMO_URL.length)) + (href === DEMO_URL ? '/' : '');
  if (/^([a-z]+:|\/\/)/i.test(href)) return href;
  const [pathPart, hash] = href.split('#');
  // The target, as a path from the repository root.
  const target = pathPart ? posix.normalize(posix.join('docs', posix.dirname(page.file), pathPart)) : `docs/${page.file}`;
  const where = `docs/${page.file}: link to "${href}"`;
  if (target.startsWith('docs/') && target.endsWith('.md')) {
    const to = pages.get(target.slice('docs/'.length));
    if (!to) { errors.push(`${where}: no such page`); return href; }
    if (hash && !to.anchors.has(hash)) errors.push(`${where}: no heading "#${hash}" on that page`);
    return rel(page.out, to.out) + (hash ? `#${hash}` : '');
  }
  if (target.startsWith('..')) { errors.push(`${where}: leaves the repository`); return href; }
  const onDisk = join(root, target);
  if (!existsSync(onDisk)) { errors.push(`${where}: no such file`); return href; }
  // A file in public/ is deployed beside the app: link to that copy.
  if (target.startsWith('public/')) return rel(page.out, '../' + target.slice('public/'.length));
  const kind = statSync(onDisk).isDirectory() ? 'tree' : 'blob';
  return `${REPO_URL}/${kind}/${BRANCH}/${target.replace(/\/$/, '')}${hash ? `#${hash}` : ''}`;
}

function rewrite(page) {
  for (const token of page.tokens) {
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') {
        const href = rewriteLink(page, child.attrGet('href'));
        child.attrSet('href', href);
        if (/^[a-z]+:/i.test(href)) { child.attrSet('target', '_blank'); child.attrSet('rel', 'noopener'); }
      } else if (child.type === 'image') {
        const src = child.attrGet('src');
        const target = posix.normalize(posix.join(posix.dirname(page.file), src));
        if (!target.startsWith('images/') || !existsSync(join(docsDir, target))) {
          errors.push(`docs/${page.file}: picture "${src}" is not a file in docs/images/`);
        }
        else {
          // A filmstrip is several 16:9 frames side by side: note how many,
          // so the page can rule a line between them.
          const { width, height } = imageSize(join(docsDir, target));
          child.attrSet('width', String(width));
          child.attrSet('height', String(height));
          child.meta = { frames: Math.round(width / height / (16 / 9)) };
        }
        child.attrSet('src', rel(page.out, target));
        child.attrSet('loading', 'lazy');
      }
    }
  }
}

function sidebar(page) {
  return NAV.map((section) => {
    const items = section.pages.map((file) => {
      const to = pages.get(file);
      const here = to === page ? ' aria-current="page"' : '';
      return `<li><a href="${rel(page.out, to.out)}"${here}>${escapeHtml(to.title)}</a></li>`;
    }).join('');
    return `${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ''}<ul>${items}</ul>`;
  }).join('\n');
}

function layout(page, body) {
  const at = order.indexOf(page.file);
  const step = (file, cls, word) => {
    const to = pages.get(file);
    return to ? `<a class="${cls}" href="${rel(page.out, to.out)}"><small>${word}</small>${escapeHtml(to.title)}</a>` : '<span></span>';
  };
  const title = page.file === 'index.md' ? 'MotionDiff documentation' : `${page.title} · MotionDiff documentation`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${rel(page.out, '../favicon.svg')}">
<script>
  // The theme the demo uses, set before first paint: the saved choice, else the system's.
  (() => {
    let theme = null;
    try { theme = localStorage.getItem('motiondiff-theme'); } catch { /* no storage */ }
    if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
  })();
</script>
<link rel="stylesheet" href="${rel(page.out, 'site.css')}">
</head>
<body>
<header class="top">
  <a class="brand" href="${rel(page.out, 'index.html')}">MotionDiff <span>documentation</span></a>
  <a class="to-nav" href="#pages">Pages</a>
  <a class="demo" href="${rel(page.out, '../index.html').replace(/index\.html$/, '')}">Open the demo</a>
  <button type="button" id="theme" aria-label="Switch between the light and dark theme">Theme</button>
</header>
<div class="frame">
<main>
<article>
${body}
</article>
<nav class="steps" aria-label="Previous and next page">
  ${step(order[at - 1], 'prev', 'Previous')}
  ${step(order[at + 1], 'next', 'Next')}
</nav>
<p class="source"><a href="${REPO_URL}/blob/${BRANCH}/docs/${page.file}">This page on GitHub</a></p>
</main>
<nav class="pages" id="pages" aria-label="Pages">
${sidebar(page)}
</nav>
</div>
<script>
  document.getElementById('theme').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('motiondiff-theme', theme); } catch { /* this visit only */ }
  });
</script>
</body>
</html>
`;
}

const rendered = [];
for (const page of pages.values()) {
  rewrite(page);
  // Wide tables scroll inside their own box instead of widening the page.
  const body = md.renderer.render(page.tokens, md.options, {})
    .replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, '</table></div>');
  rendered.push([page.out, layout(page, body)]);
}

if (errors.length) {
  console.error(`docs: ${errors.length} problem${errors.length === 1 ? '' : 's'}\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
for (const [out, html] of rendered) {
  mkdirSync(dirname(join(outDir, out)), { recursive: true });
  writeFileSync(join(outDir, out), html);
}
cpSync(join(docsDir, 'images'), join(outDir, 'images'), { recursive: true });
cpSync(join(root, 'scripts', 'docs-site.css'), join(outDir, 'site.css'));
console.log(`docs: ${rendered.length} pages written to ${toPosix(relative(root, outDir))}/`);
