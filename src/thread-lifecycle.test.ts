import type { AcpClient } from './acp-client.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SessionNotification } from '@agentclientprotocol/sdk/unstable';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AmpExecutionRequest, AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';

const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';

const client = {
  sessionUpdate: async () => {},
  readTextFile: async () => ({ text: '' }),
  writeTextFile: async () => ({}),
  requestPermission: async () => ({ optionId: '' }),
  createTerminal: async () => ({ id: '' }),
  extMethod: async () => ({}),
  extNotification: async () => {},
} as unknown as AcpClient;

function transportWithThread(requests: AmpExecutionRequest[]): AmpTransport {
  return {
    name: 'cli',
    execute(request) {
      requests.push(request);
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      })();
    },
  };
}

describe('Amp ACP thread lifecycle extension', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-lifecycle-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('exposes and persists the streamed Amp thread ID separately from the ACP session ID', async () => {
    const requests: AmpExecutionRequest[] = [];
    const store = new FileThreadMappingStore(stateDir);
    const agent = new AmpAcpAgent(client, transportWithThread(requests), {
      threadStore: store,
      discoverPluginModes: () => [],
      discoverModels: () => [],
    });
    const initialized = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    expect(initialized.agentCapabilities?._meta?.['amp-acp/thread-lifecycle']).toEqual({
      version: 1,
      methods: {
        nativeMetadata: 'amp-acp/session/native-metadata',
        setArchived: 'amp-acp/thread/set-archived',
      },
    });
    expect(await agent.extMethod('amp-acp/session/native-metadata', {
      sessionId: session.sessionId,
    })).toEqual({ version: 1, sessionId: session.sessionId, ampThreadId: null });

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(session.sessionId).toMatch(/^S-/);
    expect(await agent.extMethod('amp-acp/session/native-metadata', {
      sessionId: session.sessionId,
    })).toEqual({ version: 1, sessionId: session.sessionId, ampThreadId: threadId });
    expect((await store.load(session.sessionId))?.threadId).toBe(threadId);
  });

  it('resumes the exact persisted Amp thread after an adapter restart', async () => {
    const store = new FileThreadMappingStore(stateDir);
    await store.save({
      sessionId: 'S-mrestart-abcdef',
      threadId,
    });
    const requests: AmpExecutionRequest[] = [];
    const restartedAgent = new AmpAcpAgent(client, transportWithThread(requests), {
      threadStore: store,
      discoverPluginModes: () => [],
      discoverModels: () => [],
    });

    await restartedAgent.resumeSession({
      sessionId: 'S-mrestart-abcdef',
      cwd: '/tmp/original',
      mcpServers: [],
    });
    await restartedAgent.prompt({
      sessionId: 'S-mrestart-abcdef',
      prompt: [{ type: 'text', text: 'continue' }],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.options.continue).toBe(threadId);
  });

  it('archives and unarchives only when both IDs match the persisted mapping', async () => {
    const store = new FileThreadMappingStore(stateDir);
    const sessionId = 'S-marchive-abcdef';
    await store.save({ sessionId, threadId });
    const operations: Array<{ threadId: string; archived: boolean }> = [];
    const agent = new AmpAcpAgent(client, transportWithThread([]), {
      threadStore: store,
      setThreadArchived: async (targetThreadId, archived) => {
        operations.push({ threadId: targetThreadId, archived });
      },
      discoverPluginModes: () => [],
      discoverModels: () => [],
    });

    expect(await agent.extMethod('amp-acp/thread/set-archived', {
      sessionId,
      threadId,
      archived: true,
    })).toEqual({ version: 1, threadId, archived: true });
    expect((await store.load(sessionId))?.archived).toBe(true);
    expect(await agent.extMethod('amp-acp/thread/set-archived', {
      sessionId,
      threadId,
      archived: false,
    })).toEqual({ version: 1, threadId, archived: false });
    expect((await store.load(sessionId))?.archived).toBeUndefined();
    expect(operations).toEqual([
      { threadId, archived: true },
      { threadId, archived: false },
    ]);

    await expect(agent.extMethod('amp-acp/thread/set-archived', {
      sessionId,
      threadId: 'T-11a03c00-e608-7007-8181-5c1cc56757be',
      archived: true,
    })).rejects.toThrow('does not match');
    expect(operations).toHaveLength(2);
  });

  it('does not archive a legacy ACP session with no durable mapping', async () => {
    const operations: string[] = [];
    const agent = new AmpAcpAgent(client, transportWithThread([]), {
      threadStore: new FileThreadMappingStore(stateDir),
      setThreadArchived: async (targetThreadId) => {
        operations.push(targetThreadId);
      },
      discoverPluginModes: () => [],
      discoverModels: () => [],
    });

    await expect(agent.extMethod('amp-acp/thread/set-archived', {
      sessionId: 'S-mlegacy-abcdef',
      threadId,
      archived: true,
    })).rejects.toThrow('No durable Amp thread mapping');
    expect(operations).toEqual([]);
  });
});

