// The demo application: everything that is policy rather than rendering.
//
// Which bundle to open (?bundle=, else the first in index.json), the HUD, the loading
// overlay, the fps read-out, the warning panel. None of it is in the library, because
// none of it is a decision a page embedding the viewer should have made for it.

import { Snap3dViewer } from '../src/index.js';

const BUNDLES_ROOT = './bundles';

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

/** The bundle to show: ?bundle=<name>, else the first one in bundles/index.json. */
async function resolveBundleName() {
  const requested = new URLSearchParams(location.search).get('bundle');
  const index = await fetch(`${BUNDLES_ROOT}/index.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const names = index?.bundles ?? [];
  if (requested) return [requested, names.length ? names : [requested]];
  if (!names.length) {
    throw new Error(
      'No bundles found. Convert one first:\n' +
        '  python tools/export_web_bundle.py <run>/10_export',
    );
  }
  return [names[0], names];
}

function fillHud(viewer, name, names) {
  const { meta } = viewer;
  $('title').textContent = name;
  $('s-mesh').textContent = `${meta.mesh.vertices.toLocaleString()} v / ${meta.mesh.faces.toLocaleString()} f`;
  $('s-sh').textContent = `degree ${meta.sh_degree} · ${meta.k_coeffs} coeffs`;
  const [w, h] = meta.texture_resolution;
  $('s-atlas').textContent = `${w}×${h} ${meta.texture_precision}`;
  $('s-vram').textContent = `${(viewer.textureBytes / 1e6).toFixed(0)} MB`;
  $('s-coverage').textContent = `${(meta.coverage * 100).toFixed(1)}%`;
  $('s-steps').textContent = meta.height.num_steps;

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

  const viewer = new Snap3dViewer(canvas, `${BUNDLES_ROOT}/${name}`, {
    onProgress: (loaded, total) => {
      $('bar').firstElementChild.style.width = `${(loaded / total) * 100}%`;
      status.textContent = `loading ${name} — ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
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
