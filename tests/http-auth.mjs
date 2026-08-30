#!/usr/bin/env node
/**
 * Offline HTTP authentication regression tests. No FUB request is made.
 */
import assert from 'assert';
import { spawn } from 'child_process';
import { createServer as createNetServer } from 'net';
import { createServer as createHttpServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { createHash, randomBytes } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const FUB_TEST_KEY = 'fka_http_auth_test_key';
const BEARER_TEST_TOKEN = 'mcp_http_auth_test_token';
process.env.FUB_API_KEY = FUB_TEST_KEY;
process.env.FUB_SAFE_MODE = 'true';
const { createServer: createMcpServer } = await import('../index.js');

function getOpenPort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
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
  if (child.exitCode !== null) return;
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill();
  await exited;
}

async function launchDirectTransport() {
  let transport;
  const server = createHttpServer(async (req, res) => {
    if (!transport) {
      const mcpServer = createMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString('hex')
      });
      await mcpServer.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  const port = await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolveStop, reject) => server.close(error => error ? reject(error) : resolveStop()))
  };
}

const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'http-auth-test', version: '1.0.0' }
  }
};

function parseSseJsonRpc(body) {
  const data = body.match(/^data: (.+)$/m)?.[1];
  assert.ok(data, 'MCP SSE response must contain a JSON-RPC data event');
  return JSON.parse(data);
}

async function initializeMcp(base, accessToken) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(initRequest)
  });
  const body = await response.text();
  assert.strictEqual(response.status, 200, 'OAuth access token must initialize MCP');
  assert.match(response.headers.get('content-type'), /^text\/event-stream(?:;|$)/,
    'default Streamable HTTP initialize response must be SSE');
  const message = parseSseJsonRpc(body);
  assert.strictEqual(message.jsonrpc, '2.0');
  assert.strictEqual(message.id, initRequest.id);
  assert.strictEqual(message.result.protocolVersion, initRequest.params.protocolVersion);
  assert.deepStrictEqual(message.result.capabilities, { tools: {} });
  assert.ok(message.result.serverInfo?.name);
  const sessionId = response.headers.get('mcp-session-id');
  assert.ok(sessionId, 'MCP initialize must return a session ID');
  return { sessionId, body, message };
}

async function listTools(base, accessToken, sessionId) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      'Mcp-Session-Id': sessionId,
      'MCP-Protocol-Version': initRequest.params.protocolVersion
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  const body = await response.text();
  assert.strictEqual(response.status, 200, 'OAuth access token must reach tools/list');
  assert.match(response.headers.get('content-type'), /^text\/event-stream(?:;|$)/);
  const normalized = body.replace(/\\"/g, '"');
  const names = [...normalized.matchAll(/"name":"([^"]+)"/g)].map(match => match[1]);
  assert.strictEqual(names.length, 60, 'OAuth tools/list must return exactly 60 tools');
  assert.ok(names.includes('createNote'));
  assert.ok(names.includes('createTask'));
  assert.ok(!names.includes('createPerson'));
  assert.ok(!names.includes('deletePerson'));
}

async function sendInitializedNotification(base, accessToken, sessionId) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      'Mcp-Session-Id': sessionId,
      'MCP-Protocol-Version': initRequest.params.protocolVersion
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });
  assert.strictEqual(response.status, 202, 'notifications/initialized must be accepted');
  assert.strictEqual(await response.text(), '', 'notifications/initialized must not return a JSON-RPC body');
}

async function postMcp(base, accessToken, body) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
}

async function assertInitializeStatus(base, accessToken, body, expectedStatus, label) {
  const response = await postMcp(base, accessToken, body);
  const responseBody = await response.text();
  assert.strictEqual(response.status, expectedStatus, label);
  if (expectedStatus === 200) {
    assert.strictEqual(parseSseJsonRpc(responseBody).result.protocolVersion, '2025-11-25');
  } else {
    const error = JSON.parse(responseBody).error;
    assert.strictEqual(error.code, -32700, `${label}: must be JSON-RPC parse error`);
  }
}

