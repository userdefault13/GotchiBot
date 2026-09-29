/**
 * Owner-wallet verification for a synced phone.
 *
 *   #/verify       Home Screen app: the phone is paired but has not proven the
 *                  Hub owner wallet. Opens this page inside MetaMask with a
 *                  one-time link code, then waits for the Hub to record it.
 *   #verify=CODE   Inside MetaMask's browser: sign once, bind the wallet to the
 *                  phone that asked, and send the user back to the Home Screen.
 *
 * iPhone Safari cannot reach a wallet directly, so the signature happens in the
 * wallet's in-app browser and the Home Screen app learns the result by polling
 * whoami (no code to carry back).
 */
import { iconWallet } from "./icons.js";
import { ApiError, walletNonce, walletVerify, walletVerifyRequest, whoami } from "./api.js";
import { setDesk } from "./storage.js";
import { app, handleUnpaired, navigate, setViewCleanup } from "./state.js";
import { el } from "./ui.js";
import { metamaskDappLink, toHexUtf8 } from "./desk-model.js";
import { walletErrorText } from "./login.js";

const POLL_MS = 2000;

function provider() {
  const eth = /** @type {any} */ (globalThis).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

function brand(subtitle) {
  const hero = el("div", "login-hero");
  const logo = el("img", "login-logo");
  logo.src = "icons/icon-192.png";
  logo.alt = "";
  hero.appendChild(logo);
  hero.appendChild(el("h1", "login-title", "GotchiBot"));
  hero.appendChild(el("p", "login-tagline", subtitle));
  return hero;
}

/** Sign the Hub nonce in the injected wallet and bind it to the phone behind `code`. */
async function signAndVerify(wallet, code) {
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("No account returned by the wallet");
  const { nonce, message } = await walletNonce();
  const signature = await wallet.request({
    method: "personal_sign",
    params: [toHexUtf8(message), address],
  });
  await walletVerify({ code, address, signature, nonce });
  return address;
}

/** Hub confirmed the wallet: remember it locally and open the cockpit. */
async function finishVerified(walletAddress) {
  app.verifyRequired = false;
  app.desk = await setDesk({ ...app.desk, walletAddress });
  navigate("#/cockpit", { replace: true });
}

/* ── Home Screen app: "Verify with MetaMask" ────────────────────────── */

export async function renderVerifyView(root) {
  root.replaceChildren();
  root.className = "app-shell login-shell";

  const main = el("main", "login");
  main.appendChild(brand("One signature to unlock this phone."));

  const card = el("section", "login-card verify-card");
  card.appendChild(
    el(
      "p",
      "verify-lead",
      `${app.desk?.name || "This phone"} is synced with the Hub. Sign once with the Hub owner's MetaMask wallet to open the cockpit.`,
    ),
  );
  const open = el("a", "btn-primary btn-block");
  open.rel = "noreferrer";
  open.innerHTML = `${iconWallet(18)}<span>Verify with MetaMask</span>`;
  open.setAttribute("aria-disabled", "true");
  card.appendChild(open);

  const waiting = el("p", "verify-waiting", "Waiting for your signature in MetaMask…");
  waiting.hidden = true;
  card.appendChild(waiting);

  const errEl = el("p", "form-error");
  errEl.hidden = true;
  card.appendChild(errEl);
  const showError = (msg) => {
    errEl.hidden = !msg;
    errEl.textContent = msg || "";
  };

  card.appendChild(
    el("p", "login-note", "MetaMask opens this page, you sign a message (no transaction, no gas), then come back here."),
  );
  main.appendChild(card);

  const settings = el("button", "link-btn login-alt", "Settings · sign out");
  settings.type = "button";
  settings.addEventListener("click", () => navigate("#/settings"));
  main.appendChild(settings);
  root.appendChild(main);

  let code = null;
  let codeExpiresAt = 0;
  let timer = null;
  let stopped = false;

  /** Pre-mint the link so the button is a real <a href> (iOS blocks async window.open). */
  async function refreshLink() {
    try {
      const r = await walletVerifyRequest(app.desk.deskToken);
      if (r?.verified) {
        await finishVerified(r.walletAddress);
        return;
      }
      code = r.code;
      codeExpiresAt = Date.parse(r.expiresAt) || Date.now() + 10 * 60 * 1000;
      open.href = metamaskDappLink(`${location.origin}${location.pathname}#verify=${encodeURIComponent(code)}`);
      open.removeAttribute("aria-disabled");
      showError("");
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        await handleUnpaired("This phone was signed out on the Hub");
        return;
      }
      showError(walletErrorText(err));
    }
  }

  async function check() {
    if (stopped || document.visibilityState === "hidden") return;
    try {
      const who = await whoami(app.desk.deskToken);
      if (who?.walletAddress) {
        stopped = true;
        await finishVerified(who.walletAddress);
        return;
      }
      if (who && who.verifyRequired === false) {
        stopped = true;
        app.verifyRequired = false;
        navigate("#/cockpit", { replace: true });
        return;
      }
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        stopped = true;
        await handleUnpaired("This phone was signed out on the Hub");
        return;
      }
    }
    if (!code || Date.now() > codeExpiresAt - 30_000) await refreshLink();
  }

  const wallet = provider();
  open.addEventListener("click", (e) => {
    if (!code) {
      e.preventDefault();
      return;
    }
    // Already inside a wallet browser: sign right here instead of bouncing out.
    if (wallet) {
      e.preventDefault();
      showError("");
      void signAndVerify(wallet, code)
        .then((address) => finishVerified(address))
        .catch((err) => {
          code = null;
          showError(walletErrorText(err));
        });
      return;
    }
    waiting.hidden = false;
  });

  const onVisible = () => void check();
  document.addEventListener("visibilitychange", onVisible);
  timer = setInterval(() => void check(), POLL_MS);
  setViewCleanup(() => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  });
  await refreshLink();
}

