#!/usr/bin/env node
/**
 * WSL2 setup helper — checklist + in-WSL doctor-lite.
 *   gotchibot wsl
 *   gotchibot wsl --check
 */
import { spawnSync } from "node:child_process";
import {
  isWsl,
  isNativeWindows,
  platformLabel,
  wslQuickStartLines,
  commandExists,
  hasAbra,
  runAbraDoctor,
  tmuxInstallHint,
  abraInstallHint,
  WSL_DOC,
} from "./platform.mjs";

const check = process.argv.includes("--check");

function line(msg) {
  console.log(msg);
}

function main() {
  if (isNativeWindows()) {
    for (const l of wslQuickStartLines()) line(l);
    line("");
    line("You are on native Windows. Open Ubuntu (WSL) and run:  gotchibot wsl --check");
    process.exit(0);
  }

  if (!isWsl()) {
    line(`platform: ${platformLabel()} (not WSL — this command is for Windows/WSL2 users)`);
    line(`See ${WSL_DOC} for Linux/macOS install.`);
    process.exit(0);
  }

  line(`platform: ${platformLabel()}`);
  line("");

  const checks = [
    ["node", commandExists("node"), "install Node 20+ in WSL"],
    ["tmux", commandExists("tmux"), tmuxInstallHint()],
    ["abra", hasAbra(), abraInstallHint()],
  ];

  let fails = 0;
  for (const [name, ok, hint] of checks) {
    if (ok) line(`ok    ${name}`);
    else {
      fails++;
      line(`fail  ${name} — ${hint}`);
    }
  }

  if (hasAbra()) {
    const ad = runAbraDoctor();
    if (ad.ok) line("ok    abra doctor");
    else {
      fails++;
      line("fail  abra doctor — fix keytar/libsecret or ABRA_KEYSTORE=passphrase-file");
    }
  }

  if (!check) {
    line("");
    line("Next:");
    line("  gotchibot onboard");
    line("  gotchibot tmux");
  }

  process.exit(fails ? 1 : 0);
}

main();
