import { gotchibot_hub_hub_status } from './mcp/gotchibot-hub.mjs';

// Get hub status
const status = await gotchibot_hub_hub_status();

console.log('=== Hub Status ===');
const want = String(process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST || "")
  .toLowerCase()
  .split('.')[0];
const hostUp = want ? status.toLowerCase().includes(want) : /imac/i.test(status);
console.log(`iMac: ${hostUp ? 'up' : 'down'}`);
console.log(`OpenClaw: ${status.includes('OpenClaw') ? 'up' : 'down'}`);
console.log(`Tunnel: ${status.includes('Tunnel') ? 'ok' : 'down'}`);
console.log(`Docker: ${status.includes('17 total') ? 'running' : 'issues'}`);

// Check for running Claude jobs
// Look for gb- patterns in recent activity
console.log('\n=== Key Status Items ===');
const lines = status.split('\n');
lines.forEach(line => {
  if (line.includes('run/') || line.includes('agents') || line.includes('Sessions') || line.includes('focus')) {
    console.log(line);
  }
});
