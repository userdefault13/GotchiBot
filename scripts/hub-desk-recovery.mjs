#!/usr/bin/env node
/** Bounded, secret-free hub/desk recovery; the supervisor retries exhausted cycles. */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { assertTailnetHost, assertTailnetUrl } from './tailnet-transport.mjs';
import { tailscaleBin, readTailscaleStatus } from './tailscale-cli.mjs';
import { probeBridgeHttp } from './claude-bridge-role.mjs';
import { isMainModule } from './is-main.mjs';
import { PORTS } from './lib/ports.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const lastRepairs = new Map();
const sshMasterStarted = new Map();
const REASONS = new Set(['SSH_APPROVAL_REQUIRED', 'SSH_TRUST_REQUIRED', 'SSH_AUTH_FAILED', 'TAILNET_REQUIRED', 'TAILSCALE_LOGIN_REQUIRED', 'TAILSCALE_APPROVAL_REQUIRED', 'PAIRING_INVALID']);

export function recoveryStatus(root = ROOT, role = recoverySpec(root).role, now = Date.now()) {
  const state = readJson(join(root, 'sessions/recovery', `${role}.json`));
  const fresh = state && Number.isFinite(Date.parse(state.validUntil)) && Date.parse(state.validUntil) > now;
  return { ...(state || {}), ready: state?.ready === true && Boolean(fresh), phase: !state ? 'unknown' : state.ready && !fresh ? 'stale' : state.phase };
}

/** All probes run even when one fails. Never persist arbitrary exception text or credentials. */
/**
 * `optional` checks still run and are reported (`optionalDown` on a ready state),
 * but a failure there does not hold the desk back — e.g. the Hub Claude bridge,
 * which chat does not need.
 */
export function createRecovery({ connect, sync, checks, optional = [], repair = async () => {}, publish = () => {}, wait = sleep, attempts = 4, backoffMs = 1000 }) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10 || !Number.isFinite(backoffMs) || backoffMs < 0 || backoffMs > 30000) throw new Error('Invalid retry policy');
  if (!checks || !Object.keys(checks).length) throw new Error('Recovery requires health checks');
  const optionalSet = new Set(optional);
  if (!Object.keys(checks).some(name => !optionalSet.has(name))) throw new Error('Recovery requires at least one required check');
  let inFlight;
  async function cycle() {
    let state;
    const emit = async (phase, extra = {}) => {
      state = { ready: false, phase, at: new Date().toISOString(), ...extra };
      await publish(state);
    };
    await emit('connecting'); // do not inherit persisted ready from a prior process
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let phase = 'connecting';
      try {
        await emit(phase, { attempt });
        if (await connect() !== true) throw new Error('connect');
        phase = 'syncing';
        await emit(phase, { attempt });
        if (await sync() !== true) throw new Error('sync');
        phase = 'checking';
        await emit(phase, { attempt });
        const results = {};
        for (const [name, probe] of Object.entries(checks)) {
          try { results[name] = await probe() === true; } catch { results[name] = false; }
        }
        const failed = Object.keys(results).filter(name => !results[name]);
        const requiredFailed = failed.filter(name => !optionalSet.has(name));
        if (!requiredFailed.length) {
          await emit('ready', { ready: true, attempt, checks: results, ...(failed.length ? { optionalDown: failed } : {}) });
          if (failed.length) await repair(failed);
          return state;
        }
        await emit('degraded', { attempt, failedPhase: phase, checks: results });
        await repair(Object.keys(results).filter(name => !results[name]));
      } catch (error) {
        await emit('degraded', { attempt, failedPhase: phase, ...(REASONS.has(error.code) ? { reason: error.code } : {}) });
      }
      if (attempt < attempts) await wait(Math.min(30000, backoffMs * 2 ** (attempt - 1)));
    }
    return state;
  }
  return { run() {
    if (!inFlight) inFlight = cycle().finally(() => { inFlight = null; });
    return inFlight;
  } };
}

