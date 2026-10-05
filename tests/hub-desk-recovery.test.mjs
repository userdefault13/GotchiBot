import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecovery, runtimeRecovery, recoveryStatus } from '../scripts/hub-desk-recovery.mjs';
import { assertTailnetHost, assertTailnetUrl } from '../scripts/tailnet-transport.mjs';
import { recoveryServicePlan } from '../scripts/recovery-service-plan.mjs';

const running = { BackendState: 'Running', Peer: { hub: { DNSName: 'hub.tail.ts.net.', TailscaleIPs: ['100.64.0.2'] } } };
function fixture(t, role = 'desk') {
  const root = mkdtempSync(join(tmpdir(), 'gotchi-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sessions'));
  writeFileSync(join(root, 'sessions/.hub.json'), JSON.stringify({ tailscaleHost: 'hub.tail.ts.net', deskApiBase: 'http://hub.tail.ts.net:8793', deskId: 'desk-1', deskToken: 'test-only' }));
  if (role === 'hub') writeFileSync(join(root, 'sessions/.hub-api.json'), JSON.stringify({ tailscaleHost: 'hub.tail.ts.net', port: 8793 }));
  const events = [], states = [];
  const deps = { root, env: {}, readStatus: () => ({ json: running }), tailBin: () => 'tailscale',
    runCommand: (bin, args) => { events.push([bin, ...args]); return true; },
    probeTcp: async () => true, probeHealth: async url => { events.push(['health', url]); return true; },
    probeBridge: () => true, request: async (_, path) => { events.push(['request', path]); return path.endsWith('whoami') ? { deskId: 'desk-1' } : { threads: [{ threadId: 'orch' }] }; },
    pullProject: async () => { events.push(['project']); return { ok: true }; }, wait: async ms => events.push(['backoff', ms]), publish: state => states.push(state),
    startProcess: (bin, args) => events.push(['start', bin, ...args]) };
  return { root, deps, events, states, spec: { role, sshUser: 'tester', attempts: 3, backoffMs: 10 } };
}

test('desk restart uses persisted pairing: API then auth/chat/project sync then ALL health (SSH only in checks)', async t => {
  const f = fixture(t);
  const state = await runtimeRecovery(f.spec, f.deps).run();
  assert.equal(state.ready, true);
  assert.deepEqual(f.states.map(s => s.phase), ['connecting', 'connecting', 'syncing', 'checking', 'ready']);
  assert.equal(f.events[0][0], 'health', 'connecting is the Hub API, not SSH');
  assert.ok(f.events.findIndex(e => e[0] === 'ssh') > f.events.findIndex(e => e[0] === 'request'));
  assert.ok(f.events.findIndex(e => e[0] === 'project') < f.events.findIndex(e => e.at(-1)?.includes('4096')));
  assert.ok(f.events.some(e => e[0] === 'ssh' && e.at(-1).includes('127.0.0.1:4096')));
  assert.ok(f.events.some(e => e.includes('--thread') && e.includes('orch')));
  assert.deepEqual(Object.keys(state.checks), ['tailscale', 'ssh', 'apiDatabase', 'opencode', 'bridge', 'receiver', 'wisp']);
});

test('disconnect never syncs or becomes ready; reconnect repeats ordered sync and checks', async t => {
  const f = fixture(t); let connected = false;
  f.deps.probeHealth = async url => { f.events.push(['health', url]); return connected; };
  const recovery = runtimeRecovery(f.spec, f.deps);
  assert.equal((await recovery.run()).ready, false);
  assert.equal(f.events.some(e => e[0] === 'request'), false);
  assert.deepEqual(f.events.filter(e => e[0] === 'backoff').map(e => e[1]), [10, 20]);
  connected = true;
  assert.equal((await recovery.run()).ready, true);
  connected = false;
  assert.equal((await recovery.run()).ready, false);
  assert.equal(f.states.at(-1).failedPhase, 'connecting');
});

