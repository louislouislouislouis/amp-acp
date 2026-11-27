import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  client as v1Client,
  methods,
  ndJsonStream as v1Stream,
} from '@agentclientprotocol/sdk/unstable';
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  client as v2Client,
  ndJsonStream as v2Stream,
} from '@agentclientprotocol/sdk/experimental/v2/unstable';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AcpClient } from './acp-client.js';
import { createAgentApp } from './agent-app.js';
import { AcpV2Adapter } from './acp-v2.js';
import type { AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

const transport: AmpTransport = {
  name: 'cli',
  async *execute() {
    yield { type: 'system', subtype: 'init', session_id: threadId };
    yield { type: 'result', subtype: 'success', is_error: false };
  },
};

interface RecordedUpdate {
  sessionId: string;
  update: { sessionUpdate: string; title?: unknown; state?: unknown };
}

describe('session archive and title over ACP', () => {
  let stateDir: string;
  let store: FileThreadMappingStore;
  let archived: boolean[];
  let renamed: string[];
  let updates: RecordedUpdate[];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-methods-'));
    store = new FileThreadMappingStore(stateDir);
    archived = [];
    renamed = [];
    updates = [];
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function createAgent(acpClient: AcpClient): AmpAcpAgent {
    return new AmpAcpAgent(acpClient, transport, {
      orbTransport: transport,
      threadStore: store,
      setThreadArchived: async (_threadId, value) => {
        archived.push(value);
      },
      renameThread: async (_threadId, title) => {
        renamed.push(title);
      },
      discoverPluginModes: () => [],
      discoverModels: () => [],
    });
  }

  function titleUpdates(sessionId: string): unknown[] {
    return updates.flatMap(({ sessionId: id, update }) =>
      id === sessionId && update.sessionUpdate === 'session_info_update' ? [update.title] : []);
  }

  it('serves archive, unarchive, and set_title through the v1 app', async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agent = v1Client()
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params as RecordedUpdate);
      })
      .connect(v1Stream(clientToAgent.writable, agentToClient.readable)).agent;
    createAgentApp(createAgent).app.connect(v1Stream(agentToClient.writable, clientToAgent.readable));

    const init = await agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({ archive: {}, title: {} });

    const { sessionId } = await agent.request(methods.agent.session.new, { cwd: '/tmp/project', mcpServers: [] });
    await expect(agent.request(methods.agent.session.archive, { sessionId })).rejects.toMatchObject({ code: -32602 });
    expect(await agent.request(methods.agent.session.setTitle, { sessionId, title: ' Before thread ' }))
      .toEqual({ title: 'Before thread' });
    expect(titleUpdates(sessionId)).toEqual(['Before thread']);

    await agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    await agent.request(methods.agent.session.archive, { sessionId });
    expect((await agent.request(methods.agent.session.list, {})).sessions).toEqual([]);

    await agent.request(methods.agent.session.unarchive, { sessionId });
    expect((await agent.request(methods.agent.session.list, {})).sessions).toMatchObject([
      { sessionId, title: 'Before thread', archived: false },
    ]);
    expect(archived).toEqual([true, false]);
    expect(renamed).toEqual([]);
  });

  it('serves archive, unarchive, and set_title through the v2 bridge', async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const agent = v2Client()
      .onNotification(CLIENT_METHODS.session_update, ({ params }) => {
        updates.push(params as RecordedUpdate);
      })
      .connect(v2Stream(clientToAgent.writable, agentToClient.readable)).agent;
    new AcpV2Adapter(createAgent).connect(v2Stream(agentToClient.writable, clientToAgent.readable));

    const init = await agent.request(AGENT_METHODS.initialize, {
      protocolVersion: 2,
      info: { name: 'v2-test', version: '0.0.0' },
      capabilities: {},
    });
    expect(init.capabilities?.session).toMatchObject({ archive: {}, title: {} });

    const { sessionId } = await agent.request(AGENT_METHODS.session_new, { cwd: '/tmp/project', mcpServers: [] });
    await agent.request(AGENT_METHODS.session_prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    while (!updates.some(({ update }) => update.sessionUpdate === 'state_update' && update.state === 'idle')) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(await agent.request(AGENT_METHODS.session_set_title, { sessionId, title: 'Renamed' }))
      .toEqual({ title: 'Renamed' });
    expect(renamed).toEqual(['Renamed']);
    expect(titleUpdates(sessionId).at(-1)).toBe('Renamed');

    await agent.request(AGENT_METHODS.session_archive, { sessionId });
    expect((await agent.request(AGENT_METHODS.session_list, { archived: 'only' })).sessions).toMatchObject([
      { sessionId, title: 'Renamed', archived: true },
    ]);

    await agent.request(AGENT_METHODS.session_unarchive, { sessionId });
    expect((await agent.request(AGENT_METHODS.session_list, {})).sessions).toMatchObject([
      { sessionId, archived: false },
    ]);
    expect(archived).toEqual([true, false]);
  });
});