function command(bin, args, { root = ROOT, env = process.env } = {}) {
  // ssh: 6s — with the shared master a healthy probe returns in milliseconds; a
  // pending Tailscale approval should fail fast, not stall the cycle for 15s.
  const r = spawnSync(bin, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: bin === 'ssh' ? 6000 : 15000, killSignal: 'SIGKILL', env });
  if (bin === 'ssh' && r.status !== 0) {
    const err = String(r.stderr || '');
    const code = /additional check|authenticate, visit/i.test(err) ? 'SSH_APPROVAL_REQUIRED' : /host key verification|identification has changed/i.test(err) ? 'SSH_TRUST_REQUIRED' : /permission denied/i.test(err) ? 'SSH_AUTH_FAILED' : null;
    if (code) throw Object.assign(new Error(code), { code });
  }
  return r.status === 0;
}
function tcp(host, port) {
  return new Promise(done => {
    const socket = createConnection({ host, port });
    const finish = ok => { socket.destroy(); done(ok); };
    socket.setTimeout(2500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function health(url, api = false) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!r.ok) return false;
    if (!api) return true;
    const j = await r.json();
    return j.service === 'gotchibot-api' && j.ok === true && j.db === 'ok';
  } catch { return false; }
}

export function recoverySpec(root = ROOT, env = process.env) {
  const cfg = readJson(join(root, 'config/recovery.json')) || {};
  const hub = readJson(join(root, 'sessions/.hub-api.json'));
  const role = env.GOTCHIBOT_RECOVERY_ROLE || cfg.role || (hub ? 'hub' : 'desk');
  if (!['hub', 'desk'].includes(role)) throw new Error('Recovery role must be hub or desk');
  return { ...cfg, role, attempts: cfg.attempts ?? 4, backoffMs: cfg.backoffMs ?? 1000, intervalMs: cfg.intervalMs ?? 30000 };
}

export function runtimeRecovery(spec, { root = ROOT, env = process.env, readStatus = readTailscaleStatus, runCommand = command, probeHealth = health, probeTcp = tcp, probeBridge = probeBridgeHttp, serveStatus, tailBin = tailscaleBin, request, pullProject, wait = sleep, publish, platform = process.platform, startProcess = (bin, args) => { const child = spawn(bin, args, { cwd: root, env, detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref(); } } = {}) {
  const command = (bin, args) => runCommand(bin, args, { root, env }), health = probeHealth, tcp = probeTcp;
  const hub = readJson(join(root, 'sessions/.hub-api.json')) || {};
  const pin = readJson(join(root, 'sessions/.hub.json')) || {};
  const prefs = readJson(join(root, 'sessions/.hub-desk.json')) || {};
  const onHub = spec.role === 'hub';
  let host = onHub ? hub.tailscaleHost : pin.tailscaleHost;
  let base = onHub ? `http://127.0.0.1:${hub.port || PORTS.HUB_API_DEFAULT}` : pin.deskApiBase;
  if (!host || !base || (!onHub && (!pin.deskToken || !pin.deskId))) throw new Error('Persisted hub configuration/pairing required');
  const status = () => readStatus().json;
  const hubHttp = () => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${hub.port || PORTS.HUB_API_DEFAULT}`;
  // Resolve only after tailscaled is running: short pins must survive daemon startup.
  // Recovery never opts into legacy direct routing, even if an interactive shell does.
  const transportEnv = { ...env, GOTCHIBOT_LEGACY_DIRECT_ROUTING: '0' };
  const user = spec.sshUser || prefs.ssh?.split('@')[0] || env.GOTCHIBOT_REMOTE_USER || env.REMOTE_USER;
  if (!onHub && !/^[a-zA-Z0-9._-]+$/.test(user || '')) throw new Error('Persist a hub desk SSH target or recovery sshUser');
  // One long-lived SSH master per Hub (ControlPersist 8h). Tailscale SSH "check"
  // mode only asks for a browser approval when a NEW connection is made, so
  // probes that ride the master never hit it — one approval lasts the day.
  const controlPath = spec.sshControlPath || join(homedir(), '.ssh', 'gb-%C');
  const sshOpts = () => ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', ...(spec.sshIdentityFile ? ['-i', spec.sshIdentityFile, '-o', 'IdentitiesOnly=yes'] : []), '-o', `ControlPath=${controlPath}`];
  const ensureSshMaster = () => {
    if (spec.sshMaster === false) return;
    if (command('ssh', ['-O', 'check', ...sshOpts(), `${user}@${host}`])) return;
    // A master already starting (waiting on an approval) is left alone.
    const key = `${user}@${host}`;
    if (Date.now() - (sshMasterStarted.get(key) || 0) < 5 * 60000) return;
    sshMasterStarted.set(key, Date.now());
    try { mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    startProcess('ssh', ['-M', '-N', '-o', 'ControlPersist=8h', ...sshOpts(), key]);
  };
  const ssh = (remoteCommand = 'true') => command('ssh', [...sshOpts(), '-o', 'ControlMaster=no', `${user}@${host}`, remoteCommand]);
  const repairService = name => {
    const service = spec.repairServices?.[name];
    if (!service) return false;
    const key = `${root}:${name}`;
    if (Date.now() - (lastRepairs.get(key) || 0) < 60000) return true;
    lastRepairs.set(key, Date.now());
    if (!/^[a-zA-Z0-9_.@/-]+$/.test(service.unit || '')) throw new Error('Invalid service unit');
    if (service.manager === 'systemd-user') return command('systemctl', ['--user', 'restart', service.unit]);
    if (service.manager === 'systemd') return command('sudo', ['-n', 'systemctl', 'restart', service.unit]);
    if (service.manager === 'launchd') return command('launchctl', ['kickstart', '-k', service.unit]);
    throw new Error('Invalid service manager');
  };
  const connect = async () => {
    const ts = status();
    if (ts?.BackendState !== 'Running') {
      if (['NeedsLogin', 'NoState'].includes(ts?.BackendState)) throw Object.assign(new Error('login'), { code: 'TAILSCALE_LOGIN_REQUIRED' });
      if (ts?.BackendState === 'NeedsMachineAuth') throw Object.assign(new Error('approval'), { code: 'TAILSCALE_APPROVAL_REQUIRED' });
      if (ts?.BackendState === 'Stopped') command(tailBin() || 'tailscale', ['up', '--timeout=10s']);
      else if (!ts) {
        if (spec.repairServices?.tailscale) repairService('tailscale');
        else if (platform === 'darwin') command('open', ['-a', 'Tailscale']);
        else command('sudo', ['-n', 'systemctl', 'start', 'tailscaled']);
      }
      return false; // next bounded attempt verifies; never tries login or changes credentials
    }
    host = assertTailnetHost(host, { env: transportEnv, status: ts });
    base = assertTailnetUrl(base, { env: transportEnv, local: onHub, status: ts });
    if (onHub) {
      if (!await tcp('127.0.0.1', 22) || !await tcp(host, 22)) {
        if (spec.repairServices?.ssh) repairService('ssh');
        else if (platform === 'darwin') command('sudo', ['-n', 'launchctl', 'kickstart', 'system/com.openssh.sshd']);
        else command('sudo', ['-n', 'systemctl', 'start', spec.sshService || 'sshd']);
        return false;
      }
      if (!await health(base + '/health', true)) {
        if (!repairService('apiDatabase')) {
          if (platform === 'linux') command('systemctl', ['--user', 'restart', 'gotchibot-api.service']);
          else command('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.gotchibot.hub-api`]);
        }
        return false;
      }
      if (!await health(hubHttp() + '/health', true)) {
        // Reapplying our Serve mapping is allowed only when no mapping owns this port.
        const r = serveStatus ? serveStatus() : spawnSync(tailBin() || 'tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 10000 });
        let serve;
        try { serve = JSON.parse(r.stdout); } catch { return false; }
        const port = hub.port || PORTS.HUB_API_DEFAULT;
        const occupied = Object.keys(serve.Web || {}).some(key => key.endsWith(`:${port}`)) || Object.hasOwn(serve.TCP || {}, String(port));
        if (!occupied && r.status === 0) command(tailBin() || 'tailscale', ['serve', '--bg', `--http=${port}`, `http://127.0.0.1:${port}`]);
      }
      return await health(base + '/health', true) && await health(hubHttp() + '/health', true);
    }
    // Desk: Tailscale + the Hub API is "connected". SSH only reaches Hub-local
    // runtimes for health checks; it never gated chat and must not gate this.
    return await health(base + '/health', true);
  };
  const sync = async () => {
    if (onHub) return true; // desks reauthenticate and pull persisted Hub state; no reverse desk token store
    const rawRequest = request || (await import('./chat-hub-client.mjs')).hubRequest;
    const syncEnv = { ...env, GOTCHIBOT_HUB_PIN: join(root, 'sessions/.hub.json'), GOTCHIBOT_DESK_API_BASE: base, GOTCHIBOT_LEGACY_DIRECT_ROUTING: '0' };
    const hubRequest = (method, path, opts = {}) => rawRequest(method, path, { ...opts, env: syncEnv });
    let who;
    try { who = await hubRequest('GET', '/api/gotchibot/hub/whoami', { env, signal: AbortSignal.timeout(4000) }); }
    catch (error) { if (error.status === 401 || error.status === 403) throw Object.assign(new Error('pairing'), { code: 'PAIRING_INVALID' }); throw error; }
    if (who.deskId !== pin.deskId) throw Object.assign(new Error('pairing'), { code: 'PAIRING_INVALID' });
    let after;
    for (let page = 0; ; page++) {
      if (page >= 100) return false;
      const threads = await hubRequest('GET', '/api/gotchibot/chats/threads', { query: { limit: 500, paginate: 1, after }, signal: AbortSignal.timeout(4000) });
      if (!Array.isArray(threads.threads)) return false;
      for (const thread of threads.threads) {
        const id = thread.threadId || thread.id;
        // chat-sync uses the ID in a filename. Reject paths and option-like IDs.
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(id || '') || !runCommand(process.execPath, ['scripts/chat-sync.mjs', 'pull', '--thread', id, '--max-pages', '1', '--json'], { root, env: syncEnv })) return false;
      }
      if (threads.hasMore === false || (threads.hasMore == null && threads.threads.length < 500)) break;
      if (!threads.nextAfter || threads.nextAfter === after) return false;
      after = threads.nextAfter;
    }
    const pullOpenProject = pullProject || (await import('./hub-project-sync.mjs')).pullOpenProject;
    const result = await pullOpenProject({ root, env: syncEnv, hubRequest });
    return result.ok || result.skipped === 'no-project';
  };
  const runtime = spec.runtime || 'opencode';
  if (!['opencode', 'openclaw'].includes(runtime)) throw new Error('Invalid runtime');
  const urls = {
    ...(runtime === 'openclaw' ? { gateway: 'http://127.0.0.1:18789/healthz' } : { opencode: 'http://127.0.0.1:4096/global/health' }),
    bridge: 'http://127.0.0.1:45678/prompt',
    ...(!onHub ? { receiver: 'http://127.0.0.1:45679/health', wisp: 'http://127.0.0.1:45682/health' } : {}),
    ...(spec.healthUrls || {}),
  };
  const checks = {
    tailscale: async () => status()?.BackendState === 'Running',
    ssh: onHub ? async () => await tcp('127.0.0.1', 22) && await tcp(host, 22) : async () => { ensureSshMaster(); return ssh(); },
    apiDatabase: () => health(base + '/health', true),
    ...(onHub ? { tailnetApi: () => health(hubHttp() + '/health', true) } : {}),
  };
  for (const [name, url] of Object.entries(urls)) {
    if (Object.hasOwn(checks, name)) throw new Error('Health name is reserved');
    checks[name] = async () => {
      const target = assertTailnetUrl(url, { env: transportEnv, local: true, status: status() });
      // Hub runtimes bind loopback. Probe them through the authenticated SSH connection.
      if (!onHub && ['opencode', 'gateway', 'bridge'].includes(name)) {
        const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
        const script = `fetch(${JSON.stringify(target)}, {${name === 'bridge' ? 'method:"POST",headers:{"Content-Type":"application/json"},body:"{}",' : ''}redirect:"error",signal:AbortSignal.timeout(4000)}).then(r=>process.exit(${name === 'bridge' ? '[200,202,400].includes(r.status)' : 'r.ok'}?0:1)).catch(()=>process.exit(1))`;
        return ssh(`${quote(spec.remoteNode || 'node')} -e ${quote(script)}`);
      }
      return name === 'bridge' ? probeBridge(target) : health(target);
    };
  }
  const repair = async failed => {
    for (const name of failed) {
      // A desk never restarts a Hub service. The Hub's local supervisor owns it.
      if (!onHub && ['opencode', 'gateway', 'bridge', 'apiDatabase', 'ssh', 'tailscale'].includes(name)) continue;
      if (spec.repairServices?.[name]) { repairService(name); continue; }
      if (onHub && name === 'opencode' && platform === 'linux') command('systemctl', ['--user', 'restart', 'gotchibot-opencode.service']);
      if (!onHub && name === 'receiver') command(process.execPath, ['scripts/desk-receiver-ensure.mjs']);
      if (!onHub && name === 'wisp') startProcess(process.execPath, ['scripts/wisp-proxy.mjs']);
    }
  };
  const dir = join(root, 'sessions/recovery');
  mkdirSync(dir, { recursive: true });
  // The Hub Claude bridge is optional by default: desk chat (OpenCode) works without it.
  // Optional by default: the Hub Claude bridge, and on a desk everything reached
  // over SSH (Hub-local OpenCode/gateway) — monitoring, not something the desk needs.
  const defaultOptional = onHub ? ['bridge'] : ['bridge', 'ssh', 'opencode', 'gateway'];
  const optional = (Array.isArray(spec.optionalChecks) ? spec.optionalChecks : defaultOptional).filter(name => Object.hasOwn(checks, name));
  return createRecovery({ connect, sync, checks, optional, repair, wait, attempts: spec.attempts, backoffMs: spec.backoffMs, publish: publish || function(state) {
    const path = join(dir, `${spec.role}.json`);
    writeFileSync(path + '.tmp', JSON.stringify({ ...state, validUntil: state.ready ? new Date(Date.now() + (spec.intervalMs || 30000) + 5000).toISOString() : null }) + '\n', { mode: 0o600 });
    renameSync(path + '.tmp', path);
  } });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'setup') return (await import('./recovery-setup.mjs')).main();
  if (argv[0] === 'status') {
    const state = recoveryStatus();
    console.log(JSON.stringify(state));
    return state.ready ? 0 : 1;
  }
  if (!['once', 'run'].includes(argv[0])) throw new Error('usage: hub-desk-recovery.mjs setup|once|run|status');
  const spec = recoverySpec();
  if (!Number.isFinite(spec.intervalMs) || spec.intervalMs < 1000 || spec.intervalMs > 300000) throw new Error('Invalid recovery interval');
  const dir = join(ROOT, 'sessions/recovery');
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${spec.role}.lock`);
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch {
    const pid = Number(readFileSync(lock, 'utf8'));
    const validPid = Number.isInteger(pid) && pid > 0;
    if (!validPid && Date.now() - statSync(lock).mtimeMs < 30000) return 1;
    try {
      if (!validPid) throw Object.assign(new Error('abandoned lock'), { code: 'ESRCH' });
      process.kill(pid, 0);
      if (argv[0] !== 'once') return 1;
      const started = Date.now();
      for (let i = 0; i < 120; i++) {
        const state = recoveryStatus(ROOT, spec.role);
        if (state?.ready === true && Date.parse(state.at) >= started) return 0;
        if (state.phase === 'degraded' && state.attempt >= spec.attempts && Date.parse(state.at) >= started) {
          console.log(JSON.stringify(state));
          return 1;
        }
        await sleep(1000);
      }
      return 1;
    } catch (e) { if (e.code !== 'ESRCH') return 1; }
    unlinkSync(lock);
    fd = openSync(lock, 'wx', 0o600);
  }
  writeFileSync(fd, String(process.pid));
  const release = () => { try { closeSync(fd); unlinkSync(lock); } catch {} };
  process.once('exit', release);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(0));
  try {
    do {
      // Reload pins/config each cycle so repairing pairing never needs a daemon restart.
      const recovery = runtimeRecovery(recoverySpec());
      const state = await recovery.run();
      console.log(JSON.stringify(state));
      if (argv[0] === 'once') return state.ready ? 0 : 1;
      await sleep(spec.intervalMs);
    } while (true);
  } finally { release(); process.removeListener('exit', release); }
}
if (isMainModule(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => {
  console.error('Recovery failed; inspect configuration, pairing, permissions and required health checks.');
  process.exitCode = 1;
});