test('revoked/mismatched pairing stops before chat/project sync', async t => {
  const f = fixture(t);
  f.deps.request = async () => ({ deskId: 'other' });
  assert.equal((await runtimeRecovery(f.spec, f.deps).run()).ready, false);
  assert.equal(f.events.some(e => e.includes('--thread') || e[0] === 'project'), false);
});

test('sync failure and each health failure prevent ready; later probes still execute', async t => {
  const f = fixture(t);
  f.deps.pullProject = async () => ({ ok: false });
  assert.equal((await runtimeRecovery(f.spec, f.deps).run()).failedPhase, 'syncing');
  for (const failed of ['tailscale', 'ssh', 'apiDatabase', 'gateway', 'opencode', 'bridge', 'receiver', 'wisp']) {
    const seen = [];
    const checks = Object.fromEntries(['tailscale', 'ssh', 'apiDatabase', 'gateway', 'opencode', 'bridge', 'receiver', 'wisp'].map(name => [name, async () => { seen.push(name); if (name === failed) throw new Error('sensitive details'); return true; }]));
    const state = await createRecovery({ connect: async () => true, sync: async () => true, checks, attempts: 1 }).run();
    assert.equal(state.ready, false);
    assert.equal(seen.length, 8);
    assert.equal(JSON.stringify(state).includes('sensitive'), false);
  }
});

test('hub boot resumes stopped Tailscale and missing SSH before checking Serve/API; repeated healthy cycles do not restart services', async t => {
  const f = fixture(t, 'hub'); let ts = false, ssh = false;
  f.deps.readStatus = () => ({ json: ts ? running : { BackendState: 'Stopped' } });
  f.deps.probeTcp = async () => ssh;
  f.deps.runCommand = (bin, args) => { f.events.push([bin, ...args]); if (args[0] === 'up') ts = true; if (bin === 'sudo') ssh = true; return true; };
  const recovery = runtimeRecovery(f.spec, f.deps);
  assert.equal((await recovery.run()).ready, true);
  assert.equal(f.events.filter(e => e[0] === 'sudo').length, 1);
  assert.equal(f.events.filter(e => e[1] === 'up').length, 1);
  await recovery.run();
  assert.equal(f.events.filter(e => e[0] === 'sudo').length, 1);
});

test('hub restores absent Serve mapping, refuses occupied mapping and malformed status', async t => {
  for (const occupied of [false, true, 'malformed']) {
    const f = fixture(t, 'hub'); let served = false;
    f.deps.probeHealth = async url => url.includes('127.0.0.1') || served;
    f.deps.serveStatus = () => ({ status: 0, stdout: occupied === 'malformed' ? 'bad' : JSON.stringify({ Web: occupied ? { 'hub.tail.ts.net:8793': {} } : {} }) });
    f.deps.runCommand = (bin, args) => { f.events.push([bin, ...args]); if (args.includes('--bg')) served = true; return true; };
    const state = await runtimeRecovery(f.spec, f.deps).run();
    assert.equal(state.ready, occupied === false);
    assert.equal(f.events.some(e => e.includes('--bg')), occupied === false);
  }
});

test('overlapping recovery calls share one cycle; new process never trusts old ready', async () => {
  let resolveConnect; let calls = 0;
  const states = [];
  const recovery = createRecovery({ connect: () => { calls++; return new Promise(r => { resolveConnect = r; }); }, sync: async () => true, checks: { check: async () => true }, publish: s => states.push(s) });
  const a = recovery.run(), b = recovery.run();
  assert.equal(a, b);
  await new Promise(r => setImmediate(r));
  resolveConnect(true); await a;
  assert.equal(calls, 1);
  const fresh = createRecovery({ connect: async () => false, sync: async () => true, checks: { check: async () => true }, attempts: 1, publish: s => states.push(s) });
  assert.equal((await fresh.run()).ready, false);
  assert.equal(states.at(-1).phase, 'degraded');
});

