/**
 * GotchiBot phone desk — hash router + boot. Modeled on the terminal desk:
 * sync → verify the owner wallet → cockpit (root menu) → pick a project → chat.
 *   #/login · #/pair · #pair=CODE → sync (sign-in)
 *   #/verify · #verify=CODE       → owner-wallet check (MetaMask)
 *   #/ · #/cockpit                → cockpit
 *   #/projects                    → project picker
 *   #/roster · #/kanban · #/inbox · #/hub → read-only desk views
 *   #/p/<slug>[/t/<threadId>]     → project chat (+ crew pane)
 *   #/settings
 */
import { parsePairHash, parseVerifyHash } from "./pair.js";
import { getDesk, setDesk } from "./storage.js";
import { app, handleVerifyRequired, navigate } from "./state.js";
import { parseDeskRoute } from "./desk-model.js";
import { ApiError, setVerifyRequiredHandler, whoami } from "./api.js";
import { renderLoginView, renderPairView } from "./login.js";
import { renderVerifyView, renderWalletVerifyView } from "./verify.js";
import { renderCockpitView } from "./cockpit.js";
import { renderCockpitSection } from "./cockpit-views.js";
import { renderPortfolioView } from "./portfolio.js";
import { renderChatView } from "./chat.js";
import { renderSettingsView } from "./settings.js";

let bootOnce = false;
/** deskId whose verify state was fetched this launch (a new sign-in re-checks). */
let verifyCheckedFor = null;

/** Sheets / panes live on <body>; never carry them across views. */
function dropOverlays() {
  for (const n of document.querySelectorAll(".sheet-backdrop, .pane-backdrop")) n.remove();
  document.body.classList.remove("no-scroll");
}

/** Once per launch: ask the Hub whether this phone still has to verify its wallet. */
async function refreshVerifyState() {
  if (!app.desk || verifyCheckedFor === app.desk.deskId) return;
  verifyCheckedFor = app.desk.deskId;
  try {
    const who = await whoami(app.desk.deskToken);
    app.verifyRequired = Boolean(who?.verifyRequired);
    const wallet = who?.walletAddress || null;
    if (wallet !== (app.desk.walletAddress || null)) {
      app.desk = await setDesk({ ...app.desk, walletAddress: wallet });
    }
  } catch (err) {
    if (err instanceof ApiError && err.kind === "unpaired") return;
    // Offline: an unverified phone stays gated; the Hub enforces it anyway.
    app.verifyRequired = !app.desk.walletAddress && app.desk.kind === "phone";
  }
}

async function route() {
  const root = document.getElementById("root");
  if (!root) return;
  dropOverlays();

  const raw = location.hash || "";
  // Inside MetaMask: #verify=CODE signs for the phone that asked (no desk needed here).
  const verifyCode = parseVerifyHash(raw);
  if (verifyCode) {
    renderWalletVerifyView(root, verifyCode);
    return;
  }
  // Deep link #pair=CODE → pair view prefilled (tap to confirm)
  const pairCode = parsePairHash(raw);
  if (pairCode && !raw.startsWith("#/")) {
    renderPairView(root, { prefills: pairCode });
    return;
  }

  const r = parseDeskRoute(raw);
  if (!app.desk) app.desk = await getDesk();

  if (r.name === "pair") {
    renderPairView(root);
    return;
  }
  if (!app.desk) {
    if (r.name !== "login") {
      navigate("#/login", { replace: true });
      return;
    }
    renderLoginView(root);
    return;
  }
  if (r.name === "login") {
    navigate("#/cockpit", { replace: true });
    return;
  }

  await refreshVerifyState();
  if (r.name === "settings") {
    await renderSettingsView(root);
    return;
  }
  if (app.verifyRequired) {
    if (r.name !== "verify") {
      navigate("#/verify", { replace: true });
      return;
    }
    await renderVerifyView(root);
    return;
  }
  if (r.name === "verify" || r.name === "verified") {
    navigate("#/cockpit", { replace: true });
    return;
  }
  if (r.name === "chat") {
    await renderChatView(root, r);
    return;
  }
  if (r.name === "projects") {
    await renderPortfolioView(root);
    return;
  }
  if (r.name === "view") {
    await renderCockpitSection(root, r.view);
    return;
  }
  await renderCockpitView(root);
}

async function boot() {
  if (bootOnce) return;
  bootOnce = true;
  app.route = route;
  setVerifyRequiredHandler(handleVerifyRequired);
  window.addEventListener("hashchange", () => void route());
  await route();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot());
  } else {
    void boot();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      /* ignore registration failures on file:// or unsupported hosts */
    });
  }
}
