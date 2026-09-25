/**
 * In-app QR scanner overlay for pairing codes.
 * Lazy-loads vendor/jsQR.min.js (CSP 'self'); never precached by the SW.
 */

import { extractCodeFromScan } from "./pair.js";
import { iconQr } from "./icons.js";

const HTTPS_HINT = "Camera needs HTTPS on the Hub — type the code instead";
const SAMPLE_MS = 200;

let jsQrLoading = null;

function loadJsQr() {
  if (typeof window !== "undefined" && typeof window.jsQR === "function") {
    return Promise.resolve(window.jsQR);
  }
  if (jsQrLoading) return jsQrLoading;
  jsQrLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-gotchibot-jsqr]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.jsQR));
      existing.addEventListener("error", () => reject(new Error("jsQR load failed")));
      return;
    }
    const s = document.createElement("script");
    s.src = "vendor/jsQR.min.js";
    s.async = true;
    s.dataset.gotchibotJsqr = "1";
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => reject(new Error("jsQR load failed"));
    document.head.appendChild(s);
  });
  return jsQrLoading;
}

function stopTracks(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open scanner overlay. Resolves with a formatted code or null (cancel).
 * @returns {Promise<string|null>}
 */
export function openScanner() {
  return new Promise((resolve) => {
    let settled = false;
    let stream = null;
    let raf = null;
    let sampleTimer = null;
    let lastSample = 0;
    /** @type {HTMLVideoElement|null} */
    let video = null;
    /** @type {HTMLCanvasElement|null} */
    let canvas = null;

    function finish(code) {
      if (settled) return;
      settled = true;
      document.removeEventListener("visibilitychange", onVis);
      if (raf != null) cancelAnimationFrame(raf);
      if (sampleTimer != null) clearTimeout(sampleTimer);
      stopTracks(stream);
      stream = null;
      overlay.remove();
      resolve(code);
    }

    function onVis() {
      if (document.visibilityState === "hidden") {
        finish(null);
      }
    }

    const overlay = document.createElement("div");
    overlay.className = "scanner-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Scan pairing QR");

    const frame = document.createElement("div");
    frame.className = "scanner-frame";

    video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.autoplay = true;
    frame.appendChild(video);

    canvas = document.createElement("canvas");
    canvas.className = "scanner-canvas-hidden";
    frame.appendChild(canvas);

    const hint = document.createElement("p");
    hint.className = "scanner-hint";
    hint.textContent = "Point at the Hub pairing QR";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-secondary scanner-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => finish(null));

    const title = document.createElement("div");
    title.className = "scanner-title";
    title.innerHTML = iconQr(22);
    const titleText = document.createElement("span");
    titleText.textContent = " Scan QR";
    title.appendChild(titleText);

    overlay.appendChild(title);
    overlay.appendChild(frame);
    overlay.appendChild(hint);
    overlay.appendChild(cancelBtn);
    document.body.appendChild(overlay);

    document.addEventListener("visibilitychange", onVis);

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      hint.textContent = HTTPS_HINT;
      return;
    }

    (async () => {
      try {
        await loadJsQr();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        video.srcObject = stream;
        await video.play().catch(() => {});
      } catch (err) {
        hint.textContent =
          err?.name === "NotAllowedError"
            ? "Camera permission denied — type the code instead"
            : HTTPS_HINT;
        stopTracks(stream);
        stream = null;
        return;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      function sample() {
        if (settled) return;
        raf = requestAnimationFrame(sample);
        const now = performance.now();
        if (now - lastSample < SAMPLE_MS) return;
        lastSample = now;
        if (!video || video.readyState < 2) return;
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        let imageData;
        try {
          imageData = ctx.getImageData(0, 0, w, h);
        } catch {
          return;
        }
        const jsQR = window.jsQR;
        if (typeof jsQR !== "function") return;
        const result = jsQR(imageData.data, w, h, { inversionAttempts: "dontInvert" });
        if (!result || !result.data) return;
        const code = extractCodeFromScan(result.data);
        if (code) finish(code);
      }

      raf = requestAnimationFrame(sample);
    })();
  });
}