/* ── Inside MetaMask: #verify=CODE ──────────────────────────────────── */

export function renderWalletVerifyView(root, code) {
  root.replaceChildren();
  root.className = "app-shell login-shell";

  const main = el("main", "login");
  main.appendChild(brand("Verify your GotchiBot phone."));
  const card = el("section", "login-card verify-card");
  const errEl = el("p", "form-error");
  errEl.hidden = true;

  const wallet = provider();
  if (!wallet) {
    card.appendChild(el("p", "verify-lead", "Open this link inside MetaMask to sign."));
    const open = el("a", "btn-primary btn-block");
    open.href = metamaskDappLink(location.href);
    open.rel = "noreferrer";
    open.innerHTML = `${iconWallet(18)}<span>Open in MetaMask</span>`;
    card.appendChild(open);
    main.appendChild(card);
    root.appendChild(main);
    return;
  }

  card.appendChild(
    el("p", "verify-lead", "Sign with the Hub owner's wallet to unlock the phone that sent you here."),
  );
  const btn = el("button", "btn-primary btn-block");
  btn.type = "button";
  btn.innerHTML = `${iconWallet(18)}<span>Sign and verify</span>`;
  card.append(btn, errEl);
  card.appendChild(el("p", "login-note", "A one-time message. No transaction, no gas."));
  main.appendChild(card);
  root.appendChild(main);

  btn.addEventListener("click", async () => {
    errEl.hidden = true;
    btn.disabled = true;
    try {
      await signAndVerify(wallet, code);
      card.replaceChildren(
        el("h2", "verify-done", "Verified"),
        el("p", "verify-lead", "Switch back to GotchiBot on your Home Screen. It opens the cockpit on its own."),
      );
      history.replaceState(null, "", `${location.pathname}#/verified`);
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = walletErrorText(err);
      btn.disabled = false;
    }
  });
}
