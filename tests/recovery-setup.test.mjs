import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSetup, recoverySshPolicy, recoverySudoers, sshFailure } from '../scripts/recovery-setup.mjs';

function fixture(answers) {
  const lines = [], calls = [], configs = [];
  const deps = {
    root: '/repo', home: '/home/tester', platform: 'darwin',
    ask: async prompt => { lines.push(prompt); assert.ok(answers.length, `Unexpected prompt: ${prompt}`); return answers.shift(); },
    say: line => lines.push(line),
    readFile: path => path.endsWith('/.hub.json') ? { tailscaleHost: 'hub.tail.ts.net', deskToken: 'never-print-this', deskId: 'desk-1' } : path.endsWith('/.hub-desk.json') ? { ssh: 'tester@hub.tail.ts.net' } : null,
    status: () => ({ json: { BackendState: 'Running' } }),
    probeSsh: async () => ({ ok: true }),
    run: (bin, args) => { calls.push([bin, ...args]); return true; },
    save: config => configs.push(config),
    install: async () => calls.push(['install']),
    configureSystemRepairs: async () => { calls.push(['permissions']); return true; },
  };
  return { deps, lines, calls, configs, answers };
}

test('wizard checks SSH, saves selected mode, installs only after confirmation, retries failed health', async () => {
  const f = fixture(['2', '1', '', '1', 'y', '', 'y', 'y', '']);
  let attempts = 0;
  f.deps.run = (bin, args) => { f.calls.push([bin, ...args]); return ++attempts > 1; };
  assert.equal(await runSetup(f.deps), 0);
  assert.equal(attempts, 2);
  assert.equal(f.configs[0].sshApprovalMode, 'unattended');
  assert.equal(f.calls[0][0], 'install');
  assert.match(f.lines.join('\n'), /Recovery has not passed/);
  assert.match(f.lines.at(-1), /not reboot-tested/);
  assert.doesNotMatch(f.lines.join('\n'), /never-print-this/);
  assert.equal(f.answers.length, 0);
});

test('browser approval from another device offers retry without declaring unattended recovery', async () => {
  const f = fixture(['2', '1', '', '2', '', '', '', 'y', 'y']);
  let probes = 0;
  f.deps.probeSsh = async () => ++probes === 1 ? { ok: false, reason: 'approval' } : { ok: true };
  assert.equal(await runSetup(f.deps), 0);
  assert.equal(probes, 2);
  assert.equal(f.configs[0].sshApprovalMode, 'interactive');
  assert.match(f.lines.join('\n'), /open its approval link on any device/);
  assert.match(f.lines.join('\n'), /still required when SSH check mode expires/);
});

test('cancelling at SSH leaves configuration and services untouched', async () => {
  const f = fixture(['2', '1', '', '1', 'q']);
  await assert.rejects(runSetup(f.deps), { code: 'CANCELLED' });
  assert.equal(f.configs.length, 0);
  assert.equal(f.calls.length, 0);
});

test('Linux hub wizard configures known user services, boot, linger and scoped permissions', async () => {
  const f = fixture(['1', '1', 'tester', '1', 'y', '', '', 'bridge.service', 'y', 'y', 'y']);
  f.deps.platform = 'linux';
  f.deps.readFile = path => path.endsWith('/.hub-api.json') ? { tailscaleHost: 'hub.tail.ts.net' } : null;
  assert.equal(await runSetup(f.deps), 0);
  assert.ok(f.calls.some(c => c.includes('enable-linger')));
  assert.ok(f.calls.some(c => c.includes('tailscaled') && c.includes('sshd')));
  assert.ok(f.calls.some(c => c[0] === 'permissions'));
  assert.equal(f.configs[0].repairServices.bridge.unit, 'bridge.service');
});

test('SSH guidance keeps a single non-root account and never relays auth URLs or broad sudo', () => {
  assert.deepEqual(recoverySshPolicy('tester').ssh[0].users, ['tester']);
  assert.throws(() => recoverySshPolicy('root'));
  assert.throws(() => recoverySshPolicy('u;cmd'));
  assert.equal(sshFailure('Tailscale SSH requires an additional check. To authenticate, visit: https://example.invalid/private'), 'approval');
  assert.equal(sshFailure('Host key verification failed'), 'host-key');
  assert.equal(sshFailure('Permission denied'), 'credentials');
  assert.equal(recoverySudoers('tester', 'hub'), 'tester ALL=(root) NOPASSWD: /usr/bin/systemctl start tailscaled, /usr/bin/systemctl start sshd\n');
});
