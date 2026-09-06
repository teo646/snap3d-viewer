// Builds dist/ with esbuild. Three outputs, because "UMD" is really three questions:
//
//   dist/viewer.js    classic <script>: an IIFE that defines the `Snap3dViewer` global
//   dist/viewer.mjs   ESM, for a bundler or a native `import`
//   dist/viewer.cjs   CommonJS, for `require()`
//
// dist/ is gitignored and rebuilt by CI on every push to main - the copy behind the
// Pages URL is always the one that matches the commit, and nobody hand-edits a build.
//
// Usage: node tools/build.mjs [--check] [--watch]

import { readFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// The version lives in two places a human reads. Rather than generate one from the
// other and make `src/` unreadable on its own, the build refuses to run when they
// disagree - drift becomes a failed build instead of a wrong number in a bug report.
const declared = readFileSync(join(ROOT, 'src/index.js'), 'utf8').match(/VERSION = '([^']+)'/)?.[1];
if (declared !== pkg.version) {
  console.error(`version mismatch: package.json says ${pkg.version}, src/index.js says ${declared}`);
  process.exit(1);
}

const banner = `/*! ${pkg.name} ${pkg.version} | ${pkg.license} | ${pkg.homepage} */`;

const TARGETS = [
  // Chrome 66 / Safari 15 is where WebGL2 + ResizeObserver + optional chaining all
  // land; there is no point shipping syntax older than the API the viewer requires.
  { entry: 'src/browser.js', outfile: 'dist/viewer.js', format: 'iife' },
  { entry: 'src/index.js', outfile: 'dist/viewer.mjs', format: 'esm' },
  { entry: 'src/index.js', outfile: 'dist/viewer.cjs', format: 'cjs' },
];

const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ['chrome66', 'firefox78', 'safari15', 'edge79'],
  banner: { js: banner },
  legalComments: 'inline',
  logLevel: 'warning',
};

const options = TARGETS.map(({ entry, outfile, format }) => ({
  ...common,
  entryPoints: [join(ROOT, entry)],
  outfile: join(ROOT, outfile),
  format,
}));

if (process.argv.includes('--check')) {
  // Type-free sanity: every entry must at least bundle. Nothing is written.
  await Promise.all(options.map((o) => build({ ...o, write: false, minify: false, sourcemap: false })));
  console.log('bundles cleanly');
  process.exit(0);
}

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
mkdirSync(join(ROOT, 'dist'), { recursive: true });

if (process.argv.includes('--watch')) {
  const contexts = await Promise.all(options.map(context));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching src/ - ctrl-c to stop');
} else {
  await Promise.all(options.map(build));
  const files = readdirSync(join(ROOT, 'dist')).sort();
  const width = Math.max(...files.map((f) => f.length));
  for (const file of files) {
    const bytes = statSync(join(ROOT, 'dist', file)).size;
    console.log(`  dist/${file.padEnd(width)}  ${(bytes / 1024).toFixed(1)} kB`);
  }
}
