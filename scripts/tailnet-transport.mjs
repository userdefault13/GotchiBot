/** Remote transport policy. Local hub/container paths remain local. */
import { isIP } from 'node:net';

export function isTailnetHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  if (isIP(h) === 6) return h.startsWith('fd7a:115c:a1e0:');
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(h);
}

export function assertTailnetHost(host, { env = process.env, status, local = false } = {}) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (isTailnetHost(h) || (local && ['127.0.0.1', 'localhost', '::1', 'host.docker.internal'].includes(h))) return host;
  if (typeof status === 'function') status = status();
  const nodes = [status?.Self, ...Object.values(status?.Peer || {})].filter(Boolean);
  const listed = nodes.find(n => {
    const dns = String(n.DNSName || '').toLowerCase().replace(/\.$/, '');
    return dns && (h === dns || h === dns.split('.')[0]) || (n.TailscaleIPs || []).includes(h);
  });
  if (listed && !isIP(h)) return String(listed.DNSName).replace(/\.$/, '');
  if (isTailnetHost(h) || listed || (local && ['127.0.0.1', 'localhost', '::1', 'host.docker.internal'].includes(h))) return host;
  if (env.GOTCHIBOT_LEGACY_DIRECT_ROUTING === '1') return host;
  const error = new Error('Remote routing requires a Tailscale IP or full MagicDNS name; short names must be listed by Tailscale. Explicit legacy compatibility: GOTCHIBOT_LEGACY_DIRECT_ROUTING=1');
  error.code = 'TAILNET_REQUIRED';
  throw error;
}

export function assertTailnetUrl(base, options) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid Hub transport URL');
  url.hostname = assertTailnetHost(url.hostname, options);
  return url.toString().replace(/\/$/, "");
}
