// The demo application: everything that is policy rather than rendering.
//
// Which bundle to open (?bundle=, else the first in index.json), the HUD, the loading
// overlay, the fps read-out, the warning panel. None of it is in the library, because
// none of it is a decision a page embedding the viewer should have made for it.

import { Snap3dViewer } from '../src/index.js';

const BUNDLES_ROOT = './snap3d_bundles';
const DEFAULT_BUNDLE = 'framed_painting';

// A snap3d bundle's folder is `<name>.snap3d`. Everything a person sees or types - the
// picker, ?bundle=, index.json - is the bare name; the suffix is added on the way to
// the URL.
const BUNDLE_SUFFIX = '.snap3d';
const bundleUrl = (name) => `${BUNDLES_ROOT}/${name}${BUNDLE_SUFFIX}`;

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const overlay = $('overlay');
const status = $('status');

function fail(error) {
  console.error(error);
  overlay.classList.remove('hidden');
  $('bar').style.display = 'none';
  status.className = 'error';
  status.textContent = String(error?.message ?? error);
}

function note(message) {
  console.warn(message);
  const notes = $('notes');
  notes.appendChild(document.createElement('p')).textContent = message;
  notes.classList.add('visible');
}

/** The bundle to show: ?bundle=<name>, else the first in snap3d_bundles/index.json. */
async function resolveBundleName() {
  const requested = new URLSearchParams(location.search).get('bundle');
  const index = await fetch(`${BUNDLES_ROOT}/index.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const names = index?.snap3d_bundles ?? [];
  // index.json is optional: it only exists to populate the picker when several runs
  // have been copied in. One bundle needs no index.
  if (requested) return [requested, names.length ? names : [requested]];
  if (names.length) return [names[0], names];
  return [DEFAULT_BUNDLE, [DEFAULT_BUNDLE]];
}

function fillHud(viewer, name, names) {
  const { config, stats } = viewer;
  $('title').textContent = name;
  $('s-mesh').textContent = `${stats.vertices.toLocaleString()} v / ${stats.faces.toLocaleString()} f`;
  $('s-sh').textContent = `degree ${config.sh.degree} · ${config.sh.coefficients} coeffs`;
  const [w, h] = config.texture_resolution;
  $('s-atlas').textContent = `${w}×${h} f16`;
  $('s-download').textContent = `${(stats.bytes / 1e6).toFixed(1)} MB`;
  $('s-vram').textContent = `${(viewer.textureBytes / 1e6).toFixed(0)} MB`;
  $('s-coverage').textContent = `${(stats.coverage * 100).toFixed(1)}%`;
  $('s-steps').textContent = config.height.num_steps;

  const picker = $('picker');
  for (const other of names) picker.appendChild(new Option(other, other, false, other === name));
  if (names.length > 1) picker.dataset.many = '';
  picker.onchange = () => {
    location.search = new URLSearchParams({ bundle: picker.value }).toString();
  };
  $('hud').hidden = false;
  $('help').hidden = false;
}

async function main() {
  const [name, names] = await resolveBundleName();
  status.textContent = `loading ${name}…`;

  // The loop is demand-driven, so the fps read-out only ticks while something moves.
  // Blanking it after a second of quiet is honest about that; a frozen "58" is not.
  let idleTimer = 0;
  const markIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { $('s-fps').textContent = 'idle'; }, 1000);
  };

  const viewer = new Snap3dViewer(canvas, bundleUrl(name), {
    onProgress: (loaded, total) => {
      $('bar').firstElementChild.style.width = `${(loaded / total) * 100}%`;
      status.textContent =
        loaded < total
          ? `loading ${name} — ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
          : 'decompressing…'; // inflate + the frame + the upload, all after the last byte
    },
    onWarning: note,
    onError: fail,
    onFrame: ({ fps }) => {
      $('s-fps').textContent = Math.round(fps);
      markIdle();
    },
  });

  await viewer.ready;
  fillHud(viewer, name, names);
  overlay.classList.add('hidden');
  viewer.focus(); // this page *is* the viewer, so WASD should work without a click
  markIdle();
  window.viewer = viewer; // a console handle: viewer.setCamera({azimuth: 0}), viewer.snapshot()
}

main().catch(fail);
