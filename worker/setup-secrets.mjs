// One-shot secret setup for cslb-api.
//
// Prompts for a passphrase without echoing it, derives the PBKDF2 verifier,
// generates a random JWT signing key, and pipes both straight into
// `wrangler secret put`. Neither the passphrase nor the hash is ever printed
// or written to disk.
//
//   node setup-secrets.mjs
//
// Re-run it any time to change the passphrase.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { webcrypto as crypto } from 'node:crypto';
import { Writable } from 'node:stream';

const ENC = new TextEncoder();
const ITERATIONS = 100000;

function askHidden(question) {
  return new Promise((resolve, reject) => {
    let muted = false;
    const muter = new Writable({
      write(chunk, enc, cb) {
        if (!muted) process.stdout.write(chunk, enc);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: muter, terminal: true });
    rl.on('error', reject);
    rl.question(question, answer => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2Hex(passphrase, salt) {
  const key = await crypto.subtle.importKey('raw', ENC.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256
  );
  return hex(new Uint8Array(bits));
}

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['wrangler', 'secret', 'put', name],
      { stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32' }
    );
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${name} failed (exit ${code})`))));
    child.stdin.write(value + '\n');
    child.stdin.end();
  });
}

const pass = await askHidden('Choose a passphrase for c33.website sync: ');
if (pass.length < 8) {
  console.error('Too short. Use at least 8 characters.');
  process.exit(1);
}
const again = await askHidden('Type it again: ');
if (pass !== again) {
  console.error('They do not match. Nothing was changed.');
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const authHash = `${hex(salt)}:${await pbkdf2Hex(pass, salt)}`;
const jwtSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(48)))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

console.log('\nUploading AUTH_HASH...');
await putSecret('AUTH_HASH', authHash);
console.log('Uploading JWT_SECRET...');
await putSecret('JWT_SECRET', jwtSecret);
console.log('\nDone. Both secrets are set on cslb-api. Remember the passphrase — it is not stored anywhere else.');
