#!/usr/bin/env node
/**
 * Write a QR PNG for iPhone → iMac opencode serve.
 *
 * Default: plain http URL (iOS Camera / Safari friendly).
 * --openlens: openlens:// deep link (scan inside OpenLens app only).
 *
 * Secrets from env (abra). Never prints the password.
 *
 *   ./scripts/gotchibot qr
 *   ./scripts/gotchibot qr --openlens
 */
import { hubNetworkHost } from "./claude-bridge-role.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const host = (process.env.REMOTE_HOST || hubNetworkHost()).replace(/^https?:\/\//, "");
const port = process.env.OPENCODE_SERVER_PORT || "4096";
const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const pass = process.env.OPENCODE_SERVER_PASSWORD || "";
const openlens = process.argv.includes("--openlens");
const authUrlOnly = process.argv.includes("--auth-url") || process.argv.includes("--copy");

const server = `${host}:${port}`;
const httpUrl = `http://${server}`;

if (authUrlOnly) {
  if (!pass) {
    console.error("OPENCODE_SERVER_PASSWORD missing — use: abra run gotchibot -- ./scripts/gotchibot qr --copy");
    process.exit(1);
  }
  const url = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${server}`;
  const copied = spawnSync("pbcopy", { input: url, encoding: "utf8" });
  if (copied.status !== 0) {
    console.error("pbcopy failed");
    process.exit(1);
  }
  console.log("Copied to clipboard (password hidden).");
  console.log(`Paste into OpenCode Mobile → Server URL: http://${user}:***@${server}`);
  process.exit(0);
}

let payload;
let label;
if (openlens) {
  if (!pass) {
    console.error("OPENCODE_SERVER_PASSWORD missing for --openlens — use: abra run gotchibot -- ./scripts/gotchibot qr --openlens");
    process.exit(1);
  }
  // OpenLens docs: openlens://connect?url=host:port&user=…&pass=…
  // Do not percent-encode host:port (matches openlens-qr CLI).
  payload = `openlens://connect?url=${server}&user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`;
  label = `OpenLens deep link (scan in OpenLens → Scan QR, not Camera)`;
} else {
  payload = httpUrl;
  label = `HTTP URL for Camera/Safari — enter user/password in the app`;
}

const outDir = join(root, "tmp");
mkdirSync(outDir, { recursive: true });
const png = join(outDir, openlens ? "opencode-iphone-qr-openlens.png" : "opencode-iphone-qr.png");

const swift = `
import Foundation
import CoreImage
import AppKit

let payload = ProcessInfo.processInfo.environment["QR_PAYLOAD"]!
guard let data = payload.data(using: .utf8),
      let filter = CIFilter(name: "CIQRCodeGenerator") else { fatalError("qr filter") }
filter.setValue(data, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let output = filter.outputImage else { fatalError("no output") }
let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
let rep = NSCIImageRep(ciImage: scaled)
let img = NSImage(size: rep.size)
img.addRepresentation(rep)
guard let tiff = img.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let pngData = bitmap.representation(using: .png, properties: [:]) else { fatalError("png") }
try pngData.write(to: URL(fileURLWithPath: ProcessInfo.processInfo.environment["QR_OUT"]!))
`;

const r = spawnSync("swift", ["-e", swift], {
  env: { ...process.env, QR_PAYLOAD: payload, QR_OUT: png },
  encoding: "utf8",
});
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || "swift QR generation failed");
  process.exit(r.status || 1);
}

console.log(png);
console.log(label);
console.log(`URL:  ${httpUrl}`);
console.log(`User: ${user}`);
console.log(`Pass: abra get gotchibot OPENCODE_SERVER_PASSWORD`);
console.log("");
console.log("Note: opencode serve does NOT print a QR — companions do (OpenLens openlens-qr, OpenRemote plugin, etc).");
spawnSync("open", [png], { stdio: "ignore" });
