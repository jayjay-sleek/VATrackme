const fs = require('fs');
const fetch = global.fetch || require('node-fetch');
const sodium = require('libsodium-wrappers');

async function setSecret(owner, repo, name, value, token) {
  const pubRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'repo-script',
    },
  });
  if (!pubRes.ok) {
    throw new Error(`Failed to get public key: ${pubRes.status} ${await pubRes.text()}`);
  }
  const pub = await pubRes.json();
  await sodium.ready;
  const publicKeyBytes = Buffer.from(pub.key, 'base64');
  const secretBytes = Buffer.from(value, 'utf8');
  const encryptedBytes = sodium.crypto_box_seal(secretBytes, publicKeyBytes);
  const encrypted = Buffer.from(encryptedBytes).toString('base64');

  const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'repo-script',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ encrypted_value: encrypted, key_id: pub.key_id }),
  });
  if (!putRes.ok) {
    throw new Error(`Failed to set secret ${name}: ${putRes.status} ${await putRes.text()}`);
  }
  console.log(`Secret ${name} set`);
}

async function main() {
  const [owner, repo, secretName, filePath] = process.argv.slice(2);
  const token = process.env.GITHUB_PAT;
  if (!token) {
    console.error('Missing GITHUB_PAT env var');
    process.exit(2);
  }
  if (!owner || !repo || !secretName || !filePath) {
    console.error('Usage: node set-secret.js owner repo secretName filePath');
    process.exit(2);
  }
  const value = fs.readFileSync(filePath, 'utf8').trim();
  await setSecret(owner, repo, secretName, value, token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

