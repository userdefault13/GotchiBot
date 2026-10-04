#!/usr/bin/env node
/** Interactive recovery setup. No daemon, credentials, or remote policy is changed on import. */
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readTailscaleStatus, tailscaleBin } from './tailscale-cli.mjs';
import { assertTailnetHost } from './tailnet-transport.mjs';
import { recoveryServicePlan } from './recovery-service-plan.mjs';
import { isMainModule } from './is-main.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const cancelled = () => Object.assign(new Error('Setup paused. Run gotchibot recovery setup to resume.'), { code: 'CANCELLED' });

/** Example fragment to merge with existing policy, never replace the whole policy. */
export function recoverySshPolicy(user) {
  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(user) || user === 'root') throw new Error('Choose one non-root Hub account');
  return {
    grants: [{ src: ['tag:gotchibot-recovery'], dst: ['tag:gotchibot-hub'], ip: ['tcp:22'] }],
    ssh: [{ action: 'accept', src: ['tag:gotchibot-recovery'], dst: ['tag:gotchibot-hub'], users: [user] }],
  };
}

export function sshFailure(stderr = '') {
  const s = String(stderr);
  if (/additional check|authenticate, visit|check mode/i.test(s)) return 'approval';
  if (/host key verification|identification has changed/i.test(s)) return 'host-key';
  if (/permission denied/i.test(s)) return 'credentials';
  return 'unreachable';
}

export function recoverySudoers(user, role) {
  recoverySshPolicy(user);
  return `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl start tailscaled${role === 'hub' ? ', /usr/bin/systemctl start sshd' : ''}\n`;
}