test('tailnet transport canonicalizes listed short names and denies LAN/public/direct by default', () => {
  for (const host of ['192.168.1.2', '10.0.0.2', '172.16.1.2', '8.8.8.8', 'hub.local', 'hub', 'example.com', '100.128.0.1']) assert.throws(() => assertTailnetHost(host, { env: {} }), /Tailscale/);
  assert.equal(assertTailnetHost('hub', { env: {}, status: running }), 'hub.tail.ts.net');
  assert.equal(assertTailnetUrl('http://hub:8793', { env: {}, status: running }), 'http://hub.tail.ts.net:8793');
  for (const host of ['100.64.0.1', '100.127.255.255', 'fd7a:115c:a1e0::1', 'hub.tail.ts.net']) assert.equal(assertTailnetHost(host, { env: {} }), host);
  assert.equal(assertTailnetHost('192.168.1.2', { env: { GOTCHIBOT_LEGACY_DIRECT_ROUTING: '1' } }), '192.168.1.2');
  assert.equal(assertTailnetUrl('http://127.0.0.1:8793', { env: {}, local: true }), 'http://127.0.0.1:8793');
  assert.throws(() => assertTailnetUrl('http://name:password@hub.tail.ts.net'), /Invalid/);
});

test('startup service plans are boot/login scheduled, restart supervised, and contain no install side effects', () => {
  const linux = recoveryServicePlan({ platform: 'linux', root: '/repo', node: '/bin/node', user: 'tester' });
  assert.doesNotMatch(linux, /^User=/m);
  assert.match(linux, /Restart=always/);
  assert.match(linux, /WantedBy=default.target/);
  const mac = recoveryServicePlan({ platform: 'darwin', root: '/repo', node: '/bin/node' });
  assert.match(mac, /RunAtLoad<\/key><true\/>/);
  assert.match(mac, /StartInterval<\/key><integer>30/);
  assert.match(mac, /hub-desk-recovery.mjs/);
  assert.match(readFileSync(new URL('../scripts/chat-pane.sh', import.meta.url), 'utf8'), /hub-desk-recovery.mjs" run/);
});

test('a failed service is repaired then rechecked before readiness', async () => {
  let healthy = false; const states = [], repaired = [];
  const r = createRecovery({ connect: async () => true, sync: async () => true,
    checks: { runtime: async () => healthy }, repair: async names => { repaired.push(names); healthy = true; },
    wait: async () => {}, publish: state => states.push(state), attempts: 2 });
  assert.equal((await r.run()).ready, true);
  assert.deepEqual(repaired, [['runtime']]);
  assert.equal(states.find(s => s.phase === 'degraded').ready, false);
  assert.equal(states.at(-1).attempt, 2);
});

test('short persisted host survives a stopped Tailscale daemon and resolves after startup', async t => {
  const f = fixture(t); let up = false;
  writeFileSync(join(f.root, 'sessions/.hub.json'), JSON.stringify({ tailscaleHost: 'hub', deskApiBase: 'http://hub:8793', deskId: 'desk-1', deskToken: 'test' }));
  f.deps.readStatus = () => ({ json: up ? running : { BackendState: 'Stopped' } });
  f.deps.runCommand = (bin, args) => { f.events.push([bin, ...args]); if (args[0] === 'up') up = true; return true; };
  assert.equal((await runtimeRecovery(f.spec, f.deps).run()).ready, true);
  assert.ok(f.events.some(e => e[0] === 'ssh' && e.includes('tester@hub.tail.ts.net')));
});

test('recovery refuses LAN even when legacy interactive routing is enabled', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'sessions/.hub.json'), JSON.stringify({ tailscaleHost: '192.168.1.2', deskApiBase: 'http://192.168.1.2:8793', deskId: 'desk-1', deskToken: 'test' }));
  f.deps.env.GOTCHIBOT_LEGACY_DIRECT_ROUTING = '1';
  assert.equal((await runtimeRecovery(f.spec, f.deps).run()).ready, false);
  assert.equal(f.events.some(e => e[0] === 'ssh'), false);
});

