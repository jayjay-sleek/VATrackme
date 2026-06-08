const fetch = global.fetch || require('node-fetch');
const fs = require('fs');

async function trigger(owner, repo, workflowFile, ref, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'repo-script',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref }),
  });
  if (res.status === 204) {
    console.log('Workflow dispatched');
    return;
  }
  const txt = await res.text();
  throw new Error(`Failed to dispatch workflow: ${res.status} ${txt}`);
}

async function main() {
  const [owner, repo, workflowFile, ref] = process.argv.slice(2);
  const token = process.env.GITHUB_PAT;
  if (!token) {
    console.error('Missing GITHUB_PAT env var');
    process.exit(2);
  }
  await trigger(owner, repo, workflowFile, ref, token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