export async function runSetup({ ask, say = console.log, root = ROOT, home = homedir(), platform = process.platform,
  status = readTailscaleStatus, readFile = read,
  run = (bin, args) => spawnSync(bin, args, { cwd: root, stdio: 'inherit' }).status === 0,
  probeSsh = (target, config) => {
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', ...(config.sshIdentityFile ? ['-i', config.sshIdentityFile, '-o', 'IdentitiesOnly=yes'] : []), target, 'true'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    return { ok: r.status === 0, reason: sshFailure(r.stderr) };
  },
  save = (config) => {
    mkdirSync(join(root, 'config'), { recursive: true });
    const path = join(root, 'config/recovery.json');
    writeFileSync(path + '.tmp', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    renameSync(path + '.tmp', path);
  },
  configureSystemRepairs = async (role, run) => {
    const user = userInfo().username;
    const dir = join(root, 'sessions/recovery');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'sudoers.pending');
    writeFileSync(path, recoverySudoers(user, role), { mode: 0o600 });
    if (!run('sudo', ['visudo', '-cf', path]) || !run('sudo', ['install', '-m', '0440', '-o', 'root', '-g', 'root', path, '/etc/sudoers.d/gotchibot-recovery'])) return false;
    return run('sudo', [tailscaleBin() || 'tailscale', 'set', `--operator=${user}`]);
  },
  install,
} = {}) {
  const question = async text => { const answer = String(await ask(text)).trim(); if (/^q$/i.test(answer)) throw cancelled(); return answer; };
  const confirm = async text => /^(y|yes)$/i.test(await question(text + ' [y/N, q to pause]: '));
  const choose = async (text, allowed, fallback) => {
    for (;;) { const a = (await question(text)) || fallback; if (allowed.includes(a)) return a; say('Choose one of the displayed options.'); }
  };
  say('UserDefault — recovery setup. Run this on the Hub, then on each paired desk. Type q at any prompt to pause.');
  say('\n[1/6] This machine and pairing');
  let hub = readFile(join(root, 'sessions/.hub-api.json'));
  let pin = readFile(join(root, 'sessions/.hub.json'));
  const existing = readFile(join(root, 'config/recovery.json')) || {};
  const role = await choose('1 Hub · 2 Desk [' + (hub ? '1' : '2') + ']: ', ['1', '2'], hub ? '1' : '2') === '1' ? 'hub' : 'desk';
  while (role === 'hub' ? !hub : !pin?.deskToken || !pin?.deskId) {
    say(role === 'hub' ? 'Hub installation is missing. The existing Hub wizard will configure it.' : 'This desk needs pairing. The Hub wizard will help you join using a code from your Hub.');
    if (!await confirm('Open the Hub setup wizard')) throw cancelled();
    run(process.execPath, ['scripts/hub-network.mjs', 'setup']);
    hub = readFile(join(root, 'sessions/.hub-api.json'));
    pin = readFile(join(root, 'sessions/.hub.json'));
  }
  const config = { ...existing, role, attempts: 4, backoffMs: 1000, intervalMs: 30000 };
  config.runtime = await choose('Hub runtime: 1 OpenCode · 2 OpenClaw [1]: ', ['1', '2'], existing.runtime === 'openclaw' ? '2' : '1') === '1' ? 'opencode' : 'openclaw';
  say('\n[2/6] Tailscale');
  while (status().json?.BackendState !== 'Running') {
    say('Tailscale is not connected. Complete installation/login or device approval in the network wizard.');
    if (!await confirm('Open the network wizard')) throw cancelled();
    run(process.execPath, ['scripts/hub-network.mjs', 'setup']);
  }
  const host = assertTailnetHost(role === 'hub' ? hub.tailscaleHost : pin.tailscaleHost, { env: {}, status: status().json });
  say(`Tailscale connected. Hub: ${host}`);
  say('\n[3/6] SSH and approval policy');
  const prefs = readFile(join(root, 'sessions/.hub-desk.json'));
  const suggested = existing.sshUser || prefs?.ssh?.split('@')[0] || (role === 'hub' ? userInfo().username : '');
  for (;;) {
    config.sshUser = await question(`Hub non-root SSH account${suggested ? ` [${suggested}]` : ''}: `) || suggested;
    try { recoverySshPolicy(config.sshUser); break; } catch { say('Enter a valid non-root account on the Hub.'); }
  }
  const mode = await choose('1 Unattended recovery (recommended) · 2 Browser approval when required [1]: ', ['1', '2'], existing.sshApprovalMode === 'interactive' ? '2' : '1');
  config.sshApprovalMode = mode === '1' ? 'unattended' : 'interactive';
  if (mode === '1') {
    say('In https://login.tailscale.com/admin/acls, create tags with your administrator as tag owner. Apply tag:gotchibot-hub only to the Hub and tag:gotchibot-recovery only to trusted recovery desks.');
    say('Merge this fragment with your existing policy; keep the existing Hub API grants. Review other grants affected by tagging.');
    say(JSON.stringify(recoverySshPolicy(config.sshUser), null, 2));
    say('Remove overlapping check rules for this exact recovery path: check takes precedence over accept. Keep checks on other paths.');
    say('If you use native OpenSSH over Tailscale instead, configure a dedicated noninteractive key and restrict it to the recovery account.');
    if (!await confirm('Have you configured unattended access for this recovery path')) throw cancelled();
  } else {
    say('Browser approval may expire. When SSH asks, run ssh on this desk, then open its approval link on any device and sign in as the authorized user. Recovery will retry afterward.');
    await question('Press Enter after approval, or q to pause: ');
  }
  if (role === 'desk') {
    while (true) {
      const probe = await probeSsh(`${config.sshUser}@${host}`, config);
      if (probe.ok) break;
      const messages = { approval: 'SSH needs browser approval. Complete the login or adjust the scoped policy above.', 'host-key': 'Verify the Hub host key through a trusted channel, then connect manually once. Recovery keeps strict host-key checks.', credentials: 'SSH rejected the account/key. Correct the account or authorized key on the Hub.', unreachable: 'SSH is unreachable. Check Hub power, tailscaled, sshd and TCP 22 access.' };
      say(messages[probe.reason] || messages.unreachable);
      say(`Manual check in another terminal: ssh ${config.sshUser}@${host}`);
      await question('Press Enter to retry SSH, or q to pause: ');
    }
    config.remoteNode = await question(`Node executable on the Hub [${existing.remoteNode || 'node'}]: `) || existing.remoteNode || 'node';
  }
  say('\n[4/6] Recovery checks and service repairs');
  say('Each cycle connects to the Hub, validates the existing pairing, pulls chats and project state, then checks SSH, API/database, runtime, bridge and desk receiver/Wisp.');
  say('Failed checks remain degraded. Custom checks and repair units live in config/recovery.json; see docs/RECOVERY.md.');
  if (role === 'hub' && platform === 'linux') {
    config.repairServices = { ...existing.repairServices };
    for (const [name, fallback] of [['apiDatabase', 'gotchibot-api.service'], [config.runtime, config.runtime === 'opencode' ? 'gotchibot-opencode.service' : ''], ['bridge', '']]) {
      const previous = config.repairServices[name];
      const unit = await question(`Systemd user unit to repair ${name}${previous?.unit || fallback ? ` [${previous?.unit || fallback}]` : ' (blank = report failure only)'}: `) || previous?.unit || fallback;
      if (unit) {
        if (!/^[a-zA-Z0-9_.@-]+\.service$/.test(unit)) throw new Error('Invalid service unit');
        config.repairServices[name] = { manager: 'systemd-user', unit };
      }
    }
  }
  if (!await confirm('Save this recovery configuration')) throw cancelled();
  save(config);
  say('\n[5/6] Start automatically');
  if (platform === 'linux') {
    say('This enables existing Tailscale/SSH services and user lingering, then installs the recovery user unit. No software packages are installed.');
    if (!await confirm('Enable boot recovery on this machine')) throw cancelled();
    if (!run('sudo', ['systemctl', 'enable', '--now', 'tailscaled', ...(role === 'hub' ? ['sshd'] : [])])) throw new Error('Could not enable system services; fix the error above and rerun setup.');
    if (!run('sudo', ['loginctl', 'enable-linger', userInfo().username])) throw new Error('Could not enable user lingering.');
    say('Repair permission: start only tailscaled' + (role === 'hub' ? '/sshd' : '') + ' without a password, and make this account the Tailscale operator (can manage this node’s Tailscale settings).');
    if (!await confirm('Grant these local repair permissions')) throw cancelled();
    if (!await configureSystemRepairs(role, run)) throw new Error('Local repair permissions could not be configured.');
  } else if (platform === 'darwin') {
    say('The Mac desk service starts at login and runs after wake. Pre-login recovery needs a system Tailscale daemon and a reviewed LaunchDaemon deployment; FileVault unlock remains an OS prerequisite.');
    if (!await confirm('Enable recovery at Mac login')) throw cancelled();
  } else throw new Error('Recovery supervision currently supports Linux and macOS.');
  if (install) await install(config);
  else if (platform === 'linux') {
    const dir = join(home, '.config/systemd/user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gotchibot-recovery.service'), recoveryServicePlan({ platform, root }));
    if (!run('systemctl', ['--user', 'daemon-reload']) || !run('systemctl', ['--user', 'enable', '--now', 'gotchibot-recovery.service'])) throw new Error('Recovery service could not start.');
  } else {
    const { install: installLaunchd } = await import('./lib/launchd-job.mjs');
    installLaunchd({ label: 'com.gotchibot.recovery', program: process.execPath, args: [join(root, 'scripts/hub-desk-recovery.mjs'), 'once'], cwd: root, intervalSec: 30, runAtLoad: true, logDir: join(root, 'sessions/recovery') });
  }
  say('\n[6/6] Reconnect → sync → health verification');
  while (!run(process.execPath, ['scripts/hub-desk-recovery.mjs', 'once'])) {
    say('Recovery has not passed. The output above names failed checks. The supervisor will keep retrying.');
    say('Fix the named service/pairing, or review config/recovery.json repairServices. No check is silently skipped.');
    await question('Press Enter to retry all checks, or q to pause: ');
  }
  say('UserDefault, recovery is running and this cycle passed all required checks. Status: gotchibot recovery status');
  if (mode === '2') say('Browser approval is still required when SSH check mode expires.');
  say('Next validation: restart the Hub and disconnect/reconnect a desk during a maintenance window. This wizard has not reboot-tested the machines.');
  return 0;
}

export async function main() {
  if (process.argv.includes('--help')) { console.log('Usage: gotchibot recovery setup — interactive six-step recovery wizard'); return 0; }
  if (!process.stdin.isTTY) { console.error('UserDefault, open a terminal and run: gotchibot recovery setup'); return 2; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const run = (bin, args) => {
    rl.pause();
    try { return spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit' }).status === 0; }
    finally { rl.resume(); }
  };
  try { return await runSetup({ ask: text => rl.question(text), run }); }
  catch (e) { console.error(e.code === 'CANCELLED' ? e.message : 'Setup could not finish. Check the preceding step, then rerun gotchibot recovery setup.'); return 1; }
  finally { rl.close(); }
}
if (isMainModule(import.meta.url)) main().then(code => { process.exitCode = code; });
