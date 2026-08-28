#!/usr/bin/env node
/**
 * GotchiBot TTS — opt-in voice for orchestrator + sub-agents.
 *
 * usage:
 *   node scripts/tts.mjs speak "hello" [--persona gotchi]
 *   node scripts/tts.mjs on|off|status|test [--persona gotchi]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = `${ROOT}/config/tts.personas.json5`;
const STATE = `${ROOT}/sessions/.tts.json`;
const MELO_PYTHON = `${ROOT}/scripts/melo-python.sh`;
const MELO_TTS = `${ROOT}/scripts/melo-tts.sh`;
const MELO_PID = `${ROOT}/sessions/.melo-tts.pid`;
const MELO_SOCK = `${ROOT}/sessions/.melo-tts.sock`;

function stripJson5(raw) {
  return raw
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function loadConfig() {
  try {
    return JSON.parse(stripJson5(readFileSync(CONFIG, "utf8")));
  } catch {
    return { globalAutoTTS: false, personas: {} };
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { enabled: false, persona: "gotchi" };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

function enabled() {
  if (process.env.GOTCHIBOT_TTS === "on") return true;
  if (process.env.GOTCHIBOT_TTS === "off") return false;
  return loadState().enabled === true;
}

function personaName(argv) {
  const i = argv.indexOf("--persona");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.GOTCHIBOT_TTS_PERSONA || loadState().persona || "gotchi";
}

function personaConfig(name) {
  const cfg = loadConfig();
  return (
    cfg.personas?.[name] ||
    cfg.personas?.gotchi || {
      provider: "say",
      voice: "Samantha",
      rate: 180,
    }
  );
}

function hasCmd(cmd) {
  return spawnSync("command", ["-v", cmd], { shell: true }).status === 0;
}

function speakEdge(text, p) {
  const args = ["--voice", p.voice || "en-US-AnaNeural", "--text", text];
  if (p.pitch) args.push("--pitch", p.pitch);
  if (p.rate) args.push("--rate", p.rate);
  args.push("--play-audio");
  return spawnSync("edge-tts", args, { stdio: "ignore" }).status === 0;
}

function speakSay(text, p) {
  const voice = p.sayVoice || (String(p.voice || "").includes("_") ? "Samantha" : p.voice) || "Samantha";
  const args = ["-v", voice];
  const rate = p.sayRate ?? p.rate;
  if (typeof rate === "number") args.push("-r", String(rate));
  else if (typeof rate === "string" && /^\d+$/.test(rate)) args.push("-r", rate);
  args.push(text);
  return spawnSync("say", args, { stdio: "ignore" }).status === 0;
}

function meloAvailable() {
  return existsSync(MELO_PYTHON) && spawnSync("bash", [MELO_PYTHON], { encoding: "utf8" }).status === 0;
}

function meloDaemonRunning() {
  if (!existsSync(MELO_PID)) return false;
  const pid = readFileSync(MELO_PID, "utf8").trim();
  return spawnSync("kill", ["-0", pid], { stdio: "ignore" }).status === 0;
}

export function warmMelo() {
  if (!meloAvailable()) return { ok: false, reason: "melo-not-installed" };
  if (meloDaemonRunning()) return { ok: true, reason: "already-running" };
  mkdirSync(dirname(MELO_PID), { recursive: true });
  const py = spawnSync("bash", [MELO_PYTHON], { encoding: "utf8" }).stdout.trim();
  const child = spawn(py, [`${ROOT}/scripts/melo-daemon.py`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (existsSync(MELO_SOCK)) return { ok: true, reason: "started" };
    spawnSync("sleep", ["0.5"]);
  }
  return { ok: false, reason: "daemon-timeout" };
}

export function stopMelo() {
  if (!existsSync(MELO_PID)) return { ok: true, reason: "not-running" };
  const pid = readFileSync(MELO_PID, "utf8").trim();
  spawnSync("kill", [pid], { stdio: "ignore" });
  try {
    unlinkSync(MELO_PID);
  } catch {}
  try {
    unlinkSync(MELO_SOCK);
  } catch {}
  return { ok: true, reason: "stopped" };
}

function speakMelo(text, p) {
  if (!meloAvailable()) return false;
  const speaker = p.meloSpeaker || "EN-AU";
  const speed = String(p.meloSpeed ?? 1.05);
  const env = {
    ...process.env,
    GOTCHIBOT_MELO_SPEAKER: speaker,
    GOTCHIBOT_MELO_SPEED: speed,
  };
  return (
    spawnSync("bash", [MELO_TTS, text, "--speaker", speaker, "--speed", speed], {
      env,
      stdio: "ignore",
      timeout: 120_000,
    }).status === 0
  );
}

export function speak(text, { persona = "gotchi", force = false } = {}) {
  const phrase = String(text || "").trim();
  if (!phrase) return { ok: false, reason: "empty" };
  if (!force && !enabled()) return { ok: false, reason: "disabled" };

  const p = personaConfig(persona);
  const provider = p.provider || "say";

  if (provider === "melo") {
    if (meloAvailable() && speakMelo(phrase, p)) return { ok: true, provider: "melo", persona };
    const edgeVoice = p.edgeVoice || "en-AU-NatashaNeural";
    if (hasCmd("edge-tts") && speakEdge(phrase, { ...p, voice: edgeVoice })) {
      return { ok: true, provider: "edge-tts", persona, voice: edgeVoice };
    }
    const sayVoice = p.sayVoice || "Karen";
    if (speakSay(phrase, { ...p, sayVoice })) {
      return { ok: true, provider: "say", persona, voice: sayVoice };
    }
    return { ok: false, reason: "melo-failed" };
  }
  if (provider === "edge-tts" && hasCmd("edge-tts")) {
    if (speakEdge(phrase, p)) return { ok: true, provider: "edge-tts", persona };
  }
  if (speakSay(phrase, p)) return { ok: true, provider: "say", persona };

  return { ok: false, reason: "playback-failed" };
}

function cmdStatus() {
  const state = loadState();
  const cfg = loadConfig();
  const p = personaConfig(state.persona);
  const edge = hasCmd("edge-tts");
  const melo = meloAvailable();
  let active = "say";
  if (p.provider === "melo" && melo) active = "melo";
  else if (p.provider === "edge-tts" && edge) active = "edge-tts";
  console.log(
    JSON.stringify(
      {
        enabled: enabled(),
        persona: state.persona,
        provider: active,
        configuredProvider: p.provider,
        voice: p.voice,
        meloSpeaker: p.meloSpeaker,
        meloInstalled: melo,
        meloDaemon: meloDaemonRunning(),
        edgeTtsInstalled: edge,
        config: CONFIG,
        stateFile: STATE,
      },
      null,
      2,
    ),
  );
}

function cmdOn(argv) {
  const state = loadState();
  state.enabled = true;
  state.persona = personaName(argv);
  saveState(state);
  const p = personaConfig(state.persona);
  if (p.provider === "melo") warmMelo();
  console.log(`tts on (persona=${state.persona})`);
}

function cmdOff() {
  const state = loadState();
  state.enabled = false;
  saveState(state);
  stopMelo();
  console.log("tts off");
}

function cmdTest(argv) {
  const name = personaName(argv);
  const r = speak(`GotchiBot online. Persona ${name}.`, { persona: name, force: true });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}

function cmdSpeak(argv) {
  let name = loadState().persona || "gotchi";
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--persona" && argv[i + 1]) {
      name = argv[++i];
      continue;
    }
    if (argv[i].startsWith("--")) continue;
    parts.push(argv[i]);
  }
  const text = parts.join(" ").trim();
  if (!text) {
    console.error('usage: tts.mjs speak "phrase" [--persona gotchi] [--force]');
    process.exit(2);
  }
  const r = speak(text, { persona: name, force: argv.includes("--force") });
  if (!r.ok && r.reason !== "disabled") process.exit(1);
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);
switch (cmd) {
  case "speak":
    cmdSpeak(rest);
    break;
  case "on":
    cmdOn(rest);
    break;
  case "off":
    cmdOff();
    break;
  case "status":
    cmdStatus();
    break;
  case "test":
    cmdTest(rest);
    break;
  case "warm": {
    const r = warmMelo();
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
    break;
  }
  case "stop-daemon":
    console.log(JSON.stringify(stopMelo(), null, 2));
    break;
  default:
    console.error(`usage: node scripts/tts.mjs speak|on|off|status|test|warm|stop-daemon`);
    process.exit(2);
}
