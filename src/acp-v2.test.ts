import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  client,
  ndJsonStream,
} from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type * as v2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AcpClient } from './acp-client.js';
import { AcpV2Adapter, toAcpV2Update } from './acp-v2.js';
import type { AmpStreamMessage, AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';
import type { ExportedThreadMessage } from './thread-history.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';

describe('toAcpV2Update', () => {
  test('translates v1 plan into a v2 plan_update', () => {
    const update = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect the repo', priority: 'high', status: 'completed' },
        { content: 'Add the adapter', priority: 'medium', status: 'in_progress' },
      ],
    } as SessionUpdate;

    expect(toAcpV2Update(update)).toEqual({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        planId: 'amp-plan',
        entries: [
          { content: 'Inspect the repo', priority: 'high', status: 'completed' },
          { content: 'Add the adapter', priority: 'medium', status: 'in_progress' },
        ],
      },
    });
  });

  test('translates v1 tool_call into a v2 tool_call_update', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Edit README.md',
      kind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: '/tmp/README.md', newText: 'hello' }],
      rawInput: { path: '/tmp/README.md' },
    } as SessionUpdate;

    expect(toAcpV2Update(update)).toEqual({
      ...update,
      sessionUpdate: 'tool_call_update',
    });
  });

  test('renames config option id to configId in config_option_update', () => {
    const update = {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'smart',
          options: [{ value: 'smart', name: 'Smart' }],
        },
      ],
    } as SessionUpdate;

    expect(toAcpV2Update(update)).toEqual({
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          configId: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'smart',
          options: [{ value: 'smart', name: 'Smart' }],
        },
      ],
    });
  });

  test('passes through updates shared by both protocol versions', () => {
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    } as SessionUpdate;

    expect(toAcpV2Update(update)).toBe(update);
  });
});

const THREAD_ID = 'T-01234567-89ab-cdef-0123-456789abcdef';
const HISTORY: ExportedThreadMessage[] = [
  { role: 'user', protocolMessageID: 'msg-user', content: [{ type: 'text', text: 'Fix the bug' }] },
  {
    role: 'assistant',
    protocolMessageID: 'msg-agent',
    content: [
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/a.ts' } },
    ],
  },
];

type TurnBehavior = 'complete' | 'block' | { fail: string };

