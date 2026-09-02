#!/usr/bin/env node
/**
 * GotchiBot theme install — reads .opencode/themes/gotchi.json and copies
 * to $HOME/.config/opencode/themes/gotchi.json (mkdir -p).
 * Exits 0 on success.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, writeFileSync, mkdirSync, readFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const themeSrc = `${ROOT}/.opencode/themes/gotchi.json`;
const destDir = `${process.env.HOME}/.config/opencode/themes`;
const dest = `${destDir}/gotchi.json`;

// Ensure destination directory exists
mkdirSync(destDir, { recursive: true });

// Read source and write to destination
const srcContent = readFileSync(themeSrc, "utf8");
writeFileSync(dest, srcContent);

console.log(`ok   gotchi OpenCode theme installed to ${dest}`);
process.exit(0);