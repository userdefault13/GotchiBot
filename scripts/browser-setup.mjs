#!/usr/bin/env node
/**
 * GotchiBot Browser Tool — Setup script.
 * 
 * This script documents the dependency tradeoffs and provides the install command.
 * It is NEVER executed automatically — it is documentation only.
 * 
 * Tradeoffs documented:
 *   1. playwright-core + system Chrome (channel:'chrome') — ~5MB npm dep, uses
      already-installed system Chrome. No ~300MB browser binary download.
      Requires Chrome/Edge installed on the machine.
   2. Full playwright — ~300MB browser binary download via playwright install.
      Works out-of-the-box on any machine but large disk footprint.
   3. playwright-core only (headless, no browser) — minimal but requires
      separate browser installation (Chrome, Firefox, or WebKit).
 * 
 * Recommended: option 1 (playwright-core + system Chrome) for the GotchiBot iMac
 * development environment where Chrome is always available.
 * 
 * Usage (run manually after reviewing):
 *   node scripts/browser-setup.mjs --mode recommend
 *   # or: node scripts/browser-setup.mjs --mode full
 * 
 * After running the recommended mode, activate the tool:
 *   node scripts/browser-tool.mjs --help   # should work pre-install
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_DIR = `${ROOT}/scripts`;
const CONFIG_DIR = `${ROOT}/config`;

function showTradeoffs() {
  console.log(`GotchiBot Browser Tool — Dependency Tradeoffs
==============================================

1) playwright-core + system Chrome (channel:'chrome')
   - npm dep: playwright-core (~5MB)
   - Browser: uses already-installed Google Chrome or Edge
   - Install: npm i -D playwright-core @playwright/test
   - Runtime: npx playwright install --channel chrome
   - Pros: Small download, fast, no 300MB binary
   - Cons: Requires Chrome/Edge installed on the machine
   - Best for: iMac dev environment (Chrome always available)

2) Full Playwright (default)
   - npm dep: playwright (~200MB+ tarball)
   - Browser: downloads Chromium (~300MB) automatically
   - Install: npm i -D playwright
   - Runtime: npx playwright install
   - Pros: Works out-of-the-box on any machine
   - Cons: Large disk footprint, slow first install
   - Best: Universal compatibility

3) playwright-core only (headless, no built-in browser)
   - npm dep: playwright-core only
   - Browser: MUST install a browser separately (chrome, firefox, webkit)
   - Install: npm i playwright-core && npx playwright install chromium
   - Pros: Minimal npm package size
   - Cons: Requires explicit browser setup
   - Best: CI/CD or minimal-container environments

==============================================
Recommended for GotchiBot iMac: Option 1 (playwright-core + system Chrome)
==============================================
`);
}

function showInstallCommand() {
  console.log(`To activate the GotchiBot browser tool, run (after reviewing tradeoffs):

  # Option A: playwright-core + system Chrome (recommended for iMac)
  npm i -D playwright-core
  npx playwright install --channel chrome

  # Option B: Full Playwright (universal)
  npm i -D playwright
  npx playwright install

  # Then verify:
  node scripts/browser-tool.mjs --help

  # To start a session:
  ./scripts/browser-tool.mjs goto "https://example.com" --session myprofile

==============================================
After install, register the browser-tool skill:
  ./scripts/opencode-dispatch.sh new "Browser tool ready for agent tasks"
==============================================
`);
}

const args = process.argv.slice(2);

if (args.includes("--mode") && args[1]) {
  const mode = args[1];
  if (mode === "recommend") {
    showTradeoffs();
    showInstallCommand();
  } else if (mode === "full") {
    console.log(`Full Playwright install guide:
1. npm i -D playwright
2. npx playwright install
3. Verify: node scripts/browser-tool.mjs --help
`);
  } else {
    console.error(`Unknown mode: ${mode}. Use --mode recommend or --mode full`);
    process.exit(1);
  }
} else {
  showTradeoffs();
  showInstallCommand();
}

main();