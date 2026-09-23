#!/usr/bin/env node
// Generates one landing-page variant per file in pages/config/ (an industry pitch: a
// different tagline and which bundle it opens on) alongside the flagship page at the
// site root.
//
// A variant isn't hand-authored HTML - it's pages/index.html itself with its
// PAGE_CONFIG block swapped for the variant's config and its two site-root script
// paths bumped one level ("./app.js" -> "../app.js"), the same way dist/ is generated
// from src/ rather than hand-maintained: one template to keep in sync, not N copies of
// it that quietly drift.
//
// Usage: node tools/build_pages.mjs --out _site

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const outIndex = process.argv.indexOf('--out');
if (outIndex === -1 || !process.argv[outIndex + 1]) {
  console.error('usage: node tools/build_pages.mjs --out <dir>');
  process.exit(1);
}
const OUT = join(ROOT, process.argv[outIndex + 1]);

const template = readFileSync(join(ROOT, 'pages/index.html'), 'utf8');
const START = '// PAGE_CONFIG:START';
const END = '// PAGE_CONFIG:END';
const startAt = template.indexOf(START);
const endAt = template.indexOf(END);
if (startAt === -1 || endAt === -1) {
  console.error(`pages/index.html is missing the ${START} / ${END} markers`);
  process.exit(1);
}

const configDir = join(ROOT, 'pages/config');
const files = readdirSync(configDir).filter((f) => extname(f) === '.json');

for (const file of files) {
  const slug = basename(file, '.json');
  const config = JSON.parse(readFileSync(join(configDir, file), 'utf8'));
  for (const field of ['tagline', 'bundles']) {
    if (!(field in config)) {
      console.error(`pages/config/${file}: missing "${field}"`);
      process.exit(1);
    }
  }

  const page =
    template.slice(0, startAt) +
    `${START}\nwindow.SNAP3D_PAGE = ${JSON.stringify(config, null, 2)};\n` +
    template.slice(endAt);

  // One directory deeper than the flagship page, so every site-root-relative asset
  // path needs the same "go up one" bump - the two <script src> tags this template
  // itself owns, plus app.js's own posters/bundle/inputs URLs (which it derives from
  // its own <script> tag's src, so bumping that one tag here is enough).
  const variant = page
    .replace('src="./dist/viewer.js"', 'src="../dist/viewer.js"')
    .replace('src="./app.js"', 'src="../app.js"');

  const dir = join(OUT, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), variant);
  console.log(`  ${slug}/index.html  <- pages/config/${file}`);
}