test('paginated chat inventory syncs every page and rejects stalled cursors', async t => {
  const f = fixture(t); const cursors = [];
  f.deps.request = async (_, path, opts) => {
    if (path.endsWith('whoami')) return { deskId: 'desk-1' };
    cursors.push(opts.query.after);
    return opts.query.after ? { threads: [{ threadId: 'z' }], hasMore: false } : { threads: [{ threadId: 'a' }], hasMore: true, nextAfter: 'a' };
  };
  assert.equal((await runtimeRecovery(f.spec, f.deps).run()).ready, true);
  assert.deepEqual(cursors, [undefined, 'a']);
  assert.ok(f.events.some(e => e.includes('--thread') && e.includes('z')));
  f.deps.request = async (_, path) => path.endsWith('whoami') ? { deskId: 'desk-1' } : { threads: [], hasMore: true, nextAfter: 'same' };
  assert.equal((await runtimeRecovery(f.spec, f.deps).run()).ready, false);
});

test('expired saved readiness never reports a healthy desk', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'sessions/recovery'));
  const path = join(f.root, 'sessions/recovery/desk.json');
  writeFileSync(path, JSON.stringify({ ready: true, phase: 'ready', validUntil: new Date(2000).toISOString() }));
  assert.equal(recoveryStatus(f.root, 'desk', 1000).ready, true);
  assert.equal(recoveryStatus(f.root, 'desk', 2000).ready, false);
  assert.equal(recoveryStatus(f.root, 'desk', 2000).phase, 'stale');
});

test('optional checks are reported but do not hold the desk back', async () => {
  const repaired = [];
  const checks = { opencode: async () => true, bridge: async () => false };
  const ok = await createRecovery({ connect: async () => true, sync: async () => true, checks, optional: ['bridge'], attempts: 1, repair: async f => repaired.push(...f) }).run();
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.optionalDown, ['bridge']);
  assert.deepEqual(repaired, ['bridge']);
  const down = await createRecovery({ connect: async () => true, sync: async () => true, checks: { opencode: async () => false, bridge: async () => true }, optional: ['bridge'], attempts: 1 }).run();
  assert.equal(down.ready, false, 'a required check still blocks');
  assert.throws(() => createRecovery({ connect: async () => true, sync: async () => true, checks: { bridge: async () => true }, optional: ['bridge'] }), /at least one required check/);
});

test('a desk with SSH down (e.g. Tailscale approval pending) is still ready; SSH rides one master', async t => {
  const f = fixture(t);
  f.deps.runCommand = (bin, args) => { f.events.push([bin, ...args]); return bin !== 'ssh'; };
  const state = await runtimeRecovery(f.spec, f.deps).run();
  assert.equal(state.ready, true);
  assert.deepEqual(state.optionalDown.sort(), ['bridge', 'opencode', 'ssh'], 'everything reached over SSH is optional on a desk');
  const probes = f.events.filter(e => e[0] === 'ssh' && !e.includes('-O'));
  assert.ok(probes.length && probes.every(e => e.includes('ControlMaster=no')), 'probes reuse the master');
  assert.ok(f.events.some(e => e[0] === 'start' && e[1] === 'ssh' && e.includes('-M') && e.includes('ControlPersist=8h')), 'starts one master');
  const masters = f.events.filter(e => e[0] === 'start').length;
  await runtimeRecovery(f.spec, f.deps).run();
  assert.equal(f.events.filter(e => e[0] === 'start').length, masters, 'a master already starting is not restarted');
});

test('chat-pane never waits on recovery before starting chat', () => {
  const chat = readFileSync(new URL('../scripts/chat-pane.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(chat, /hub-desk-recovery\.mjs" once/);
  assert.match(chat, /nohup node "\$ROOT\/scripts\/hub-desk-recovery\.mjs" run/);
});
