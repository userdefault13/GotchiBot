import { gotchibot_hub_hub_status } from './mcp/gotchibot-hub.mjs';

// Get hub status
const status = await gotchibot_hub_hub_status();

console.log('=== Hub Status ===');
console.log(`iMac: ${status.includes('juliuss-imac-2') ? 'up' : 'down'}`);
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
