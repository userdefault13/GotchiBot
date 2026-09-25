/**
 * Visibility-aware poll loop for the phone viewer.
 * Pure ES module — inject timers for tests; no DOM at import time.
 */

/**
 * @param {{
 *   intervalMs?: number,
 *   tick: () => (void|Promise<void>),
 *   isVisible: () => boolean,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} opts
 */
export function createPoller({
  intervalMs = 4000,
  tick,
  isVisible,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof tick !== "function") throw new Error("createPoller: tick required");
  if (typeof isVisible !== "function") throw new Error("createPoller: isVisible required");

  let _intervalMs = Math.max(100, Number(intervalMs) || 4000);
  let timerId = null;
  let _running = false;
  let inFlight = false;
  let generation = 0;

  function clearTimer() {
    if (timerId != null) {
      clearTimeoutFn(timerId);
      timerId = null;
    }
  }

  function schedule(gen) {
    clearTimer();
    if (!_running || gen !== generation) return;
    if (!isVisible()) return;
    timerId = setTimeoutFn(() => {
      timerId = null;
      void runTick(gen);
    }, _intervalMs);
  }

  async function runTick(gen) {
    if (!_running || gen !== generation) return;
    if (!isVisible()) return;
    if (inFlight) return;
    inFlight = true;
    try {
      await tick();
    } finally {
      inFlight = false;
      if (_running && gen === generation && isVisible()) {
        schedule(gen);
      }
    }
  }

  return {
    start() {
      if (_running) return;
      _running = true;
      generation += 1;
      const gen = generation;
      clearTimer();
      void runTick(gen);
    },
    stop() {
      _running = false;
      generation += 1;
      clearTimer();
    },
    /**
     * Change poll interval (e.g. faster while waiting for hub-runner).
     * Reschedules the next tick when already running.
     * @param {number} ms
     */
    setIntervalMs(ms) {
      const n = Math.max(100, Number(ms) || 0);
      if (!Number.isFinite(n) || n === _intervalMs) return;
      _intervalMs = n;
      if (_running && isVisible()) {
        schedule(generation);
      }
    },
    get intervalMs() {
      return _intervalMs;
    },
    get running() {
      return _running;
    },
  };
}
