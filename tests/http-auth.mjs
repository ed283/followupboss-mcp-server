#!/usr/bin/env node
/**
 * Offline HTTP authentication regression tests. No FUB request is made.
 */
import assert from 'assert';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const FUB_TEST_KEY = 'fka_http_auth_test_key';
const BEARER_TEST_TOKEN = 'mcp_http_auth_test_token';

function getOpenPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function baseEnv(port, extra = {}) {
  return {
    PATH: process.env.PATH,
    MCP_TRANSPORT: 'http',
    PORT: String(port),
    FUB_API_KEY: FUB_TEST_KEY,
    FUB_SAFE_MODE: 'true',
    NODE_ENV: 'test',
    ...extra
  };
}

function launch(env) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not exit')), 3000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForHealth(base, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before listening (${child.exitCode})`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return response;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error('server did not become healthy');
}

async function stop(child) {
  if (child.exitCode === null) child.kill();
  await new Promise(resolveExit => child.once('exit', resolveExit));
}

const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'http-auth-test', version: '1.0.0' }
  }
};

// HTTP mode must not start with no authentication configuration.
{
  const port = await getOpenPort();
  const server = launch(baseEnv(port));
  const result = await waitForExit(server.child);
  assert.strictEqual(result.code, 1, 'unauthenticated HTTP server must exit with failure');
  assert.match(server.output(), /requires MCP_BEARER_TOKEN or MCP_AUTH_PASSWORD/);
  assert.ok(!server.output().includes(FUB_TEST_KEY), 'startup failure must not log the FUB key');
}

// An explicit auth-disable request is rejected outside local development.
{
  const port = await getOpenPort();
  const server = launch(baseEnv(port, { MCP_AUTH_DISABLED: 'true', NODE_ENV: 'production' }));
  const result = await waitForExit(server.child);
  assert.strictEqual(result.code, 1, 'non-development auth-disable request must exit with failure');
  assert.match(server.output(), /permitted only with NODE_ENV=development/);
}

// Bearer mode protects /mcp, permits a valid MCP initialization, and never
// returns or logs either test secret. /health intentionally stays public.
{
  const port = await getOpenPort();
  const server = launch(baseEnv(port, { MCP_BEARER_TOKEN: BEARER_TEST_TOKEN }));
  const base = `http://127.0.0.1:${port}`;
  try {
    const healthResponse = await waitForHealth(base, server.child);
    const healthBody = await healthResponse.text();
    const health = JSON.parse(healthBody);
    assert.strictEqual(health.authMode, 'bearer');
    assert.strictEqual(health.safeMode, true);
    assert.ok(!healthBody.includes(FUB_TEST_KEY));
    assert.ok(!healthBody.includes(BEARER_TEST_TOKEN));

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify(initRequest)
    };
    const missing = await fetch(`${base}/mcp`, requestOptions);
    assert.strictEqual(missing.status, 401, 'missing bearer token must be rejected');
    assert.ok(!(await missing.text()).includes(BEARER_TEST_TOKEN));

    const invalid = await fetch(`${base}/mcp`, {
      ...requestOptions,
      headers: { ...requestOptions.headers, Authorization: 'Bearer wrong-token' }
    });
    assert.strictEqual(invalid.status, 401, 'invalid bearer token must be rejected');
    assert.ok(!(await invalid.text()).includes(BEARER_TEST_TOKEN));

    const valid = await fetch(`${base}/mcp`, {
      ...requestOptions,
      headers: { ...requestOptions.headers, Authorization: `Bearer ${BEARER_TEST_TOKEN}` }
    });
    const validBody = await valid.text();
    assert.strictEqual(valid.status, 200, 'valid bearer token must reach MCP handling');
    assert.match(validBody, /serverInfo/);
    assert.ok(!validBody.includes(FUB_TEST_KEY));
    assert.ok(!validBody.includes(BEARER_TEST_TOKEN));
  } finally {
    await stop(server.child);
  }
  assert.ok(!server.output().includes(FUB_TEST_KEY), 'server logs must not contain the FUB key');
  assert.ok(!server.output().includes(BEARER_TEST_TOKEN), 'server logs must not contain the bearer token');
}

console.log('http-auth: all checks passed');