function assertStrictPublicClientRegistration(response, redirectUris, expectedScope) {
  const permittedFields = new Set([
    'client_id', 'client_id_issued_at', 'redirect_uris', 'grant_types',
    'response_types', 'token_endpoint_auth_method', 'scope'
  ]);
  for (const field of Object.keys(response)) {
    assert.ok(permittedFields.has(field), `unexpected DCR response field: ${field}`);
    assert.notStrictEqual(response[field], null, `DCR response field must not be null: ${field}`);
  }
  assert.strictEqual(typeof response.client_id, 'string');
  assert.ok(response.client_id.length > 0);
  assert.strictEqual(typeof response.client_id_issued_at, 'number');
  assert.deepStrictEqual(response.redirect_uris, redirectUris);
  assert.deepStrictEqual(response.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepStrictEqual(response.response_types, ['code']);
  assert.strictEqual(response.token_endpoint_auth_method, 'none');
  if (expectedScope === undefined) {
    assert.ok(!Object.hasOwn(response, 'scope'));
  } else {
    assert.strictEqual(response.scope, expectedScope);
  }
  assert.ok(!Object.hasOwn(response, 'client_secret'));
  assert.ok(!Object.hasOwn(response, 'client_secret_expires_at'));
}

// The same 2025-11-25 initialize succeeds when routed directly to the SDK
// without Express. The production-route test below exercises express.json()
// and handleRequest(req, res, req.body) separately.
{
  const direct = await launchDirectTransport();
  try {
    const response = await fetch(`${direct.base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify(initRequest)
    });
    assert.strictEqual(response.status, 200, 'direct SDK initialize must not return a parse error');
    const message = parseSseJsonRpc(await response.text());
    assert.strictEqual(message.result.protocolVersion, '2025-11-25');
  } finally {
    await direct.stop();
  }
}

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

// Complete OAuth flow: DCR, S256 PKCE, offline_access, token refresh rotation,
// authenticated MCP discovery, and persistence across a server restart.
{
  const storeDirectory = await mkdtemp(resolve(tmpdir(), 'fub-mcp-oauth-'));
  const storePath = resolve(storeDirectory, 'oauth-store.json');
  const password = 'oauth_test_password';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callbackId = randomBytes(9).toString('base64url');
  assert.match(callbackId, /^[A-Za-z0-9_-]+$/, 'ChatGPT callback ID must be URL-safe');
  const callback = `https://chatgpt.com/connector/oauth/${callbackId}`;
  let firstServer;
  let secondServer;
  let thirdServer;
  let firstServerStopped = false;
  let secondServerStopped = false;
  let authorizationCode;
  let dcrClientId;
  let mcpSessionId;
  let originalTokens;
  let refreshedTokens;
  let output = '';
  try {
    const firstPort = await getOpenPort();
    firstServer = launch(baseEnv(firstPort, {
      MCP_AUTH_PASSWORD: password,
      MCP_OAUTH_STORE_PATH: storePath
    }));
    const firstBase = `http://127.0.0.1:${firstPort}`;
    await waitForHealth(firstBase, firstServer.child);
    const resource = `${firstBase}/mcp`;

    // An MCP client can begin with an unauthenticated request, read the
    // challenge, then follow the RFC 9728 metadata chain to the AS.
    const unauthenticated = await fetch(`${firstBase}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify(initRequest)
    });
    assert.strictEqual(unauthenticated.status, 401, 'unauthenticated MCP request must be rejected');
    const challengeHeader = unauthenticated.headers.get('www-authenticate');
    assert.strictEqual(challengeHeader,
      `Bearer resource_metadata="${firstBase}/.well-known/oauth-protected-resource/mcp"`);
    const resourceMetadataUrl = challengeHeader.match(/resource_metadata="([^"]+)"/)[1];
    const protectedMetadata = await (await fetch(resourceMetadataUrl)).json();
    assert.strictEqual(protectedMetadata.resource, resource);
    assert.deepStrictEqual(protectedMetadata.authorization_servers, [firstBase]);
    assert.ok(protectedMetadata.scopes_supported.includes('mcp'));
    // Keep the origin-level endpoint for compatibility, but assert the
    // path-specific endpoint is the one advertised in the challenge.
    const rootProtectedMetadata = await (await fetch(`${firstBase}/.well-known/oauth-protected-resource`)).json();
    assert.deepStrictEqual(rootProtectedMetadata, protectedMetadata);
    const metadata = await (await fetch(`${protectedMetadata.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    assert.ok(metadata.grant_types_supported.includes('authorization_code'));
    assert.ok(metadata.grant_types_supported.includes('refresh_token'));
    assert.ok(metadata.scopes_supported.includes('mcp'));
    assert.ok(metadata.scopes_supported.includes('offline_access'));

    const registration = await fetch(`${firstBase}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        client_name: 'ChatGPT'
      })
    });
    assert.strictEqual(registration.status, 201, 'DCR registration must succeed');
    assert.match(registration.headers.get('content-type'), /^application\/json(?:;|$)/,
      'DCR response must be JSON');
    assert.strictEqual(registration.headers.get('cache-control'), 'no-store',
      'DCR response must not be cached');
    assert.strictEqual(registration.headers.get('pragma'), 'no-cache',
      'DCR response must include the RFC 7591 no-cache pragma');
    const registered = await registration.json();
    assertStrictPublicClientRegistration(registered, [callback]);
    dcrClientId = registered.client_id;

    const codeOnlyRegistration = await fetch(`${firstBase}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [callback],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp'
      })
    });
    assert.strictEqual(codeOnlyRegistration.status, 201);
    const codeOnlyClient = await codeOnlyRegistration.json();
    assert.deepStrictEqual(codeOnlyClient.grant_types, ['authorization_code'],
      'DCR response must not add refresh_token when the public client did not register it');

    const authorizeParams = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: callback,
      state: 'oauth-test-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      response_type: 'code',
      scope: 'mcp offline_access',
      resource
    });
    const invalidResource = new URLSearchParams(authorizeParams);
    invalidResource.set('resource', `${firstBase}/not-mcp`);
    const invalidResourceResponse = await fetch(`${firstBase}/oauth/authorize?${invalidResource}`);
    assert.strictEqual(invalidResourceResponse.status, 400, 'authorization must reject a token target other than /mcp');
    assert.strictEqual(await invalidResourceResponse.text(), 'invalid_target');
    const authorizeGet = await fetch(`${firstBase}/oauth/authorize?${authorizeParams}`, { redirect: 'manual' });
    assert.strictEqual(authorizeGet.status, 200, 'authorization request must render the password form');

    const authorizePost = await fetch(`${firstBase}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(authorizeParams), password })
    });
    assert.strictEqual(authorizePost.status, 302, 'valid password authorization must redirect');
    authorizationCode = new URL(authorizePost.headers.get('location')).searchParams.get('code');
    assert.ok(authorizationCode, 'authorization redirect must contain a code');

    const tokenResponse = await fetch(`${firstBase}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: callback,
        client_id: registered.client_id,
        code_verifier: verifier,
        resource
      })
    });
    assert.strictEqual(tokenResponse.status, 200, 'PKCE token exchange must succeed');
    originalTokens = await tokenResponse.json();
    assert.ok(originalTokens.access_token);
    assert.ok(originalTokens.refresh_token, 'offline_access must receive a refresh token');
    assert.strictEqual(originalTokens.scope, 'mcp offline_access');

    const discover = await fetch(`${firstBase}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: `Bearer ${originalTokens.access_token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'server/discover' })
    });
    assert.strictEqual(discover.status, 400, 'unsupported server/discover must be rejected before initialization');
    const discoverError = await discover.json();
    assert.strictEqual(discoverError.error.code, -32000);
    assert.strictEqual(discoverError.error.message, 'Bad Request: Server not initialized');
    const undiscoveredHealth = await (await fetch(`${firstBase}/health`)).json();
    assert.strictEqual(undiscoveredHealth.sessions, 0, 'failed server/discover must not create a persisted session');

    const firstSession = await initializeMcp(firstBase, originalTokens.access_token);
    mcpSessionId = firstSession.sessionId;
    const activeHealth = await (await fetch(`${firstBase}/health`)).json();
    assert.strictEqual(activeHealth.sessions, 1, 'initialize must persist one Streamable HTTP session');
    await sendInitializedNotification(firstBase, originalTokens.access_token, firstSession.sessionId);

    const missingProtocolVersion = await fetch(`${firstBase}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: `Bearer ${originalTokens.access_token}`,
        'Mcp-Session-Id': firstSession.sessionId
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })
    });
    assert.strictEqual(missingProtocolVersion.status, 200,
      'SDK accepts a missing later MCP-Protocol-Version header using the negotiated version');
    await missingProtocolVersion.text();

    const unsupportedProtocolVersion = await fetch(`${firstBase}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: `Bearer ${originalTokens.access_token}`,
        'Mcp-Session-Id': firstSession.sessionId,
        'MCP-Protocol-Version': 'not-a-protocol-version'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list' })
    });
    assert.strictEqual(unsupportedProtocolVersion.status, 400,
      'unsupported later MCP-Protocol-Version header must be rejected');

    const invalidSession = await fetch(`${firstBase}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: `Bearer ${originalTokens.access_token}`,
        'Mcp-Session-Id': 'not-a-real-session',
        'MCP-Protocol-Version': initRequest.params.protocolVersion
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list' })
    });
    assert.strictEqual(invalidSession.status, 404, 'unknown session ID must be rejected as not found');
    assert.strictEqual((await invalidSession.json()).error.code, -32001);
    await listTools(firstBase, originalTokens.access_token, firstSession.sessionId);

    // A reconnect is a new client session: a second initialize without a
    // session header must receive an independent transport, not reuse Client A.
    const secondSession = await initializeMcp(firstBase, originalTokens.access_token);
    assert.notStrictEqual(secondSession.sessionId, firstSession.sessionId,
      'two initialize requests must create distinct session IDs');
    const twoSessionHealth = await (await fetch(`${firstBase}/health`)).json();
    assert.strictEqual(twoSessionHealth.sessions, 2, 'both initialized sessions must remain available');
    await sendInitializedNotification(firstBase, originalTokens.access_token, secondSession.sessionId);
    await listTools(firstBase, originalTokens.access_token, secondSession.sessionId);
    await listTools(firstBase, originalTokens.access_token, firstSession.sessionId);

    // Probe structural variants through the same Express route used in production.
    // Each accepted initialize intentionally receives an independent session.
    await assertInitializeStatus(firstBase, originalTokens.access_token, structuredClone(initRequest), 200,
      'normal initialize object must succeed');
    const extraCapabilities = structuredClone(initRequest);
    extraCapabilities.params.capabilities = { experimental: { 'chatgpt/test': { enabled: true } } };
    await assertInitializeStatus(firstBase, originalTokens.access_token, extraCapabilities, 200,
      'initialize with additional capabilities must succeed');
    const extraClientInfo = structuredClone(initRequest);
    extraClientInfo.params.clientInfo.build = 'business';
    await assertInitializeStatus(firstBase, originalTokens.access_token, extraClientInfo, 200,
      'initialize with extra clientInfo fields must succeed');
    const extraParams = structuredClone(initRequest);
    extraParams.params.client_extension = { enabled: true };
    await assertInitializeStatus(firstBase, originalTokens.access_token, extraParams, 200,
      'initialize with additional params fields must succeed');
    const topLevelExtra = structuredClone(initRequest);
    topLevelExtra.client_extension = true;
    await assertInitializeStatus(firstBase, originalTokens.access_token, topLevelExtra, 400,
      'initialize with a top-level extra field must fail strict JSON-RPC validation');
    await assertInitializeStatus(firstBase, originalTokens.access_token, [structuredClone(initRequest)], 200,
      'single-message JSON-RPC batch containing initialize must succeed');
    const nullParams = structuredClone(initRequest);
    nullParams.params = null;
    await assertInitializeStatus(firstBase, originalTokens.access_token, nullParams, 400,
      'initialize with null params must fail JSON-RPC validation');
    const nullId = structuredClone(initRequest);
    nullId.id = null;
    await assertInitializeStatus(firstBase, originalTokens.access_token, nullId, 400,
      'initialize with null id must fail JSON-RPC validation');
    const numericId = structuredClone(initRequest);
    numericId.id = 8675309;
    await assertInitializeStatus(firstBase, originalTokens.access_token, numericId, 200,
      'initialize with integer request ID must succeed');
    const stringId = structuredClone(initRequest);
    stringId.id = 'chatgpt-initialize-α';
    await assertInitializeStatus(firstBase, originalTokens.access_token, stringId, 200,
      'initialize with string request ID must succeed');

    const refreshResponse = await fetch(`${firstBase}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: originalTokens.refresh_token,
        client_id: registered.client_id,
        resource
      })
    });
    assert.strictEqual(refreshResponse.status, 200, 'refresh-token exchange must succeed');
    refreshedTokens = await refreshResponse.json();
    assert.ok(refreshedTokens.access_token);
    assert.ok(refreshedTokens.refresh_token);
    assert.notStrictEqual(refreshedTokens.refresh_token, originalTokens.refresh_token,
      'refresh-token rotation must issue a new refresh token');

    for (const refreshToken of [originalTokens.refresh_token, 'not-a-real-refresh-token']) {
      const rejected = await fetch(`${firstBase}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: registered.client_id, resource })
      });
      assert.strictEqual(rejected.status, 400, 'reused or invalid refresh token must be rejected');
      assert.strictEqual((await rejected.json()).error, 'invalid_grant');
    }

    await stop(firstServer.child);
    firstServerStopped = true;
    output += firstServer.output();

    const secondPort = firstPort;
    secondServer = launch(baseEnv(secondPort, {
      MCP_AUTH_PASSWORD: password,
      MCP_OAUTH_STORE_PATH: storePath
    }));
    const secondBase = `http://127.0.0.1:${secondPort}`;
    await waitForHealth(secondBase, secondServer.child);
    const renewedSession = await initializeMcp(secondBase, refreshedTokens.access_token);
    await listTools(secondBase, refreshedTokens.access_token, renewedSession.sessionId);

    const persistedRefresh = await fetch(`${secondBase}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshedTokens.refresh_token,
        client_id: registered.client_id,
        resource
      })
    });
    assert.strictEqual(persistedRefresh.status, 200, 'persisted refresh token must work after restart');
    const persistedTokens = await persistedRefresh.json();
    const persistedSession = await initializeMcp(secondBase, persistedTokens.access_token);
    assert.ok(persistedSession.sessionId, 'refreshed access token must initialize MCP after restart');

    await stop(secondServer.child);
    secondServerStopped = true;
    const persistedStore = JSON.parse(await readFile(storePath, 'utf8'));
    persistedStore.refreshTokens[persistedTokens.refresh_token].expires_at = Date.now() - 1;
    await writeFile(storePath, JSON.stringify(persistedStore));

    const thirdPort = firstPort;
    thirdServer = launch(baseEnv(thirdPort, {
      MCP_AUTH_PASSWORD: password,
      MCP_OAUTH_STORE_PATH: storePath
    }));
    const thirdBase = `http://127.0.0.1:${thirdPort}`;
    await waitForHealth(thirdBase, thirdServer.child);
    const expired = await fetch(`${thirdBase}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: persistedTokens.refresh_token,
        client_id: registered.client_id,
        resource
      })
    });
    assert.strictEqual(expired.status, 400, 'expired refresh token must be rejected');
    assert.strictEqual((await expired.json()).error, 'invalid_grant');
  } finally {
    if (firstServer && !firstServerStopped) await stop(firstServer.child);
    if (secondServer && !secondServerStopped) await stop(secondServer.child);
    if (thirdServer?.child.exitCode === null) await stop(thirdServer.child);
    output += firstServer?.output() || '';
    output += secondServer?.output() || '';
    output += thirdServer?.output() || '';
    await rm(storeDirectory, { recursive: true, force: true });
  }
  for (const secret of [password, verifier, challenge, authorizationCode, mcpSessionId, originalTokens?.access_token,
    originalTokens?.refresh_token, refreshedTokens?.access_token, refreshedTokens?.refresh_token].filter(Boolean)) {
    assert.ok(!output.includes(secret), 'OAuth logs must not contain a test secret');
  }
  assert.ok(output.includes(`"redirect_uris":["${callback}"]`),
    'sanitized DCR request log must retain the dynamic ChatGPT redirect URI structure');
  assert.match(output, /\[oauth\] dcr\.response\.metadata \{.*"client_id_fingerprint":"[a-f0-9]{12}"/,
    'sanitized DCR response log must fingerprint, not expose, client_id');
  const firstDcrResponseLog = output.match(/^\[oauth\] dcr\.response\.metadata .*$/m)?.[0];
  assert.ok(firstDcrResponseLog, 'DCR response metadata must be logged');
  assert.ok(!firstDcrResponseLog.includes('"scope"'), 'scope must be absent when ChatGPT did not register one');
  assert.ok(!output.includes(dcrClientId), 'DCR logs must not contain the raw client_id');
  for (const event of ['metadata.authorization_server.get', 'metadata.protected_resource.get',
    'mcp.unauthenticated.request', 'mcp.unauthenticated.response.401.www_authenticate',
    'dcr.request', 'dcr.params.redirect_uris', 'dcr.params.grant_types', 'dcr.params.response_types',
    'authorize.get', 'authorize.params.client_id,redirect_uri,response_type,code_challenge,code_challenge_method,scope,resource', 'authorize.post.success',
    'token.authorization_code.request', 'token.refresh.request', 'mcp.initialize', 'mcp.tools.list']) {
    assert.ok(output.includes(`[oauth] ${event}`), `sanitized log must include ${event}`);
  }
  for (const event of ['request.received', 'response.sent', 'initialize.received',
    'initialize.structure', 'initialize.validation_passed', 'initialize.validation_failed',
    'initialized_notification.received', 'tools_list.received']) {
    assert.ok(output.includes(`[mcp-http] ${event}`), `handshake diagnostic must include ${event}`);
  }
  assert.match(output, /\[mcp-http\] response\.error \{.*"status":400/,
    'non-2xx MCP responses must record a sanitized diagnostic');
}

console.log('http-auth: all checks passed');
