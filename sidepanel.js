/**
 * Meta AI Prompt Automator — side panel controller
 *
 * Responsibilities:
 *  - Load a shots JSON file and render the shot list
 *  - Track per-shot status (Pending / Sent / Done)
 *  - Ask the page (content.js) to submit a prompt
 *  - Download the most recent generated video as shot_XX.mp4
 *  - Auto Run All: count videos -> send -> poll every 3s (max 120s) for a new
 *    video -> settle 2s -> download, shot by shot
 *
 * Page-side integration contract (content.js):
 *   chrome.runtime.onMessage:
 *     { type: "META_AI_SEND_PROMPT", shot }              -> { ok: true, method? } | { ok: false, error }
 *     { type: "META_AI_GET_LATEST_VIDEO", filename }     -> { ok: true, url } | { ok: true, handledInPage: true } | { ok: false, error }
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'metaAiAutomator.v1';
const META_AI_ORIGIN = 'https://www.meta.ai';
const STATUS_ORDER = ['pending', 'sent', 'done'];
const STATUS_LABEL = { pending: 'Pending', sent: 'Sent', done: 'Done' };
/** Upper bound for waiting on a new video before downloading anyway. */
const AUTO_RUN_MAX_WAIT_SECONDS = 120;
/** How often the page is asked for its ready-video count. */
const VIDEO_POLL_INTERVAL_MS = 3000;
/** Grace period after a new video appears, so its src can settle. */
const VIDEO_SETTLE_MS = 6000;
/** Retries (after the first attempt) when reading the baseline video count. */
const COUNT_RETRIES = 3;
const COUNT_RETRY_DELAY_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {{ shot_id: number|string, prompt: string, overlay: string, status: 'pending'|'sent'|'done' }[]} */
let shots = [];
/** Shot id of the shot currently being worked on (drives the download filename). */
let activeShotId = null;
let sourceFileName = '';

/**
 * Active auto-run session, or null when idle.
 * @type {{ stopRequested: boolean, total: number } | null}
 */
let autoState = null;

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------

const els = {
  loadBtn: document.getElementById('loadBtn'),
  autoBtn: document.getElementById('autoBtn'),
  fileInput: document.getElementById('fileInput'),
  fileName: document.getElementById('fileName'),
  fileCount: document.getElementById('fileCount'),
  shotList: document.getElementById('shotList'),
  progress: document.getElementById('progress'),
  downloadBtn: document.getElementById('downloadBtn'),
  statusLine: document.getElementById('statusLine'),
  statusText: document.getElementById('statusText'),
  autoPanel: document.getElementById('autoPanel'),
  autoLabel: document.getElementById('autoLabel'),
  autoProgress: document.getElementById('autoProgress'),
  autoTimer: document.getElementById('autoTimer'),
  autoFill: document.getElementById('autoFill'),
  stopBtn: document.getElementById('stopBtn'),
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function setStatus(text, kind = '') {
  els.statusText.textContent = text;
  els.statusLine.className = 'status-line' + (kind ? ' ' + kind : '');
}

function normalizeShotId(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function activeShot() {
  return shots.find((s) => s.shot_id === activeShotId) || null;
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      const tab = tabs && tabs[0];
      if (!tab) return reject(new Error('No active tab found.'));
      resolve(tab);
    });
  });
}

function assertMetaAiTab(tab) {
  if (!tab.url || !tab.url.startsWith(META_AI_ORIGIN)) {
    throw new Error('Open https://www.meta.ai in the active tab first.');
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(response);
    });
  });
}

const NO_RECEIVER_RE = /Receiving end does not exist|Could not establish connection/i;

/**
 * Sends a message to the page, injecting content.js on demand. Tabs that were
 * already open when the extension loaded/reloaded have no content script yet.
 */
async function sendToPage(tab, message) {
  try {
    return await sendToTab(tab.id, message);
  } catch (err) {
    if (!NO_RECEIVER_RE.test(err.message || '')) throw err;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return await sendToTab(tab.id, message);
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ shots, activeShotId, sourceFileName })
    );
  } catch (err) {
    console.warn('[automator] Could not persist state:', err);
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.shots)) {
      shots = data.shots
        .filter((s) => s && typeof s.prompt === 'string' && s.prompt.trim())
        .map((s, i) => ({
          shot_id: normalizeShotId(s.shot_id, i + 1),
          prompt: String(s.prompt),
          overlay: typeof s.overlay === 'string' ? s.overlay : '',
          status: STATUS_ORDER.includes(s.status) ? s.status : 'pending',
        }));
      activeShotId = shots.some((s) => s.shot_id === data.activeShotId)
        ? data.activeShotId
        : shots.length
        ? shots[0].shot_id
        : null;
      sourceFileName = typeof data.sourceFileName === 'string' ? data.sourceFileName : '';
    }
  } catch (err) {
    console.warn('[automator] Could not restore state:', err);
  }
}

