/**
 * Sign-in views: owner wallet (primary) and pairing code (fallback).
 *
 * Wallet: EIP-1193 injected provider (MetaMask / Coinbase Wallet in-app
 * browser). The Hub verifies the personal_sign signature with Foundry cast and
 * mints a phone desk token. Inside a wallet browser the user can instead ask
 * for a one-time pairing code to carry over to the Home Screen app.
 */
import { iconQr, iconWallet } from "./icons.js";
import { formatCode, isValidCode, normalizeCode } from "./pair.js";
import { ApiError, claimPair, walletLogin, walletNonce, whoami } from "./api.js";
import { setDesk } from "./storage.js";
import { openScanner } from "./scan.js";
import { app, clearPoller, navigate } from "./state.js";
import { el, openSheet } from "./ui.js";
import { toHexUtf8, walletBrowserLinks } from "./desk-model.js";

function provider() {
  const eth = /** @type {any} */ (globalThis).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    /** @type {any} */ (navigator).standalone === true
  );
}

function deviceName() {
  return /iPad/.test(navigator.userAgent) ? "iPad" : "iPhone";
}

function walletErrorText(err) {
  if (err?.code === 4001) return "Signature request was cancelled";
  if (err instanceof ApiError) {
    if (err.status === 503) return err.message;
    if (err.status === 403 && /owner/.test(err.message)) {
      return "That wallet isn't the Hub owner — switch accounts and try again";
    }
    if (err.status === 403) return "Not signed in as the Hub owner on Tailscale";
    if (err.status === 429) return "Too many attempts — wait a few minutes";
    if (err.kind === "offline") return "Can't reach the Hub — check Tailscale and try again";
    return err.message || "Sign-in failed";
  }
  return err?.message || "Sign-in failed";
}

function brandBlock(subtitle) {
  const hero = el("div", "login-hero");
  const logo = el("img", "login-logo");
  logo.src = "icons/icon-192.png";
  logo.alt = "";
  hero.appendChild(logo);
  hero.appendChild(el("h1", "login-title", "GotchiBot"));
  hero.appendChild(el("p", "login-tagline", subtitle));
  return hero;
}

/* ── Wallet sign-in ─────────────────────────────────────────────────── */

export function renderLoginView(root) {
  clearPoller();
  root.replaceChildren();
  root.className = "app-shell login-shell";

  const main = el("main", "login");
  main.appendChild(brandBlock("Your cAavegotchi crew, on your phone."));

  const card = el("section", "login-card");
  const errEl = el("p", "form-error");
  errEl.hidden = true;
  const flash = app.flash;
  app.flash = null;
  if (flash) {
    errEl.hidden = false;
    errEl.textContent = flash;
  }
  const showError = (msg) => {
    errEl.hidden = !msg;
    errEl.textContent = msg || "";
  };

  const eth = provider();
  const primary = el("button", "btn-primary btn-block");
  primary.type = "button";
  primary.innerHTML = `${iconWallet(18)}<span>Sign in with wallet</span>`;
  card.appendChild(primary);

  /** Inside a wallet browser but not the installed app: offer the handoff. */
  let handoffBtn = null;
  if (eth && !isStandalone()) {
    handoffBtn = el("button", "btn-secondary btn-block", "Sign in the Home Screen app instead");
    handoffBtn.type = "button";
    card.appendChild(handoffBtn);
  }

  card.appendChild(errEl);

  const note = el(
    "p",
    "login-note",
    eth
      ? "You'll sign a one-time message with the Hub owner's wallet. No transaction, no gas."
      : "No wallet in this browser. Open GotchiBot inside your wallet's browser to sign in.",
  );
  card.appendChild(note);
  main.appendChild(card);

  const alt = el("button", "link-btn login-alt", "Use a pairing code instead");
  alt.type = "button";
  alt.addEventListener("click", () => navigate("#/pair"));
  main.appendChild(alt);
  root.appendChild(main);

  async function signIn({ handoff }) {
    showError("");
    const wallet = provider();
    if (!wallet) {
      openWalletPicker();
      return;
    }
    primary.disabled = true;
    if (handoffBtn) handoffBtn.disabled = true;
    try {
      const accounts = await wallet.request({ method: "eth_requestAccounts" });
      const address = accounts?.[0];
      if (!address) throw new Error("No account returned by the wallet");
      const { nonce, message } = await walletNonce();
      const signature = await wallet.request({
        method: "personal_sign",
        params: [toHexUtf8(message), address],
      });
      const result = await walletLogin({
        address,
        signature,
        nonce,
        name: deviceName(),
        handoff,
      });
      if (handoff) {
        showHandoff(result.handoff);
        return;
      }
      app.desk = await setDesk({
        deskId: result.deskId,
        deskToken: result.deskToken,
        name: result.name || deviceName(),
        kind: result.kind || "phone",
        walletAddress: result.walletAddress || address,
      });
      navigate("#/projects", { replace: true });
    } catch (err) {
      showError(walletErrorText(err));
    } finally {
      primary.disabled = false;
      if (handoffBtn) handoffBtn.disabled = false;
    }
  }

  function showHandoff(handoff) {
    const body = el("div", "handoff");
    body.appendChild(
      el("p", "subtle", "Open this link in Safari (or the Home Screen app) within 15 minutes:"),
    );
    const code = el("div", "handoff-code", handoff.code);
    body.appendChild(code);
    const link = `${location.origin}/app/#pair=${encodeURIComponent(handoff.code)}`;
    const open = el("a", "btn-primary btn-block", "Open in Safari");
    open.href = `x-safari-${link}`;
    body.appendChild(open);
    const copy = el("button", "btn-secondary btn-block", "Copy link");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = link;
      }
    });
    body.appendChild(copy);
    openSheet({ title: "Pairing code ready", body });
  }

  function openWalletPicker() {
    const body = el("div", "wallet-picker");
    body.appendChild(
      el(
        "p",
        "subtle",
        "iPhone Safari can't talk to wallets directly. Reopen this page in your wallet's browser, sign there, then choose “Sign in the Home Screen app”.",
      ),
    );
    for (const w of walletBrowserLinks(location.href.split("#")[0])) {
      const a = el("a", "btn-secondary btn-block", `Open in ${w.label}`);
      a.href = w.href;
      a.rel = "noreferrer";
      body.appendChild(a);
    }
    const pair = el("button", "link-btn", "Use a pairing code instead");
    pair.type = "button";
    const sheet = openSheet({ title: "Sign in with wallet", body });
    pair.addEventListener("click", () => {
      sheet.close();
      navigate("#/pair");
    });
    body.appendChild(pair);
  }

  primary.addEventListener("click", () => void signIn({ handoff: false }));
  handoffBtn?.addEventListener("click", () => void signIn({ handoff: true }));
}

