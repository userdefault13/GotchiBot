/**
 * Settings — Hub status, this device, sign out.
 */
import { APP_VERSION } from "./version.js";
import { iconChevronLeft, iconSignOut } from "./icons.js";
import { formatRunnerStatusLine } from "./compose-model.js";
import { ApiError, hubHealth, runnerStatus } from "./api.js";
import { clearDesk } from "./storage.js";
import { app, clearPoller, navigate } from "./state.js";
import { el, iconButton, openSheet, topNav } from "./ui.js";
import { shortAddress } from "./desk-model.js";

function group(title, rows) {
  const section = el("section", "settings-group");
  section.appendChild(el("h2", "settings-heading", title));
  const card = el("div", "settings-card");
  for (const [label, value] of rows) {
    const row = el("div", "settings-row");
    row.appendChild(el("span", "settings-label", label));
    const v = value instanceof Node ? value : el("span", "settings-value", value);
    row.appendChild(v);
    card.appendChild(row);
  }
  section.appendChild(card);
  return section;
}

export async function renderSettingsView(root) {
  clearPoller();
  root.replaceChildren();
  root.className = "app-shell";

  const back = iconButton(iconChevronLeft(22), "Back", () => navigate("#/projects"));
  root.appendChild(topNav({ title: "Settings", left: back, center: true }));

  const main = el("main", "settings");
  const hubStatus = el("span", "settings-value", "…");
  const runnerLine = el("span", "settings-value", "…");
  main.appendChild(
    group("Hub", [
      ["Address", location.host],
      ["Status", hubStatus],
      ["Runner", runnerLine],
    ]),
  );

  const d = app.desk;
  main.appendChild(
    group("This device", [
      ["Name", d?.name || "—"],
      ["Signed in with", d?.walletAddress ? shortAddress(d.walletAddress) : "pairing code"],
      ["Since", d?.pairedAt ? new Date(d.pairedAt).toLocaleDateString() : "—"],
      ["Desk id", d?.deskId || "—"],
    ]),
  );

  main.appendChild(group("App", [["Version", APP_VERSION]]));

  const signOut = el("button", "btn-danger btn-block");
  signOut.type = "button";
  signOut.innerHTML = `${iconSignOut(18)}<span>Sign out</span>`;
  signOut.addEventListener("click", () => {
    const body = el("div", "confirm");
    const revokeCmd = `gotchibot hub revoke ${d?.deskId || "<deskId>"}`;
    body.appendChild(
      el("p", "subtle", "This clears the sign-in on this device. To kill the token on the Hub too, run:"),
    );
    body.appendChild(el("code", "cmd-block", revokeCmd));
    const yes = el("button", "btn-danger btn-block", "Sign out");
    yes.type = "button";
    const sheet = openSheet({ title: "Sign out?", body });
    yes.addEventListener("click", async () => {
      sheet.close();
      await clearDesk();
      app.desk = null;
      app.projects.clear();
      app.threadTitles.clear();
      for (const url of app.avatarUrls.values()) if (url) URL.revokeObjectURL(url);
      app.avatarUrls.clear();
      navigate("#/login", { replace: true });
    });
    body.appendChild(yes);
  });
  main.appendChild(signOut);

  const licenses = el("p", "subtle licenses-links");
  const a1 = el("a", null, "NOTICE");
  a1.href = "NOTICE";
  const a2 = el("a", null, "Third-party licenses");
  a2.href = "THIRD_PARTY/README.md";
  licenses.append(document.createTextNode("Licenses: "), a1, document.createTextNode(" · "), a2);
  main.appendChild(licenses);
  root.appendChild(main);

  try {
    const health = await hubHealth();
    const bits = [];
    if (health?.version) bits.push(`v${health.version}`);
    if (health?.db) bits.push(`db ${health.db}`);
    hubStatus.textContent = bits.join(" · ") || (health?.ok ? "ok" : "unknown");
  } catch {
    hubStatus.textContent = "unreachable";
  }
  try {
    const data = await runnerStatus(app.desk.deskToken);
    runnerLine.textContent = formatRunnerStatusLine(data?.runner);
  } catch (err) {
    runnerLine.textContent =
      err instanceof ApiError && err.kind === "unpaired" ? "signed out" : "unreachable";
  }
}