// ---------------------------------------------------------------------------
// JSON loading
// ---------------------------------------------------------------------------

function parseShotsJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('File is not valid JSON.');
  }

  const rawShots = Array.isArray(data) ? data : data && data.shots;
  if (!Array.isArray(rawShots)) {
    throw new Error('Expected { "shots": [ ... ] } in the JSON file.');
  }

  const parsed = [];
  rawShots.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    if (!prompt) return;
    parsed.push({
      shot_id: normalizeShotId(raw.shot_id, index + 1),
      prompt,
      overlay: typeof raw.overlay === 'string' ? raw.overlay : '',
      status: 'pending',
    });
  });

  if (!parsed.length) {
    throw new Error('No usable shots found (each shot needs a non-empty "prompt").');
  }

  return parsed;
}

async function loadFile(file) {
  if (autoState) {
    setStatus('Stop the auto run before loading a new file.', 'err');
    els.fileInput.value = '';
    return;
  }

  try {
    setStatus('Reading file…', 'busy');
    const text = await file.text();
    const parsed = parseShotsJson(text);

    shots = parsed;
    activeShotId = parsed[0].shot_id;
    sourceFileName = file.name;

    persist();
    render();
    setStatus(`Loaded ${parsed.length} shot${parsed.length === 1 ? '' : 's'} from ${file.name}`, 'ok');
  } catch (err) {
    setStatus(err.message || 'Could not load the file.', 'err');
  } finally {
    els.fileInput.value = '';
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  els.shotList.innerHTML = '';
  els.fileName.textContent = sourceFileName || 'No file loaded';
  els.fileCount.textContent = shots.length ? `${shots.length} shot${shots.length === 1 ? '' : 's'}` : '';

  const done = shots.filter((s) => s.status === 'done').length;
  els.progress.textContent = shots.length ? `${done} / ${shots.length} done` : '';

  if (!shots.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />' +
      '<polyline points="14 2 14 8 20 8" />' +
      '<line x1="9" y1="13" x2="15" y2="13" />' +
      '<line x1="9" y1="17" x2="13" y2="17" /></svg>' +
      '<p>Load a JSON file to get started.<br />Each shot needs a prompt.</p>';
    els.shotList.appendChild(empty);
    updateControls();
    return;
  }

  for (const shot of shots) {
    els.shotList.appendChild(renderShotCard(shot));
  }

  updateControls();
}

/** Keeps the toolbar/footer buttons in sync with the current mode. */
function updateControls() {
  const running = autoState !== null;
  els.loadBtn.disabled = running;
  els.autoBtn.disabled = running || shots.length === 0;
  els.downloadBtn.disabled = running || !activeShot();
}

function renderShotCard(shot) {
  const card = document.createElement('div');
  card.className = 'shot-card' + (shot.shot_id === activeShotId ? ' active' : '');
  card.dataset.shotId = String(shot.shot_id);

  // --- top row: id + status badge ---
  const top = document.createElement('div');
  top.className = 'shot-top';

  const idEl = document.createElement('span');
  idEl.className = 'shot-id';
  idEl.textContent = '#' + pad2(shot.shot_id);

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'badge ' + shot.status;
  badge.textContent = STATUS_LABEL[shot.status];
  badge.title = autoState ? 'Locked during auto run' : 'Click to cycle status';
  badge.disabled = autoState !== null;
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    if (autoState) return;
    cycleStatus(shot.shot_id);
  });

  top.append(idEl, badge);

  // --- prompt ---
  const promptEl = document.createElement('div');
  promptEl.className = 'shot-prompt';
  promptEl.textContent = shot.prompt;
  promptEl.title = shot.prompt;

  // --- overlay (optional) ---
  let overlayEl = null;
  if (shot.overlay) {
    overlayEl = document.createElement('div');
    overlayEl.className = 'shot-overlay';
    overlayEl.title = shot.overlay;
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Overlay: ';
    overlayEl.append(lbl, document.createTextNode(shot.overlay));
  }

  // --- actions ---
  const actions = document.createElement('div');
  actions.className = 'shot-actions';

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'btn btn-sm btn-send';
  sendBtn.textContent = shot.status === 'sent' ? 'Resend Prompt' : 'Send Prompt';
  sendBtn.disabled = autoState !== null;
  sendBtn.addEventListener('click', () => sendPrompt(shot.shot_id, { button: sendBtn }));

  actions.appendChild(sendBtn);

  card.append(top, promptEl);
  if (overlayEl) card.appendChild(overlayEl);
  card.appendChild(actions);

  card.addEventListener('click', () => {
    if (autoState) return;
    if (activeShotId === shot.shot_id) return;
    activeShotId = shot.shot_id;
    persist();
    render();
  });

  return card;
}