describe('ACP session archive and title', () => {
  let stateDir: string;
  let store: FileThreadMappingStore;
  let requests: AmpExecutionRequest[];
  let archived: Array<{ threadId: string; archived: boolean }>;
  let renamed: Array<{ threadId: string; title: string }>;
  let closed: string[];
  let updates: SessionNotification[];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-archive-'));
    store = new FileThreadMappingStore(stateDir);
    requests = [];
    archived = [];
    renamed = [];
    closed = [];
    updates = [];
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function createAgent(transport: AmpTransport = transportWithThread(requests)) {
    const recordingClient: AcpClient = {
      sessionUpdate: async (notification) => {
        updates.push(notification);
      },
      notify: async () => {},
    };
    return new AmpAcpAgent(recordingClient, { ...transport, closeSession: (sessionId) => closed.push(sessionId) }, {
      threadStore: store,
      setThreadArchived: async (targetThreadId, value) => {
        archived.push({ threadId: targetThreadId, archived: value });
      },
      renameThread: async (targetThreadId, title) => {
        renamed.push({ threadId: targetThreadId, title });
      },
      discoverPluginModes: () => [],
      discoverModels: () => [],
    });
  }

  async function sessionWithThread(agent: AmpAcpAgent): Promise<string> {
    const session = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] });
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    return session.sessionId;
  }

  function titleUpdates(sessionId: string): unknown[] {
    return updates.flatMap((notification) =>
      notification.sessionId === sessionId && notification.update.sessionUpdate === 'session_info_update'
        ? [notification.update.title]
        : []);
  }

  it('closes a live session, archives its thread, and hides it from the default list', async () => {
    const agent = createAgent();
    const sessionId = await sessionWithThread(agent);

    await agent.archiveSession({ sessionId });
    await agent.archiveSession({ sessionId });

    expect(archived).toEqual([{ threadId, archived: true }, { threadId, archived: true }]);
    expect(closed).toEqual([sessionId]);
    expect(agent.sessions.has(sessionId)).toBe(false);
    expect((await agent.listSessions({})).sessions).toEqual([]);
    expect((await agent.listSessions({ archived: 'only' })).sessions).toMatchObject([{ sessionId, archived: true }]);
    expect((await agent.listSessions({ archived: 'include' })).sessions).toHaveLength(1);

    await agent.unarchiveSession({ sessionId });

    expect(archived.at(-1)).toEqual({ threadId, archived: false });
    expect(agent.sessions.has(sessionId)).toBe(false);
    expect((await agent.listSessions({})).sessions).toMatchObject([{ sessionId, archived: false }]);
    expect((await agent.listSessions({ archived: 'only' })).sessions).toEqual([]);
  });

  it('keeps the archived flag when the cancelled turn finishes after archive', async () => {
    let started!: () => void;
    const turnStarted = new Promise<void>((resolve) => { started = resolve; });
    const agent = createAgent({
      name: 'cli',
      async *execute({ signal }) {
        yield { type: 'system', subtype: 'init', session_id: threadId };
        started();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        // Unwind after archive returns, so the turn's final persist comes last.
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    const session = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'work' }] });
    await turnStarted;

    await agent.archiveSession({ sessionId: session.sessionId });

    expect(await turn).toEqual({ stopReason: 'cancelled' });
    expect((await store.load(session.sessionId))?.archived).toBe(true);
  });

  it('rejects archive and unarchive with -32602 before Amp creates a thread', async () => {
    const agent = createAgent();
    const session = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    await expect(agent.archiveSession({ sessionId: session.sessionId })).rejects.toMatchObject({ code: -32602 });
    await expect(agent.unarchiveSession({ sessionId: session.sessionId })).rejects.toMatchObject({ code: -32602 });
    expect(archived).toEqual([]);
    expect(agent.sessions.has(session.sessionId)).toBe(true);
  });

  it.each(['S-munknown-abcdef', 'not-a-session'])('returns -32002 for unknown session %s', async (sessionId) => {
    const agent = createAgent();

    await expect(agent.archiveSession({ sessionId })).rejects.toMatchObject({ code: -32002 });
    await expect(agent.unarchiveSession({ sessionId })).rejects.toMatchObject({ code: -32002 });
    await expect(agent.setSessionTitle({ sessionId, title: 'Title' })).rejects.toMatchObject({ code: -32002 });
  });

  it('rejects an unsupported archived filter', async () => {
    const agent = createAgent();

    await expect(agent.listSessions({ archived: 'later' })).rejects.toMatchObject({ code: -32602 });
  });

  it('renames the Amp thread, stores the normalized title, and publishes it', async () => {
    const agent = createAgent();
    const sessionId = await sessionWithThread(agent);

    expect(await agent.setSessionTitle({ sessionId, title: '  Fix   the\n login bug ' }))
      .toEqual({ title: 'Fix the login bug' });

    expect(renamed).toEqual([{ threadId, title: 'Fix the login bug' }]);
    expect((await store.load(sessionId))?.title).toBe('Fix the login bug');
    expect(titleUpdates(sessionId).at(-1)).toBe('Fix the login bug');

    await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'next turn' }] });
    expect(requests.at(-1)?.options.title).toBeUndefined();
    expect((await store.load(sessionId))?.title).toBe('Fix the login bug');
  });

  it('passes a title set before the first turn to Amp as --title', async () => {
    const agent = createAgent();
    const session = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    await agent.setSessionTitle({ sessionId: session.sessionId, title: 'Planned work' });
    expect(renamed).toEqual([]);
    expect(await store.load(session.sessionId)).toMatchObject({ title: 'Planned work', titlePending: true });
    expect(titleUpdates(session.sessionId)).toEqual(['Planned work']);

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'start' }] });

    expect(requests[0]?.options.title).toBe('Planned work');
    expect(renamed).toEqual([]);
    const stored = await store.load(session.sessionId);
    expect(stored).toMatchObject({ threadId, title: 'Planned work' });
    expect(stored?.titlePending).toBeUndefined();
  });

  it('renames the new thread when the title arrives during the first turn', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const agent = createAgent({
      name: 'cli',
      async *execute(request) {
        requests.push(request);
        await released;
        yield { type: 'system', subtype: 'init', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      },
    });
    const session = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'start' }] });
    while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));

    await agent.setSessionTitle({ sessionId: session.sessionId, title: 'Late title' });
    release();
    await turn;

    expect(requests[0]?.options.title).toBeUndefined();
    expect(renamed).toEqual([{ threadId, title: 'Late title' }]);
    expect((await store.load(session.sessionId))?.titlePending).toBeUndefined();
  });

  it('retitles stored sessions that are not loaded, without sending updates', async () => {
    await store.save({ sessionId: 'S-mstored-abcdef', threadId, cwd: '/tmp/project' });
    await store.save({ sessionId: 'S-mnothrd-abcdef', threadId: null, cwd: '/tmp/project' });
    const agent = createAgent();

    await agent.setSessionTitle({ sessionId: 'S-mstored-abcdef', title: 'Stored' });
    await agent.setSessionTitle({ sessionId: 'S-mnothrd-abcdef', title: 'Not started' });

    expect(renamed).toEqual([{ threadId, title: 'Stored' }]);
    expect(await store.load('S-mstored-abcdef')).toMatchObject({ title: 'Stored' });
    expect((await store.load('S-mstored-abcdef'))?.titlePending).toBeUndefined();
    expect(await store.load('S-mnothrd-abcdef')).toMatchObject({ title: 'Not started', titlePending: true });
    expect(updates).toEqual([]);

    await agent.resumeSession({ sessionId: 'S-mnothrd-abcdef', cwd: '/tmp/project', mcpServers: [] });
    await agent.prompt({ sessionId: 'S-mnothrd-abcdef', prompt: [{ type: 'text', text: 'go' }] });
    expect(requests.at(-1)?.options.title).toBe('Not started');
  });

  it('rejects a title that is empty after normalization', async () => {
    const agent = createAgent();
    const session = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    await expect(agent.setSessionTitle({ sessionId: session.sessionId, title: ' \n ' }))
      .rejects.toMatchObject({ code: -32602 });
  });
});
