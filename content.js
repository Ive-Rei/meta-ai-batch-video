/**
 * Meta AI Prompt Automator — content script
 *
 * Runs on https://www.meta.ai/* and answers the two message types used by
 * sidepanel.js:
 *
 *   { type: "META_AI_SEND_PROMPT", shot: { shot_id, prompt, overlay } }
 *     -> { ok: true, method: "button" | "enter", sent: true }
 *     -> { ok: true, sent: false, warning }   (never fails; auto run keeps going)
 *
 *   { type: "META_AI_GET_LATEST_VIDEO", filename: "shot_01.mp4" }
 *     -> { ok: true, handledInPage: true }        (blob: URL downloaded in-page)
 *     -> { ok: true, url: "<http(s) url>" }       (side panel uses chrome.downloads)
 *     -> { ok: false, error }
 *
 *   { type: "META_AI_COUNT_VIDEOS" }
 *     -> { count: number }                        (readyState >= 2 with src/blob)
 */

(() => {
  'use strict';

  // Guard against double injection (manifest + manual executeScript).
  if (window.__metaAiAutomatorLoaded) return;
  window.__metaAiAutomatorLoaded = true;

  const SEND_BUTTON_RE = /send|submit/i;
  const INPUT_LOOKUP_TIMEOUT_MS = 5000;
  const INPUT_POLL_MS = 150;
  const SUBMIT_DELAY_MS = 500;
  const VIDEO_LOOKUP_TIMEOUT_MS = 4000;
  const VIDEO_POLL_MS = 300;
  const DOWNLOAD_LOOKUP_TIMEOUT_MS = 5000;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function isDisabled(el) {
    return (
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('disabled') !== null
    );
  }

  // -------------------------------------------------------------------------
  // Chat input discovery
  // -------------------------------------------------------------------------

  const INPUT_SELECTORS = [
    'div[contenteditable="true"]',
    'div[contenteditable="plaintext-only"]',
    'textarea',
    '[role="textbox"][contenteditable="true"]',
    'form textarea',
  ];

  function isInputReady(el) {
    if (!isVisible(el) || isDisabled(el)) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.closest('[aria-disabled="true"]')) return false;
    if (el.readOnly === true || el.getAttribute('aria-readonly') === 'true') return false;
    if (el.getAttribute('contenteditable') === 'false') return false;
    // A disabled composer often still renders; pointer-events: none is a hint.
    if (window.getComputedStyle(el).pointerEvents === 'none') return false;
    return true;
  }

  function findChatInput() {
    const seen = new Set();

    for (const selector of INPUT_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isInputReady(el)) continue;
        return el;
      }
    }
    return null;
  }

  /** Polls until the composer exists and is enabled, or the timeout expires. */
  async function waitForChatInput(timeoutMs = INPUT_LOOKUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let input = findChatInput();
    while (!input && Date.now() < deadline) {
      await sleep(INPUT_POLL_MS);
      input = findChatInput();
    }
    return input;
  }

  // -------------------------------------------------------------------------
  // Prompt insertion (React-friendly)
  // -------------------------------------------------------------------------

  function selectEditableContents(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function setNativeValue(el, value) {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function inputText(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /** True when the composer already holds this prompt (or a longer version of it). */
  function alreadyHasPrompt(el, prompt) {
    const current = normalizeText(inputText(el));
    const target = normalizeText(prompt);
    if (!current || !target) return false;
    return current === target || current.includes(target);
  }

  function dispatchInput(el, data, inputType = 'insertText') {
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType,
          data: data || '',
        })
      );
    } catch (err) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Removes everything currently in the composer, including rich-text nodes. */
  function clearInput(el) {
    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';

    try {
      el.focus();
      if (isField) {
        el.select();
      } else {
        selectEditableContents(el);
      }
      // One delete pass removes the selection / all contenteditable children.
      document.execCommand('delete', false, null);
    } catch (err) {
      /* fall through to the direct reset below */
    }

    // Verify and hard-reset if anything survived.
    if (normalizeText(inputText(el))) {
      if (isField) {
        setNativeValue(el, '');
      } else {
        el.textContent = '';
      }
    }

    // Let React know the field is now empty.
    dispatchInput(el, '', 'deleteContentBackward');
    return normalizeText(inputText(el)) === '';
  }

  function insertPrompt(el, prompt) {
    el.focus();

    // Exactly one copy already in the box: nothing to clear or insert.
    if (normalizeText(inputText(el)) === normalizeText(prompt)) return true;

    // Leftover text from a previous attempt is removed first so the prompt is
    // never appended twice.
    clearInput(el);

    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    let inserted = false;

    try {
      if (isField) {
        el.focus();
        el.select();
      } else {
        el.focus();
        selectEditableContents(el);
      }
      inserted = document.execCommand('insertText', false, prompt);
    } catch (err) {
      inserted = false;
    }

    // Fall back only when the prompt is still missing after the insert pass.
    if (!alreadyHasPrompt(el, prompt)) {
      if (isField) {
        // React-controlled fields need the native setter.
        setNativeValue(el, prompt);
      } else {
        el.textContent = prompt;
      }
    }

    // React listens to the bubbled input event to sync its state.
    dispatchInput(el, prompt);

    return alreadyHasPrompt(el, prompt) || inserted;
  }

  // -------------------------------------------------------------------------
  // Send button discovery
  // -------------------------------------------------------------------------

  function buttonLabel(el) {
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function findSendButton(input) {
    const inputRect = input ? input.getBoundingClientRect() : null;
    const candidates = [];

    for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"]')) {
      if (!isVisible(el) || isDisabled(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;

      const label = buttonLabel(el);
      const looksLikeSend =
        SEND_BUTTON_RE.test(label) ||
        el.getAttribute('type') === 'submit' ||
        /send/i.test(el.getAttribute('data-testid') || '');

      if (!looksLikeSend) continue;

      // Ignore obvious non-composer controls.
      if (/attach|upload|file|image|photo|mic|voice|record/i.test(label) && !/send/i.test(label)) {
        continue;
      }

      let score = 0;
      if (/send/i.test(label)) score += 4;
      if (/submit/i.test(label)) score += 3;
      if (el.getAttribute('type') === 'submit') score += 2;
      if (inputRect) {
        const rect = el.getBoundingClientRect();
        const dx = Math.abs(rect.left - inputRect.left) + Math.abs(rect.top - inputRect.top);
        score += Math.max(0, 3 - dx / 400);
      }

      candidates.push({ el, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].el : null;
  }

  function clickElement(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try {
        el.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })
        );
      } catch (err) {
        /* ignore */
      }
    }
    el.click();
  }

  function pressEnter(el) {
    const init = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // -------------------------------------------------------------------------
  // Video discovery / download
  // -------------------------------------------------------------------------

  function videoSource(video) {
    const candidates = [
      video.currentSrc,
      video.getAttribute('src'),
      video.src,
      ...Array.from(video.querySelectorAll('source')).map(
        (source) => source.getAttribute('src') || source.src
      ),
    ];
    return candidates.find((src) => typeof src === 'string' && src.trim()) || '';
  }

  function findLatestVideo() {
    const videos = Array.from(document.querySelectorAll('video')).filter(isVisible);
    if (!videos.length) {
      // Fall back to any video element, visible or not.
      const all = Array.from(document.querySelectorAll('video'));
      for (let i = all.length - 1; i >= 0; i--) {
        const src = videoSource(all[i]);
        if (src) return { video: all[i], src };
      }
      return null;
    }

    // "Most recently rendered" = last matching element in DOM order.
    for (let i = videos.length - 1; i >= 0; i--) {
      const src = videoSource(videos[i]);
      if (src) return { video: videos[i], src };
    }
    return null;
  }

  /** Counts playable videos: HAVE_CURRENT_DATA or better, with a usable source. */
  function countReadyVideos() {
    let count = 0;
    for (const video of document.querySelectorAll('video')) {
      if (video.readyState < 2) continue;
      const src = videoSource(video);
      if (!src) continue;
      if (!/^(https?:|blob:)/i.test(src)) continue;
      count += 1;
    }
    return count;
  }

  async function waitForLatestVideo(timeoutMs = VIDEO_LOOKUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let found = findLatestVideo();
    while (!found && Date.now() < deadline) {
      await sleep(VIDEO_POLL_MS);
      found = findLatestVideo();
    }
    return found;
  }

  function safeFilename(name) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .trim();
    return cleaned || 'video.mp4';
  }

  function downloadInPage(url, filename) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeFilename(filename);
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  async function handleSendPrompt(shot) {
    const prompt = shot && typeof shot.prompt === 'string' ? shot.prompt.trim() : '';

    // This handler always reports success so Auto Run All never halts on a
    // flaky composer; problems are surfaced as warnings for the console.
    try {
      if (!prompt) {
        return { ok: true, sent: false, warning: 'Shot has no prompt text.' };
      }

      // Wait up to 5s for a ready, enabled composer (it can be missing or
      // disabled while the previous video is still generating).
      const input = await waitForChatInput();
      if (!input) {
        console.warn('[meta-ai-automator] Composer not ready within 5s.');
        return { ok: true, sent: false, warning: 'Chat input not ready within 5s.' };
      }

      // Clears leftovers, then inserts the prompt exactly once.
      const inserted = insertPrompt(input, prompt);
      if (!inserted) {
        console.warn('[meta-ai-automator] Prompt insertion could not be verified.');
        return { ok: true, sent: false, warning: 'Prompt insertion could not be verified.' };
      }

      await sleep(SUBMIT_DELAY_MS);

      // Return as soon as the submit is triggered so the side panel can flip
      // the badge to "Sent" without waiting on the page's response.
      const sendButton = findSendButton(input);
      if (sendButton) {
        try {
          clickElement(sendButton);
          return { ok: true, sent: true, method: 'button' };
        } catch (err) {
          pressEnter(input);
          return { ok: true, sent: true, method: 'enter' };
        }
      }

      pressEnter(input);
      return { ok: true, sent: true, method: 'enter' };
    } catch (err) {
      console.warn('[meta-ai-automator] Send prompt error:', err);
      return { ok: true, sent: false, warning: err.message || 'Unexpected error.' };
    }
  }

  /** Latest video whose source is an actual downloadable http(s)/blob URL. */
  function findDownloadableVideo() {
    const all = Array.from(document.querySelectorAll('video'));
    for (let i = all.length - 1; i >= 0; i--) {
      const src = videoSource(all[i]);
      if (src && /^(https?:|blob:)/i.test(src)) return { video: all[i], src };
    }
    return null;
  }

  function findDownloadButton() {
    const buttons = Array.from(
      document.querySelectorAll('a[download], button, [role="button"], a')
    );
    for (let i = buttons.length - 1; i >= 0; i--) {
      const el = buttons[i];
      if (!isVisible(el) || isDisabled(el)) continue;
      if (/download/i.test(buttonLabel(el))) return el;
    }
    return null;
  }

  /** Polls up to 5s for a real MP4 URL (preferred) or a download button. */
  async function waitForDownloadTarget(timeoutMs = DOWNLOAD_LOOKUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = findDownloadableVideo();
      if (found) return { src: found.src };
      const button = findDownloadButton();
      if (button) return { button };
      if (Date.now() >= deadline) return null;
      await sleep(VIDEO_POLL_MS);
    }
  }

  async function handleGetLatestVideo(message) {
    const target = await waitForDownloadTarget();
    if (!target) {
      return {
        ok: false,
        error: 'No downloadable video URL or download button found within 5s.',
      };
    }

    const filename = safeFilename(message && message.filename ? message.filename : 'video.mp4');

    if (target.button) {
      try {
        clickElement(target.button);
        return { ok: true, handledInPage: true, filename };
      } catch (err) {
        return { ok: false, error: 'Download button click failed: ' + err.message };
      }
    }

    const { src } = target;

    if (src.startsWith('blob:')) {
      try {
        downloadInPage(src, filename);
        return { ok: true, handledInPage: true, filename };
      } catch (err) {
        return { ok: false, error: 'In-page download failed: ' + err.message };
      }
    }

    return { ok: true, url: src, filename };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === 'META_AI_SEND_PROMPT') {
      handleSendPrompt(message.shot)
        .then(sendResponse)
        // Even a hard failure reports ok so the side panel keeps moving.
        .catch((err) =>
          sendResponse({ ok: true, sent: false, warning: err.message || 'Unexpected error.' })
        );
      return true; // keep the message channel open for the async reply
    }

    if (message.type === 'META_AI_GET_LATEST_VIDEO') {
      handleGetLatestVideo(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message || 'Unexpected error.' }));
      return true;
    }

    if (message.type === 'META_AI_COUNT_VIDEOS') {
      // Synchronous read: the side panel polls this every few seconds.
      try {
        sendResponse({ count: countReadyVideos() });
      } catch (err) {
        sendResponse({ count: 0 });
      }
      return false;
    }

    return false;
  });
})();