function setShotStatus(shotId, status) {
  const shot = shots.find((s) => s.shot_id === shotId);
  if (!shot || !STATUS_ORDER.includes(status)) return;
  shot.status = status;
  activeShotId = shotId;
  persist();
  render();
}

function cycleStatus(shotId) {
  const shot = shots.find((s) => s.shot_id === shotId);
  if (!shot) return;
  const next = STATUS_ORDER[(STATUS_ORDER.indexOf(shot.status) + 1) % STATUS_ORDER.length];
  setShotStatus(shotId, next);
}

// ---------------------------------------------------------------------------
// Send prompt
// ---------------------------------------------------------------------------

/**
 * Sends one shot's prompt to the page.
 * @param {number|string} shotId
 * @param {{ button?: HTMLButtonElement|null, silent?: boolean }} [options]
 * @returns {Promise<boolean>} true when the prompt was handed to the page
 */
async function sendPrompt(shotId, options = {}) {
  const { button = null, silent = false } = options;
  const shot = shots.find((s) => s.shot_id === shotId);
  if (!shot) return false;

  activeShotId = shotId;
  render();

  if (button) button.disabled = true;
  if (!silent) setStatus(`Sending shot #${pad2(shotId)}…`, 'busy');

  try {
    const tab = await getActiveTab();
    assertMetaAiTab(tab);

    const response = await sendToPage(tab, {
      type: 'META_AI_SEND_PROMPT',
      shot: { shot_id: shot.shot_id, prompt: shot.prompt, overlay: shot.overlay },
    });

    if (response && response.ok === false) {
      throw new Error(response.error || 'The page rejected the prompt.');
    }
    if (response && response.sent === false) {
      console.warn('[automator] Prompt may not have been sent:', response.warning);
    }

    setShotStatus(shotId, 'sent');
    if (!silent) setStatus(`Shot #${pad2(shotId)} sent.`, 'ok');
    return true;
  } catch (err) {
    setStatus(err.message || 'Could not send the prompt.', 'err');
    if (button && button.isConnected) button.disabled = false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Download latest video
// ---------------------------------------------------------------------------

async function requestLatestVideo(tab, filename) {
  try {
    const response = await sendToPage(tab, {
      type: 'META_AI_GET_LATEST_VIDEO',
      filename,
    });
    if (response && response.ok) {
      if (response.handledInPage) return { handledInPage: true };
      if (response.url) return { url: response.url };
    }
    if (response && response.ok === false && response.error) {
      console.warn('[automator] Page helper:', response.error);
    }
  } catch (err) {
    // No content script yet — fall through to a one-off DOM read.
  }

  // Fallback: read the newest <video> element straight from the page.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (name) => {
        const videos = Array.from(document.querySelectorAll('video'));
        for (let i = videos.length - 1; i >= 0; i--) {
          const v = videos[i];
          const src =
            v.currentSrc ||
            v.src ||
            (v.querySelector('source') ? v.querySelector('source').src : '') ||
            '';
          if (!src) continue;
          if (src.startsWith('blob:')) {
            // chrome.downloads cannot fetch blob: URLs from the panel context,
            // so hand the download to the page itself.
            const a = document.createElement('a');
            a.href = src;
            a.download = name;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return { handledInPage: true };
          }
          if (/^https?:/i.test(src)) return { url: src };
        }
        return null;
      },
      args: [filename],
    });
    const result = results && results[0] ? results[0].result : null;
    if (result) return result;
  } catch (err) {
    console.warn('[automator] Could not inspect the page:', err);
  }

  return null;
}

/**
 * Downloads the newest video on the page for the given shot.
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<boolean>} true when the download was started
 */
