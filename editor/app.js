// snap3d editor - not a second viewer, the same Snap3dViewer (../dist/viewer.js,
// exactly what a storefront's own page loads) driven from a page built for choosing a
// default camera pose rather than displaying a product. The rendering, the orbit math
// and the bundle format are all identical; only this page's own controls (autoplay,
// the readout, "make config file") are new.
//
// The rotation loop is ours, not the library's built-in `autoRotate`: we want it to
// keep spinning through a WASD pan (the library's own idle-spin stops on *any*
// interaction) and to stop only on Space, a drag, a zoom, or R - so autoRotate is
// disabled at construction and `tick()` below drives `camera.azimuth` itself.

(() => {
  const ROTATE_SPEED = 16; // deg/s - the same idle-spin rate the shipped viewer defaults to
  const STORAGE_KEY = 'snap3d-editor:lastBundle';

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const bundleInput = $('bundle-input');
  const loadBtn = $('load-btn');
  const loadStatus = $('load-status');
  const readout = $('readout');
  const playBtn = $('play-btn');
  const resetBtn = $('reset-btn');
  const helpBtn = $('help-btn');
  const helpDialog = $('help');
  const makeConfigBtn = $('make-config-btn');
  const configDialog = $('config-out');
  const configText = $('config-text');
  const saveAsBtn = $('saveas-btn');
  const downloadBtn = $('download-btn');
  const copyBtn = $('copy-btn');
  const saveStatus = $('save-status');

  let viewer = null;
  let playing = false;
  let lastTick = 0;
  let nearScale = 0.02; // radius -> near/far, recomputed from each bundle's own ratio
  let farScale = 20;

  // ---------- status line ----------

  function setStatus(text, isError = false) {
    loadStatus.textContent = text;
    loadStatus.classList.toggle('error', isError);
  }

  function setActionsEnabled(on) {
    playBtn.disabled = resetBtn.disabled = makeConfigBtn.disabled = !on;
  }

  // ---------- play / pause ----------

  function setPlaying(next) {
    playing = next;
    playBtn.textContent = playing ? '일시정지 (Space)' : '재생 (Space)';
  }

  function wrapDeg(deg) {
    // Keeps the number in [-180, 180) after an unbounded number of tick() increments;
    // sin/cos don't care, but the readout and the exported config should stay tidy.
    return ((deg + 180) % 360 + 360) % 360 - 180;
  }

  function tick(now) {
    requestAnimationFrame(tick);
    if (viewer && viewer.camera && playing) {
      const dt = lastTick ? Math.min((now - lastTick) / 1000, 0.1) : 0;
      viewer.camera.azimuth = wrapDeg(viewer.camera.azimuth + ROTATE_SPEED * dt);
      viewer.requestRender();
    }
    lastTick = now;
    updateReadout();
  }
  requestAnimationFrame(tick);

  function updateReadout() {
    if (!viewer || !viewer.camera) return; // constructed, but the bundle hasn't loaded yet
    const c = viewer.camera;
    const p = (n) => n.toFixed(3).padStart(8);
    readout.innerHTML =
      `<b>target</b>  ${c.origin.map(p).join(' ')}\n` +
      `<b>radius</b>  ${c.radius.toFixed(3)}\n` +
      `<b>azimuth</b> ${c.azimuth.toFixed(1)}°\n` +
      `<b>elev</b>    ${c.elevation.toFixed(1)}°`;
  }

  // ---------- loading ----------

  function normalizeUrl(raw) {
    const url = raw.trim();
    return url.replace(/\/+$/, '');
  }

  async function loadBundle(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    setStatus('불러오는 중…');
    setActionsEnabled(false);
    setPlaying(false);

    if (!viewer) {
      viewer = new Snap3dViewer(canvas, url, {
        background: [0.09, 0.09, 0.11, 1],
        autoRotate: false, // this page drives rotation itself - see tick()
        controls: { keys: true },
        onProgress: (loaded, total) =>
          setStatus(`${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`),
        onReady: handleReady,
        onError: (err) => {
          setStatus(String(err?.message ?? err), true);
          setActionsEnabled(false);
        },
      });
      window.viewer = viewer; // a console handle, same convention as the shipped pages
      await viewer.ready.catch(() => {}); // onError above already reported it
    } else {
      await viewer.load(url).catch(() => {});
    }
  }

  function handleReady() {
    const cam0 = viewer.config.initial_camera;
    nearScale = cam0.radius > 0 ? cam0.near / cam0.radius : nearScale;
    farScale = cam0.radius > 0 ? cam0.far / cam0.radius : farScale;

    for (const w of viewer.warnings) setStatus(`불러옴 - ${w}`, true);
    if (!viewer.warnings.length) setStatus('불러옴');
    setActionsEnabled(true);
    setPlaying(true);
    viewer.focus();

    localStorage.setItem(STORAGE_KEY, viewer.url);
    const u = new URL(location.href);
    u.searchParams.set('bundle', viewer.url);
    history.replaceState(null, '', u);
  }

  loadBtn.addEventListener('click', () => loadBundle(bundleInput.value));
  bundleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadBundle(bundleInput.value);
  });

  canvas.addEventListener('pointerdown', () => canvas.classList.add('dragging'));
  addEventListener('pointerup', () => canvas.classList.remove('dragging'));

  // The library's own OrbitControls calls one shared `onInteract` for a drag, a wheel
  // tick, R, *and* a WASD pan key alike (see src/controls.js) - too coarse here, since
  // a pan is exactly the interaction this page wants to keep spinning through. So
  // pausing is wired to the raw events directly instead of that hook: a drag or a zoom
  // stops it, R stops it (it is also a reset), a pan key does not.
  canvas.addEventListener('pointerdown', () => viewer && setPlaying(false));
  canvas.addEventListener('wheel', () => viewer && setPlaying(false), { passive: true });
  canvas.addEventListener('keydown', (e) => {
    if (viewer && e.key.toLowerCase() === 'r') setPlaying(false);
  });

  // ---------- transport ----------

  playBtn.addEventListener('click', () => {
    setPlaying(!playing);
    viewer?.requestRender();
  });
  resetBtn.addEventListener('click', () => {
    setPlaying(false);
    viewer?.resetCamera();
  });

  addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    e.preventDefault();
    if (viewer) setPlaying(!playing);
  });

  // ---------- help / config dialogs ----------

  helpBtn.addEventListener('click', () => helpDialog.showModal());
  for (const dialog of [helpDialog, configDialog]) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close(); // click on the backdrop
    });
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
  }

  const round = (n) => Math.round(n * 1e6) / 1e6; // trims float noise, keeps real precision

  /**
   * The current camera as a fresh `initial_camera` block, in exactly the shape
   * pipeline/core/render_bundle.py writes (see its `type/target/radius/azimuth_deg/
   * elevation_deg/position/view_matrix/fov_deg/near/far` keys) - `position` and
   * `view_matrix` are precomputed the same way, for a consumer that skips the orbit
   * math, even though this viewer itself never reads them back in.
   */
  function buildConfig() {
    if (!viewer) return null;
    const c = viewer.camera;
    const flat = c.viewMatrix(); // column-major Float32Array(16) - see src/mat4.js
    const rows = [];
    for (let r = 0; r < 4; r++) {
      const row = [];
      for (let col = 0; col < 4; col++) row.push(round(flat[col * 4 + r]));
      rows.push(row);
    }
    return {
      ...viewer.config,
      initial_camera: {
        type: 'orbit',
        target: c.origin.map(round),
        radius: round(c.radius),
        azimuth_deg: round(c.azimuth),
        elevation_deg: round(c.elevation),
        position: Array.from(c.position).map(round),
        view_matrix: rows,
        fov_deg: viewer.config.initial_camera.fov_deg,
        near: round(c.radius * nearScale),
        far: round(c.radius * farScale),
      },
    };
  }

  makeConfigBtn.addEventListener('click', () => {
    const cfg = buildConfig();
    if (!cfg) return;
    configText.value = JSON.stringify(cfg, null, 2) + '\n';
    saveStatus.textContent = '';
    saveStatus.className = '';
    configDialog.showModal();
  });

  function setSaveStatus(text, kind = '') {
    saveStatus.textContent = text;
    saveStatus.className = kind;
  }

  saveAsBtn.addEventListener('click', async () => {
    if (!window.showSaveFilePicker) {
      setSaveStatus('이 브라우저는 저장 대화상자를 지원하지 않습니다 - 다운로드나 복사를 쓰세요.', 'error');
      return;
    }
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'config.json',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(configText.value);
      await writable.close();
      setSaveStatus('저장했습니다.', 'ok');
    } catch (err) {
      if (err?.name === 'AbortError') return; // the picker was cancelled
      setSaveStatus(`저장 실패: ${err.message} - 다운로드나 복사를 쓰세요.`, 'error');
    }
  });

  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([configText.value], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'config.json';
    a.click();
    URL.revokeObjectURL(a.href);
    setSaveStatus('다운로드 폴더에 config.json으로 받았습니다.', 'ok');
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(configText.value);
    } catch {
      configText.select();
      document.execCommand('copy');
    }
    setSaveStatus('복사했습니다.', 'ok');
  });

  // ---------- boot ----------

  const params = new URLSearchParams(location.search);
  const initial = params.get('bundle') || localStorage.getItem(STORAGE_KEY) || '';
  bundleInput.value = initial;
  if (initial) loadBundle(initial);
  else setStatus('불러올 번들 경로를 입력하세요');
})();
