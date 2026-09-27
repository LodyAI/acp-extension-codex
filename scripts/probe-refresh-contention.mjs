import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { startCodexConnection } from '../src/CodexJsonRpcConnection.ts';

const root = await mkdtemp(path.join(tmpdir(), 'codex-refresh-probe-'));
const jwt = (payload) =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;
const initial = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: jwt({ sub: 'synthetic-user', 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account', chatgpt_user_id: 'synthetic-user' } }),
    access_token: jwt({ sub: 'synthetic-user', exp: Math.floor(Date.now() / 1000) + 86400 }),
    refresh_token: 'synthetic-refresh-0',
    account_id: 'synthetic-account',
  },
  last_refresh: new Date().toISOString(),
};
await writeFile(path.join(root, 'auth.json'), JSON.stringify(initial), { mode: 0o600 });
await writeFile(path.join(root, 'config.toml'), 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n');

let arrivals = 0;
let release;
const gate = new Promise(resolve => { release = resolve; });
const server = createServer(async (request, response) => {
  if (request.url !== '/oauth/token') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  arrivals += 1;
  console.log('arrival', arrivals, body);
  const order = arrivals;
  if (arrivals === 2) release();
  await gate;
  if (order === 1) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: jwt({ sub: 'synthetic-user', exp: Math.floor(Date.now() / 1000) + 86400 }), refresh_token: 'synthetic-refresh-1' }));
  } else {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'refresh_token_reused', message: 'Synthetic refresh token was reused' } }));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing server address');
const endpoint = `http://127.0.0.1:${address.port}/oauth/token`;
const env = { ...process.env, CODEX_HOME: root, CODEX_REFRESH_TOKEN_URL_OVERRIDE: endpoint, CODEX_APP_SERVER_LOGIN_CLIENT_ID: 'synthetic-client', OPENAI_API_KEY: '', CODEX_API_KEY: '' };
const a = startCodexConnection(undefined, env);
const b = startCodexConnection(undefined, env);
const timeout = setTimeout(() => { release(); a.process.kill(); b.process.kill(); }, 20000);
try {
  const init = { clientInfo: { name: 'synthetic-refresh-probe', version: '1' }, capabilities: null };
  await Promise.all([a.connection.sendRequest('initialize', init), b.connection.sendRequest('initialize', init)]);
  console.log('baseline', await Promise.all([a.connection.sendRequest('getAuthStatus', { includeToken: false, refreshToken: false }), b.connection.sendRequest('getAuthStatus', { includeToken: false, refreshToken: false })]));
  const results = await Promise.allSettled([a.connection.sendRequest('getAuthStatus', { includeToken: false, refreshToken: true }), b.connection.sendRequest('getAuthStatus', { includeToken: false, refreshToken: true })]);
  console.log('results', results);
  const stored = JSON.parse(await readFile(path.join(root, 'auth.json'), 'utf8'));
  assert.equal(arrivals, 2);
  assert.equal(stored.tokens.refresh_token, 'synthetic-refresh-1');
  const after = await Promise.all([a.connection.sendRequest('getAuthStatus', { includeToken: true, refreshToken: false }), b.connection.sendRequest('getAuthStatus', { includeToken: true, refreshToken: false })]);
  assert.deepEqual(after.map(status => Boolean(status.authToken)).sort(), [false, true]);
  console.log('after', after.map(status => ({authMethod: status.authMethod, hasToken: Boolean(status.authToken)})));
} finally {
  clearTimeout(timeout);
  a.process.kill();
  b.process.kill();
  server.close();
  await rm(root, { recursive: true, force: true });
}