async function downloadLatestVideo(options = {}) {
  const { silent = false } = options;
  const shot = activeShot();
  if (!shot) {
    setStatus('Select a shot first.', 'err');
    return false;
  }

  if (!silent) {
    els.downloadBtn.disabled = true;
    setStatus(`Looking for the latest video (shot #${pad2(shot.shot_id)})…`, 'busy');
  }

  try {
    const tab = await getActiveTab();
    assertMetaAiTab(tab);

    const filename = `shot_${pad2(shot.shot_id)}.mp4`;
    const video = await requestLatestVideo(tab, filename);
    if (!video) {
      throw new Error('No downloadable video found on the page yet.');
    }

    if (video.handledInPage) {
      setShotStatus(shot.shot_id, 'done');
      if (!silent) setStatus(`Downloading ${filename} from the page…`, 'ok');
      return true;
    }

    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: video.url, filename, saveAs: false }, (id) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (id === undefined) return reject(new Error('Download was not started.'));
        resolve(id);
      });
    });

    setShotStatus(shot.shot_id, 'done');
    if (!silent) setStatus(`Downloading ${filename}… (id ${downloadId})`, 'ok');
    return true;
  } catch (err) {
    setStatus(err.message || 'Download failed.', 'err');
    return false;
  } finally {
    updateControls();
  }
}

// ---------------------------------------------------------------------------
// Auto run all
// ---------------------------------------------------------------------------

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

function setAutoPanelVisible(visible) {
  els.autoPanel.hidden = !visible;
}

function setAutoLabel(text) {
  els.autoLabel.textContent = text;
}

function setAutoProgress(text) {
  els.autoProgress.textContent = text;
}

function setAutoTimer(seconds, total) {
  if (seconds === null) {
    els.autoTimer.textContent = '--:--';
    els.autoTimer.classList.remove('counting');
    els.autoFill.style.width = '0%';
    return;
  }
  els.autoTimer.textContent = formatClock(seconds);
  els.autoTimer.classList.add('counting');
  const pct = total > 0 ? ((total - seconds) / total) * 100 : 0;
  els.autoFill.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + '%';
}

/**
 * Asks the page how many completed (readyState >= 2) videos it has.
 * @returns {Promise<number|null>} null when the page cannot be queried
 */
async function countPageVideos() {
  try {
    const tab = await getActiveTab();
    assertMetaAiTab(tab);
    const response = await sendToPage(tab, { type: 'META_AI_COUNT_VIDEOS' });
    if (response && typeof response.count === 'number') return response.count;
  } catch (err) {
    console.warn('[automator] Video count failed:', err);
  }
  return null;
}

/**
 * Polls the page every 3s for a new completed video, showing a live countdown.
 * @param {number|null} initialCount baseline captured before the prompt was sent
 * @param {number} maxSeconds hard timeout
 * @returns {Promise<{ detected: boolean, stopped: boolean, count: number|null }>}
 */
async function waitForNewVideo(initialCount, maxSeconds) {
  const baseline = typeof initialCount === 'number' ? initialCount : 0;
  const deadline = Date.now() + maxSeconds * 1000;
  let nextPollAt = Date.now() + VIDEO_POLL_INTERVAL_MS;
  let lastCount = initialCount;

  setAutoTimer(maxSeconds, maxSeconds);

  while (Date.now() < deadline) {
    if (!autoState || autoState.stopRequested) {
      return { detected: false, stopped: true, count: lastCount };
    }

    const remainingMs = deadline - Date.now();
    await sleep(Math.min(1000, Math.max(0, remainingMs)));

    if (!autoState || autoState.stopRequested) {
      return { detected: false, stopped: true, count: lastCount };
    }

    const remainingSec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setAutoTimer(remainingSec, maxSeconds);

    if (Date.now() >= nextPollAt) {
      nextPollAt = Date.now() + VIDEO_POLL_INTERVAL_MS;
      const count = await countPageVideos();
      if (typeof count === 'number') {
        lastCount = count;
        if (count > baseline) {
          return { detected: true, stopped: false, count };
        }
      }
    }
  }

  return { detected: false, stopped: false, count: lastCount };
}

