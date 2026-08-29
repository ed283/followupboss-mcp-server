#!/usr/bin/env node
/**
 * Production permission allowlist regression tests.
 * No FUB credentials or network access are required.
 */
import assert from 'assert';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.FUB_API_KEY = 'fka_test';
process.env.FUB_SAFE_MODE = 'true';

const m = await import('../index.js');
const EXPECTED_APPROVED_TOOL_NAMES = Object.freeze([
  'about', 'help',
  'listEvents', 'getEvent',
  'listPeople', 'getPerson', 'checkDuplicate', 'listUnclaimed',
  'getPersonAttachment', 'listRelationships', 'getRelationship',
  'getIdentity', 'getCurrentUser',
  'listNotes', 'getNote',
  'listCalls', 'getCall',
  'listTextMessages', 'getTextMessage',
  'listUsers', 'getUser',
  'listSmartLists', 'getSmartList',
  'listActionPlans', 'listActionPlansPeople',
  'listAutomations', 'getAutomation', 'listAutomationsPeople', 'getAutomationPerson',
  'listTemplates', 'getTemplate', 'listTextMessageTemplates', 'getTextMessageTemplate',
  'listEmEvents', 'listEmCampaigns',
  'listCustomFields', 'getCustomField',
  'listStages', 'getStage',
  'listTasks', 'getTask',
  'listAppointments', 'getAppointment',
  'listAppointmentTypes', 'getAppointmentType',
  'listAppointmentOutcomes', 'getAppointmentOutcome',
  'listDeals', 'getDeal', 'getDealAttachment', 'listDealCustomFields', 'getDealCustomField',
  'listTimeframes', 'getReactions', 'getThreadedReplies',
  'getPersonByEmail', 'searchPeopleByTag', 'listAvailableTags',
  'createNote', 'createTask'
]);
const expectedNames = new Set(EXPECTED_APPROVED_TOOL_NAMES);
assert.strictEqual(expectedNames.size, EXPECTED_APPROVED_TOOL_NAMES.length,
  'the policy baseline must not contain duplicate tool names');

// The implementation's allowlist and registration surface must each match the
// independently stated production policy.
assert.deepStrictEqual(
  new Set(m.APPROVED_TOOL_NAMES),
  expectedNames,
  'implementation allowlist must contain exactly the approved tools'
);
assert.deepStrictEqual(
  new Set(m.activeTools.map(tool => tool.name)),
  expectedNames,
  'tool discovery source must contain exactly the approved tools'
);
assert.strictEqual(m.activeTools.length, EXPECTED_APPROVED_TOOL_NAMES.length,
  'tool discovery source must not contain duplicate or extra tools');
for (const name of ['listPeople', 'getDeal', 'createNote', 'createTask']) {
  assert.ok(expectedNames.has(name), `${name} must be approved`);
}
for (const name of ['createPerson', 'updatePerson', 'createDeal', 'updateDeal', 'bulkUpdatePeople', 'deletePerson']) {
  assert.ok(!expectedNames.has(name), `${name} must not be approved`);
}

// Legacy overlay inputs cannot add an unapproved discovery or handler path.
const [overlayClientTransport, overlayServerTransport] = InMemoryTransport.createLinkedPair();
const overlayServer = m.createServer({
  extraTools: [{ name: 'overlayDemo', description: 'unapproved', inputSchema: { type: 'object' } }],
  extraHandler: async () => ({ bypassed: true })
});
const overlayClient = new Client({ name: 'overlay-permissions-test', version: '1.0.0' });
await overlayServer.connect(overlayServerTransport);
await overlayClient.connect(overlayClientTransport);
try {
  const overlayDiscovery = await overlayClient.listTools();
  assert.ok(!overlayDiscovery.tools.some(tool => tool.name === 'overlayDemo'),
    'caller-supplied tools must not appear in MCP discovery');
  const overlayCall = await overlayClient.callTool({ name: 'overlayDemo', arguments: {} });
  assert.ok(overlayCall.isError, 'caller-supplied tools must be denied by the MCP handler');
  assert.match(overlayCall.content[0].text, /not approved for production use/);
} finally {
  await overlayClient.close();
  await overlayServer.close();
}

// Direct dispatcher use cannot bypass the allowlist, while approved tools
// reach their switch case without any FUB request.
const about = await m.handleToolCall('about', {});
assert.strictEqual(about.server, 'Follow Up Boss MCP Server');
for (const tool of m.TOOL_DEFINITIONS.filter(tool => !expectedNames.has(tool.name))) {
  await assert.rejects(
    () => m.handleToolCall(tool.name, {}),
    /not approved for production use|disabled in Safe Mode/,
    `${tool.name} must be rejected by direct dispatch`
  );
}

// Verify the real MCP discovery/handler path, not just the exported registry.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.js'],
  env: { ...process.env, FUB_API_KEY: 'fka_test', FUB_SAFE_MODE: 'true' }
});
const client = new Client({ name: 'tool-permissions-test', version: '1.0.0' });
await client.connect(transport);
try {
  const discovery = await client.listTools();
  assert.deepStrictEqual(
    new Set(discovery.tools.map(tool => tool.name)),
    expectedNames,
    'MCP tools/list must expose exactly the approved tools'
  );
  assert.strictEqual(discovery.tools.length, EXPECTED_APPROVED_TOOL_NAMES.length,
    'MCP tools/list must not expose duplicate or extra tools');

  const approved = await client.callTool({ name: 'about', arguments: {} });
  assert.ok(!approved.isError, 'an approved tool must reach the dispatch layer');

  const denied = await client.callTool({ name: 'createPerson', arguments: {} });
  assert.ok(denied.isError, 'an unapproved tool must fail through the MCP handler');
  assert.match(denied.content[0].text, /not approved for production use/);

  const safeModeDelete = await client.callTool({ name: 'deleteNote', arguments: { id: 1 } });
  assert.ok(safeModeDelete.isError, 'Safe Mode must still reject delete tools');
  assert.match(safeModeDelete.content[0].text, /Safe Mode/);
} finally {
  await client.close();
}

// Even with legacy Full Access explicitly requested, an unapproved delete
// remains denied by the production allowlist.
const fullAccessCheck = `
  import assert from 'assert';
  import { handleToolCall, activeTools } from './index.js';
  assert.ok(!activeTools.some(tool => tool.name === 'deletePerson'));
  await assert.rejects(() => handleToolCall('deletePerson', { id: 1 }), /not approved for production use/);
`;
execFileSync(process.execPath, ['--input-type=module', '--eval', fullAccessCheck], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, FUB_API_KEY: 'fka_test', FUB_SAFE_MODE: 'false' },
  stdio: 'pipe'
});

console.log(`tool-permissions: all checks passed (${m.activeTools.length} approved tools)`);