/* ── Pairing code ───────────────────────────────────────────────────── */

export function renderPairView(root, { prefills = null } = {}) {
  clearPoller();
  root.replaceChildren();
  root.className = "app-shell login-shell";

  const main = el("main", "login");
  main.appendChild(brandBlock("Pair with a one-time code from the Hub."));

  const card = el("section", "login-card");
  const form = el("form", "pair-form");
  form.setAttribute("novalidate", "");

  const codeLabel = el("label", "field-label", "Pairing code");
  codeLabel.setAttribute("for", "pair-code");
  const codeInput = el("input", "pair-code-input");
  codeInput.id = "pair-code";
  codeInput.type = "text";
  codeInput.inputMode = "text";
  codeInput.autocomplete = "one-time-code";
  codeInput.setAttribute("autocapitalize", "characters");
  codeInput.setAttribute("spellcheck", "false");
  codeInput.placeholder = "XXXX-XXXX";
  codeInput.maxLength = 9;
  if (prefills) codeInput.value = formatCode(prefills);
  codeInput.addEventListener("input", () => {
    const formatted = formatCode(codeInput.value);
    if (formatted !== codeInput.value) {
      codeInput.value = formatted;
      try {
        codeInput.setSelectionRange(formatted.length, formatted.length);
      } catch {
        /* ignore */
      }
    }
  });

  const nameLabel = el("label", "field-label", "Device name");
  nameLabel.setAttribute("for", "pair-name");
  const nameInput = el("input");
  nameInput.id = "pair-name";
  nameInput.type = "text";
  nameInput.value = deviceName();
  nameInput.autocomplete = "off";

  const errEl = el("p", "form-error");
  errEl.hidden = true;
  const submitBtn = el("button", "btn-primary btn-block", "Pair this device");
  submitBtn.type = "submit";
  const scanBtn = el("button", "btn-secondary btn-block");
  scanBtn.type = "button";
  scanBtn.innerHTML = `${iconQr(18)}<span>Scan QR</span>`;

  form.append(codeLabel, codeInput, nameLabel, nameInput, errEl, submitBtn, scanBtn);
  card.appendChild(form);
  card.appendChild(
    el("p", "login-note", "On the Hub: gotchibot hub pair --kind phone"),
  );
  main.appendChild(card);

  const back = el("button", "link-btn login-alt", "Sign in with wallet instead");
  back.type = "button";
  back.addEventListener("click", () => navigate("#/login"));
  main.appendChild(back);
  root.appendChild(main);

  const showError = (msg) => {
    errEl.hidden = !msg;
    errEl.textContent = msg || "";
  };

  async function doClaim(codeRaw) {
    showError("");
    const code = formatCode(codeRaw);
    if (!isValidCode(code)) {
      showError("Enter an 8-character pairing code");
      return;
    }
    const name = (nameInput.value || deviceName()).trim() || deviceName();
    submitBtn.disabled = true;
    scanBtn.disabled = true;
    try {
      const result = await claimPair({ code: normalizeCode(code), name, kind: "phone" });
      if (!result?.ok || !result.deskToken) {
        showError("Pairing failed — try a fresh code");
        return;
      }
      app.desk = await setDesk({
        deskId: result.deskId,
        deskToken: result.deskToken,
        name: result.name || name,
        kind: result.kind || "phone",
      });
      const who = await whoami(app.desk.deskToken);
      if (who?.walletAddress) {
        app.desk = await setDesk({ ...app.desk, walletAddress: who.walletAddress });
      }
      // Drops #pair=CODE from the URL
      navigate("#/projects", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.kind === "unpaired") {
          showError("That code is expired or already used — mint a new one on the Hub");
        } else if (err.status === 403) {
          showError("Not signed in as the Hub owner on Tailscale");
        } else if (err.kind === "offline") {
          showError("Can't reach the Hub — check Tailscale and try again");
        } else {
          showError(err.message || "Pairing failed");
        }
      } else {
        showError(err?.message || "Pairing failed");
      }
    } finally {
      submitBtn.disabled = false;
      scanBtn.disabled = false;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void doClaim(codeInput.value);
  });
  scanBtn.addEventListener("click", async () => {
    showError("");
    const code = await openScanner();
    if (!code) return;
    codeInput.value = formatCode(code);
    await doClaim(code);
  });
}
