#!/usr/bin/env node
/** Print a reviewable service definition; never installs or starts services. */
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { renderPlist } from './lib/launchd-job.mjs';
import { isMainModule } from './is-main.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function recoveryServicePlan({ platform = process.platform, root = ROOT, node = process.execPath, user = userInfo().username } = {}) {
  if (platform === 'darwin') return renderPlist({ label: 'com.gotchibot.recovery', program: node, args: [join(root, 'scripts/hub-desk-recovery.mjs'), 'once'], cwd: root, intervalSec: 30, runAtLoad: true, logDir: join(root, 'sessions/recovery') });
  if (platform === 'linux') return readFileSync(join(ROOT, 'services/recovery/gotchibot-recovery.service'), 'utf8').replace(/@(USER|REPO|NODE|PATH)@/g, (_, key) => ({ USER: user, REPO: root, NODE: node, PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin` })[key]);
  throw new Error('Recovery supervision supports macOS launchd and Linux systemd');
}
if (isMainModule(import.meta.url)) process.stdout.write(recoveryServicePlan());