async function startAutoRun() {
  if (autoState) return;

  if (!shots.length) {
    setStatus('Load a JSON file first.', 'err');
    return;
  }

  const pendingIds = shots.filter((s) => s.status === 'pending').map((s) => s.shot_id);
  if (!pendingIds.length) {
    setStatus('No pending shots — every shot is already sent or done.', 'err');
    return;
  }

  // Fail fast if the active tab is not meta.ai.
  try {
    const tab = await getActiveTab();
    assertMetaAiTab(tab);
  } catch (err) {
    setStatus(err.message, 'err');
    return;
  }

  autoState = { stopRequested: false, total: pendingIds.length };
  setAutoPanelVisible(true);
  setAutoLabel('Auto run');
  setAutoTimer(null);
  setAutoProgress(`0 / ${pendingIds.length}`);
  updateControls();
  render();

  let completed = 0;
  let failedAt = null;
  let failReason = 'could not be sent';

  for (let i = 0; i < pendingIds.length; i++) {
    if (!autoState || autoState.stopRequested) break;

    const id = pendingIds[i];
    const shot = shots.find((s) => s.shot_id === id);
    if (!shot) continue;

    activeShotId = id;
    render();

    setAutoProgress(`${i + 1} / ${pendingIds.length}`);
    setAutoLabel(`Checking shot #${pad2(id)}`);
    setAutoTimer(null);
    setStatus(`Auto run: reading current video count…`, 'busy');

    // Baseline before the prompt goes in: any completed video above this is new.
    let initialVideoCount = await countPageVideos();
    for (let r = 0; r < COUNT_RETRIES && initialVideoCount === null; r++) {
      await sleep(COUNT_RETRY_DELAY_MS);
      if (!autoState || autoState.stopRequested) break;
      initialVideoCount = await countPageVideos();
    }
    if (!autoState || autoState.stopRequested) break;
    if (initialVideoCount === null) {
      // Never guess a baseline of 0: that could match an old video instantly.
      failedAt = id;
      failReason = 'could not read the video count from the page';
      break;
    }

    setAutoLabel(`Sending shot #${pad2(id)}`);
    setStatus(`Auto run: sending shot #${pad2(id)}…`, 'busy');

    const sent = await sendPrompt(id, { silent: true });
    if (!sent) {
      failedAt = id;
      break;
    }
    if (!autoState || autoState.stopRequested) break;

    setAutoLabel(`Waiting for shot #${pad2(id)} video`);
    setStatus(
      `Auto run: waiting up to ${AUTO_RUN_MAX_WAIT_SECONDS}s for shot #${pad2(id)} to generate…`,
      'busy'
    );

    const wait = await waitForNewVideo(initialVideoCount, AUTO_RUN_MAX_WAIT_SECONDS);
    if (wait.stopped) break;

    if (wait.detected) {
      setAutoLabel(`Video ready for shot #${pad2(id)}`);
      setStatus(
        `Auto run: video detected for shot #${pad2(id)} — settling ${VIDEO_SETTLE_MS / 1000}s…`,
        'ok'
      );
      await sleep(VIDEO_SETTLE_MS);
      if (!autoState || autoState.stopRequested) break;
    } else {
      setStatus(
        `Auto run: no new video after ${AUTO_RUN_MAX_WAIT_SECONDS}s — attempting download anyway.`,
        'err'
      );
    }

    setAutoLabel(`Downloading shot #${pad2(id)}`);
    setAutoTimer(null);
    setStatus(`Auto run: downloading shot #${pad2(id)}…`, 'busy');

    const downloaded = await downloadLatestVideo({ silent: true });
    if (downloaded) {
      completed += 1;
      setStatus(`Auto run: shot #${pad2(id)} saved.`, 'ok');
    } else {
      setStatus(`Auto run: shot #${pad2(id)} download failed — continuing.`, 'err');
    }
    setAutoProgress(`${i + 1} / ${pendingIds.length}`);
  }

  const stopped = !autoState || autoState.stopRequested;
  autoState = null;

  setAutoPanelVisible(false);
  setAutoTimer(null);
  updateControls();
  render();

  if (stopped) {
    setStatus(`Auto run stopped — ${completed} of ${pendingIds.length} shot(s) downloaded.`);
  } else if (failedAt !== null) {
    setStatus(`Auto run halted: shot #${pad2(failedAt)} ${failReason}.`, 'err');
  } else {
    setStatus(`Auto run complete — ${completed} of ${pendingIds.length} shot(s) downloaded.`, 'ok');
  }
}

function stopAutoRun() {
  if (!autoState || autoState.stopRequested) return;
  autoState.stopRequested = true;
  setStatus('Stopping auto run…', 'busy');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

els.loadBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) loadFile(file);
});
els.downloadBtn.addEventListener('click', () => downloadLatestVideo());
els.autoBtn.addEventListener('click', startAutoRun);
els.stopBtn.addEventListener('click', stopAutoRun);

// Drag & drop a JSON file onto the panel.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.style.opacity = '0.85';
});
document.addEventListener('dragleave', () => {
  document.body.style.opacity = '1';
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.style.opacity = '1';
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

restore();
render();
setStatus(shots.length ? 'Session restored.' : 'Ready');
