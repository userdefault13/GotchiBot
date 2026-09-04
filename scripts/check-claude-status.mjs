import { listJobs } from './mcp/gotchibot-claude.mjs';

// Check for ready Claude jobs
const jobs = await listJobs({ status: 'ready' });

if (jobs.length > 0) {
  console.log(`Found ${jobs.length} ready Claude jobs:`);
  jobs.forEach((job, i) => {
    console.log(`${i+1}. ID: ${job.id}`);
    console.log(`   Prompt: ${job.prompt.substring(0, 80)}...`);
    console.log(`   Status: ${job.status}`);
    if (job.response) {
      console.log(`   Response: ${job.response.substring(0, 100)}...`);
    }
    console.log('');
  });
} else {
  console.log('No ready Claude jobs found.');
}

// Also check pending jobs
const pending = await listJobs({ status: 'pending' });
if (pending.length > 0) {
  console.log(`Found ${pending.length} pending Claude jobs:`);
  pending.forEach((job, i) => {
    console.log(`${i+1}. ID: ${job.id} - still waiting for wake`);
  });
}
