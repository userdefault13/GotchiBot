import { APP_VERSION } from "./version.js";

const root = document.getElementById("root");
if (root) {
  root.innerHTML = `
    <header class="top-nav">
      <div class="brand-section">
        <div class="brand-title">
          <img class="app-icon" src="icons/icon-32.png" width="34" height="34" alt="">
          <h1>GotchiBot</h1>
        </div>
      </div>
    </header>
    <main class="panel">
      <div class="empty-state">
        <p>GotchiBot phone viewer</p>
        <p class="subtle">v${APP_VERSION} — pair a desk to read hub chats</p>
      </div>
    </main>
  `;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
    /* ignore registration failures on file:// or unsupported hosts */
  });
}
