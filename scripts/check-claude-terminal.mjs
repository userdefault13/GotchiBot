// Simple script to check Claude terminal status on iMac
// Runs: abra run gotchibot -- ./scripts/gotchibot hub status

import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = join('/Users/juliuswong/Dev/GotchiBot');
process.chdir(root);

try {
  // Check hub status
  const hubOutput = execSync('abra run gotchibot -- ./scripts/gotchibot hub status', { encoding: 'utf-8' });
  console.log('=== Hub Status ===');
  console.log(hubOutput);
  
  // Check for running Claude jobs
  // Look at the iMac sessions count
  const sessionsMatch = hubOutput.match(/iMac (\d+) run/);
  if (sessionsMatch) {
    console.log(`\niMac Claude sessions: ${sessionsMatch[1]}`);
  }
  
  // Check for any gb- job IDs in output that might indicate Claude activity
  const jobIds = hubOutput.match(/gb-\w+/g);
  if (jobIds) {
    console.log(`\nClaude job IDs found: ${jobIds.join(', ')}`);
  }
  
} catch (err) {
  console.error('Error checking status:', err.message);
}