describe('AcpV2Adapter', () => {
  let stateDir: string;
  let store: FileThreadMappingStore;
  let behavior: TurnBehavior;
  let closedProcesses: string[];
  let updates: v2.SessionNotification[];
  let agent: ReturnType<typeof connect>;

  const transport: AmpTransport = {
    name: 'cli',
    async *execute({ signal }): AsyncIterable<AmpStreamMessage> {
      yield { type: 'system', subtype: 'init', session_id: THREAD_ID };
      if (typeof behavior === 'object') throw new Error(behavior.fail);
      if (behavior === 'block') {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        return;
      }
      yield {
        type: 'assistant',
        message: { id: 'msg-done', content: [{ type: 'text', text: 'done' }] } as AmpStreamMessage['message'],
      };
      yield { type: 'result', subtype: 'success', is_error: false };
    },
    closeSession: (sessionId) => {
      closedProcesses.push(sessionId);
    },
  };

  function connect() {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = client()
      .onNotification(CLIENT_METHODS.session_update, ({ params }) => {
        updates.push(params);
      })
      .connect(ndJsonStream(clientToAgent.writable, agentToClient.readable));
    new AcpV2Adapter((acpClient: AcpClient) => new AmpAcpAgent(acpClient, transport, {
      orbTransport: transport,
      threadStore: store,
      exportThread: async () => ({ messages: HISTORY, title: 'Fix the bug' }),
      replayRetry: { attempts: 1, delayMs: 0 },
      discoverPluginModes: () => [],
      discoverModels: () => [],
    })).connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return connection.agent;
  }

  function sessionUpdates(sessionId: string): v2.SessionUpdate[] {
    return updates
      .filter((notification) => notification.sessionId === sessionId)
      .map((notification) => notification.update)
      .filter((update) => update.sessionUpdate !== 'available_commands_update');
  }

  function stateUpdates(sessionId: string): v2.SessionUpdate[] {
    return sessionUpdates(sessionId).filter((update) => update.sessionUpdate === 'state_update');
  }

  async function waitForState(sessionId: string, state: string): Promise<v2.SessionUpdate> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const match = stateUpdates(sessionId).find((update) => 'state' in update && update.state === state);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${state} state`);
  }

  async function newSession(): Promise<string> {
    const session = await agent.request(AGENT_METHODS.session_new, { cwd: '/tmp', mcpServers: [] });
    return session.sessionId;
  }

  async function startBlockedTurn(sessionId: string): Promise<void> {
    behavior = 'block';
    await agent.request(AGENT_METHODS.session_prompt, { sessionId, prompt: [{ type: 'text', text: 'wait' }] });
    await waitForState(sessionId, 'running');
  }

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-v2-'));
    store = new FileThreadMappingStore(stateDir);
    behavior = 'complete';
    closedProcesses = [];
    updates = [];
    agent = connect();
    await agent.request(AGENT_METHODS.initialize, {
      protocolVersion: 2,
      info: { name: 'v2-test', version: '0.0.0' },
      capabilities: {},
    });
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('advertises session/delete', async () => {
    const response = await agent.request(AGENT_METHODS.initialize, {
      protocolVersion: 2,
      info: { name: 'v2-test', version: '0.0.0' },
      capabilities: {},
    });
    expect(response.capabilities?.session?.delete).toEqual({});
  });

  test('replays history from the start and reports idle before the resume response', async () => {
    const sessionId = 'S-replay-000001';
    await store.save({ sessionId, threadId: THREAD_ID, cwd: '/tmp', title: 'Old title' });

    await agent.request(AGENT_METHODS.session_resume, {
      sessionId,
      cwd: '/tmp',
      mcpServers: [],
      replayFrom: { type: 'start' },
    });

    expect(sessionUpdates(sessionId)).toEqual([
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'msg-user',
        content: { type: 'text', text: 'Fix the bug' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-agent',
        content: { type: 'text', text: 'Reading the file.' },
      },
      expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', kind: 'read' }),
      { sessionUpdate: 'session_info_update', title: 'Fix the bug' },
      { sessionUpdate: 'state_update', state: 'idle' },
    ]);
  });

  test.each([{}, { replayFrom: null }])('resumes without replay for %j', async (replay) => {
    const sessionId = 'S-noreplay-000001';
    await store.save({ sessionId, threadId: THREAD_ID, cwd: '/tmp', title: 'Kept title' });

    await agent.request(AGENT_METHODS.session_resume, { sessionId, cwd: '/tmp', mcpServers: [], ...replay });

    expect(sessionUpdates(sessionId)).toEqual([
      { sessionUpdate: 'session_info_update', title: 'Kept title' },
      { sessionUpdate: 'state_update', state: 'idle' },
    ]);
  });

  test.each([{ type: '_amp/turn', turn: 3 }, { type: 'message', messageId: 'msg-user' }])(
    'rejects replay cursor %j with -32602',
    async (replayFrom) => {
      const sessionId = 'S-badcursor-000001';
      await store.save({ sessionId, threadId: THREAD_ID, cwd: '/tmp' });

      await expect(agent.request(AGENT_METHODS.session_resume, {
        sessionId,
        cwd: '/tmp',
        mcpServers: [],
        replayFrom: replayFrom as v2.ReplayFrom,
      })).rejects.toMatchObject({ code: -32602 });
      expect(sessionUpdates(sessionId)).toEqual([]);
    },
  );

  test('reports running when a session is resumed during a turn', async () => {
    const sessionId = await newSession();
    await startBlockedTurn(sessionId);

    await agent.request(AGENT_METHODS.session_resume, { sessionId, cwd: '/tmp', mcpServers: [] });
    expect(stateUpdates(sessionId).at(-1)).toEqual({ sessionUpdate: 'state_update', state: 'running' });

    // The resumed session still owns the turn, so close can cancel it.
    await agent.request(AGENT_METHODS.session_close, { sessionId });
    expect(stateUpdates(sessionId).at(-1)).toMatchObject({ state: 'idle', stopReason: 'cancelled' });
  });

  test('close cancels the turn, sends its idle update first, and closes the CLI process', async () => {
    const sessionId = await newSession();
    await startBlockedTurn(sessionId);

    await agent.request(AGENT_METHODS.session_close, { sessionId });

    expect(stateUpdates(sessionId).at(-1)).toMatchObject({ state: 'idle', stopReason: 'cancelled' });
    expect(closedProcesses).toEqual([sessionId]);
  });

  test.each([
    { fail: 'amp exploded', code: -32603, message: 'Internal error: amp exploded' },
    { fail: 'Invalid or missing API key', code: -32000, message: 'Authentication required' },
  ])('reports a failed turn as an error with code $code', async ({ fail, code, message }) => {
    const sessionId = await newSession();
    behavior = { fail };

    await agent.request(AGENT_METHODS.session_prompt, { sessionId, prompt: [{ type: 'text', text: 'boom' }] });

    expect(await waitForState(sessionId, 'idle')).toEqual({
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'error',
      error: { code, message },
    });
    expect(updates.filter(({ update }) => update.sessionUpdate === 'notice')).toEqual([]);
  });

  test('deletes a session, its mapping, and its CLI process', async () => {
    const sessionId = await newSession();
    await agent.request(AGENT_METHODS.session_prompt, { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    await waitForState(sessionId, 'idle');

    await agent.request(AGENT_METHODS.session_delete, { sessionId });

    expect(closedProcesses).toEqual([sessionId]);
    expect(await store.load(sessionId)).toBeNull();
    expect((await agent.request(AGENT_METHODS.session_list, {})).sessions).toEqual([]);
  });
});
