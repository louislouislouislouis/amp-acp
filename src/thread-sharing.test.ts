import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AcpClient } from './acp-client.js';
import type {
  AmpExecutionRequest,
  AmpMultiplayerSetting,
  AmpThreadVisibility,
  AmpTransport,
} from './amp-transport.js';
import { AmpAcpAgent } from './server.js';
import { FileThreadMappingStore } from './thread-mapping-store.js';
import type { ExportedThread } from './thread-history.js';
import {
  parseCollaborationCommand,
  parseMultiplayerArgument,
  parseShareArgument,
  visibilityFromAmp,
} from './thread-sharing.js';

const threadId = 'T-01a03c00-e608-7007-8181-5c1cc56757be';
const threadUrl = `https://ampcode.com/threads/${threadId}`;

const text = (value: string) => [{ type: 'text' as const, text: value }];

describe('collaboration command parsing', () => {
  it('matches only a bare command with at most one word', () => {
    expect(parseCollaborationCommand(text('/share'))).toEqual({ name: 'share' });
    expect(parseCollaborationCommand(text('  /share workspace \n'))).toEqual({ name: 'share', arg: 'workspace' });
    expect(parseCollaborationCommand(text('/link'))).toEqual({ name: 'link' });
    expect(parseCollaborationCommand(text('/multiplayer 2h'))).toEqual({ name: 'multiplayer', arg: '2h' });
    expect(parseCollaborationCommand(text('/share workspace please'))).toBeNull();
    expect(parseCollaborationCommand(text('/sharepoint'))).toBeNull();
    expect(parseCollaborationCommand(text('please /link'))).toBeNull();
    expect(parseCollaborationCommand([
      ...text('/link'),
      { type: 'resource_link', uri: 'file:///tmp/a.ts', name: 'a.ts' },
    ])).toBeNull();
  });

  it('maps share words to Amp visibility levels', () => {
    expect(parseShareArgument(undefined)).toBe('workspace');
    expect(parseShareArgument('Link')).toBe('unlisted');
    expect(parseShareArgument('public')).toBe('unlisted');
    expect(parseShareArgument('group')).toBe('group');
    expect(parseShareArgument('private')).toBe('private');
    expect(parseShareArgument('everyone')).toBeNull();
  });

  it('accepts multiplayer windows from 5 minutes to 7 days', () => {
    expect(parseMultiplayerArgument(undefined)).toEqual({ enabled: true });
    expect(parseMultiplayerArgument('OFF')).toEqual({ enabled: false });
    expect(parseMultiplayerArgument('5m')).toEqual({ enabled: true, duration: { unit: 'minutes', value: 5 } });
    expect(parseMultiplayerArgument('7d')).toEqual({ enabled: true, duration: { unit: 'days', value: 7 } });
    expect(parseMultiplayerArgument('1w')).toEqual({ enabled: true, duration: { unit: 'weeks', value: 1 } });
    expect(parseMultiplayerArgument('4m')).toBeNull();
    expect(parseMultiplayerArgument('8d')).toBeNull();
    expect(parseMultiplayerArgument('soon')).toBeNull();
  });

  it('reads Amp export visibility values', () => {
    expect(visibilityFromAmp('workspace')).toBe('workspace');
    expect(visibilityFromAmp('public')).toBe('unlisted');
    expect(visibilityFromAmp('default')).toBeUndefined();
    expect(visibilityFromAmp('secret')).toBeUndefined();
    expect(visibilityFromAmp(undefined)).toBeUndefined();
  });
});

interface Harness {
  agent: AmpAcpAgent;
  store: FileThreadMappingStore;
  updates: SessionNotification['update'][];
  localRequests: AmpExecutionRequest[];
  orbRequests: AmpExecutionRequest[];
  shares: Array<{ threadId: string; visibility: AmpThreadVisibility }>;
  multiplayer: Array<{ threadId: string; setting: AmpMultiplayerSetting }>;
}

function fakeTransport(name: 'cli' | 'sdk', requests: AmpExecutionRequest[]): AmpTransport {
  return {
    name,
    execute(request) {
      requests.push(request);
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: threadId };
        yield { type: 'result', subtype: 'success', is_error: false };
      })();
    },
  };
}

function replies(updates: SessionNotification['update'][]): string[] {
  return updates.flatMap((update) => (
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
  ));
}

function lastVisibility(updates: SessionNotification['update'][]): unknown {
  const update = updates.findLast((candidate) => candidate.sessionUpdate === 'config_option_update');
  if (update?.sessionUpdate !== 'config_option_update') return undefined;
  return update.configOptions.find((option) => option.id === 'thread-visibility')?.currentValue;
}

describe('thread sharing in the ACP agent', () => {
  let stateDir: string;
  let h: Harness;
  let shareFailure: Error | null;
  let exported: ExportedThread;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-sharing-'));
    shareFailure = null;
    exported = { messages: [] };
    const updates: SessionNotification['update'][] = [];
    const client: AcpClient = {
      sessionUpdate: async (notification) => {
        updates.push(notification.update);
      },
      notify: async () => {},
    };
    const localRequests: AmpExecutionRequest[] = [];
    const orbRequests: AmpExecutionRequest[] = [];
    const shares: Harness['shares'] = [];
    const multiplayer: Harness['multiplayer'] = [];
    const store = new FileThreadMappingStore(stateDir);
    const agent = new AmpAcpAgent(client, fakeTransport('cli', localRequests), {
      threadStore: store,
      orbTransport: fakeTransport('sdk', orbRequests),
      setThreadVisibility: async (id, visibility) => {
        if (shareFailure) throw shareFailure;
        shares.push({ threadId: id, visibility });
        return '';
      },
      setThreadMultiplayer: async (id, setting) => {
        multiplayer.push({ threadId: id, setting });
        return '';
      },
      exportThread: async () => exported,
      replayRetry: { attempts: 1, delayMs: 0 },
      discoverPluginModes: () => [],
      discoverModels: () => [],
    });
    await agent.initialize({ protocolVersion: 1, clientCapabilities: { session: { notices: {} } } });
    h = { agent, store, updates, localRequests, orbRequests, shares, multiplayer };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  async function sessionWithThread(executor: 'local' | 'orb' = 'local'): Promise<string> {
    const { sessionId } = await h.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });
    if (executor === 'orb') {
      await h.agent.setSessionConfigOption({ sessionId, configId: 'execution-environment', value: 'orb' });
    }
    await h.agent.prompt({ sessionId, prompt: text('hello') });
    h.updates.length = 0;
    return sessionId;
  }

  it('starts on Amp default visibility and sends no creation flag', async () => {
    const session = await h.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });
    expect(session.configOptions?.find((option) => option.id === 'thread-visibility')).toMatchObject({
      currentValue: 'default',
      options: [
        { value: 'default' },
        { value: 'private' },
        { value: 'workspace' },
        { value: 'group' },
        { value: 'unlisted', name: 'Link' },
      ],
    });
    await h.agent.prompt({ sessionId: session.sessionId, prompt: text('hello') });
    expect(h.localRequests[0]?.options.visibility).toBeUndefined();
  });

  it('creates the thread with the chosen visibility, then never resends it', async () => {
    const { sessionId } = await h.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });
    await h.agent.setSessionConfigOption({ sessionId, configId: 'thread-visibility', value: 'workspace' });
    expect((await h.store.load(sessionId))?.visibility).toBe('workspace');

    await h.agent.prompt({ sessionId, prompt: text('first') });
    await h.agent.prompt({ sessionId, prompt: text('second') });

    expect(h.localRequests.map((request) => request.options.visibility)).toEqual(['workspace', undefined]);
    expect(h.localRequests[1]?.options.continue).toBe(threadId);
    expect(h.shares).toEqual([]);
  });

  it('shares an existing thread through Amp and persists the result', async () => {
    const sessionId = await sessionWithThread();

    const response = await h.agent.setSessionConfigOption({
      sessionId,
      configId: 'thread-visibility',
      value: 'group',
    });

    expect(h.shares).toEqual([{ threadId, visibility: 'group' }]);
    expect(response.configOptions.find((option) => option.id === 'thread-visibility')?.currentValue).toBe('group');
    expect(lastVisibility(h.updates)).toBe('group');
    expect((await h.store.load(sessionId))?.visibility).toBe('group');
  });

  it('keeps the old visibility and reports the error when Amp refuses', async () => {
    const sessionId = await sessionWithThread();
    shareFailure = new Error('Amp CLI process exited with code 1: not allowed');

    await expect(h.agent.setSessionConfigOption({
      sessionId,
      configId: 'thread-visibility',
      value: 'workspace',
    })).rejects.toThrow('not allowed');

    expect(lastVisibility(h.updates)).toBe('default');
    expect(h.updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'notice',
      severity: 'error',
      title: 'Could not change thread visibility',
    }));
    expect((await h.store.load(sessionId))?.visibility).toBeUndefined();
  });

  it('refuses Amp default once the thread exists', async () => {
    const sessionId = await sessionWithThread();
    await h.agent.setSessionConfigOption({ sessionId, configId: 'thread-visibility', value: 'private' });

    await expect(h.agent.setSessionConfigOption({
      sessionId,
      configId: 'thread-visibility',
      value: 'default',
    })).rejects.toThrow('already exists');
    expect(h.shares).toEqual([{ threadId, visibility: 'private' }]);
  });

  it('restores the saved visibility on resume and prefers Amp on load', async () => {
    await h.store.save({ sessionId: 'S-mshare-abcdef', threadId, visibility: 'unlisted' });
    const resumed = await h.agent.resumeSession({ sessionId: 'S-mshare-abcdef', cwd: '/tmp/project', mcpServers: [] });
    expect(resumed.configOptions?.find((option) => option.id === 'thread-visibility')?.currentValue).toBe('unlisted');

    h.agent.sessions.clear();
    exported = { messages: [], visibility: 'workspace' };
    const loaded = await h.agent.loadSession({ sessionId: 'S-mshare-abcdef', cwd: '/tmp/project', mcpServers: [] });
    expect(loaded.configOptions?.find((option) => option.id === 'thread-visibility')?.currentValue).toBe('workspace');
    expect((await h.store.load('S-mshare-abcdef'))?.visibility).toBe('workspace');
  });

  it('answers /link without an Amp turn', async () => {
    const { sessionId } = await h.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    const early = await h.agent.prompt({ sessionId, prompt: text('/link') });
    expect(early.stopReason).toBe('end_turn');
    expect(replies(h.updates).at(-1)).toContain('No Amp thread yet');

    await h.agent.prompt({ sessionId, prompt: text('hello') });
    await h.agent.prompt({ sessionId, prompt: text('/link') });

    expect(replies(h.updates).at(-1)).toBe(`${threadUrl}\nVisibility: Amp default`);
    expect(h.localRequests).toHaveLength(1);
  });

  it('shares with /share and posts the link', async () => {
    const sessionId = await sessionWithThread();

    await h.agent.prompt({ sessionId, prompt: text('/share link') });

    expect(h.shares).toEqual([{ threadId, visibility: 'unlisted' }]);
    expect(replies(h.updates)).toEqual([`Visibility: Link\n${threadUrl}`]);
    expect(lastVisibility(h.updates)).toBe('unlisted');
    expect(h.localRequests).toHaveLength(1);
  });

  it('records /share as the creation visibility before the thread exists', async () => {
    const { sessionId } = await h.agent.newSession({ cwd: '/tmp/project', mcpServers: [] });

    await h.agent.prompt({ sessionId, prompt: text('/share') });
    await h.agent.prompt({ sessionId, prompt: text('first') });

    expect(replies(h.updates)[0]).toContain('No Amp thread yet');
    expect(h.shares).toEqual([]);
    expect(h.localRequests).toHaveLength(1);
    expect(h.localRequests[0]?.options.visibility).toBe('workspace');
  });

  it('reports /share errors and unknown levels in the chat', async () => {
    const sessionId = await sessionWithThread();

    await h.agent.prompt({ sessionId, prompt: text('/share everyone') });
    shareFailure = new Error('Amp CLI process exited with code 1: group not found');
    await h.agent.prompt({ sessionId, prompt: text('/share group') });

    expect(replies(h.updates)).toEqual([
      'Unknown visibility "everyone". Use /share private, workspace, group, or link.',
      'Could not share the thread: Amp CLI process exited with code 1: group not found\nVisibility stays Amp default.',
    ]);
    expect(h.shares).toEqual([]);
  });

  it('passes longer /share text to Amp', async () => {
    const sessionId = await sessionWithThread();

    await h.agent.prompt({ sessionId, prompt: text('/share workspace and explain why') });

    expect(h.localRequests).toHaveLength(2);
    expect(h.shares).toEqual([]);
  });

  it('refuses /multiplayer outside an Orb', async () => {
    const sessionId = await sessionWithThread();

    await h.agent.prompt({ sessionId, prompt: text('/multiplayer') });

    expect(replies(h.updates).at(-1)).toContain('only on Orb threads');
    expect(h.multiplayer).toEqual([]);
  });

  it('refuses /multiplayer on a private Orb thread', async () => {
    const sessionId = await sessionWithThread('orb');
    exported = { messages: [], visibility: 'private' };

    await h.agent.prompt({ sessionId, prompt: text('/multiplayer') });

    expect(replies(h.updates).at(-1)).toContain('This thread is private');
    expect(lastVisibility(h.updates)).toBe('private');
    expect(h.multiplayer).toEqual([]);
  });

  it('turns multiplayer on and off for a shared Orb thread', async () => {
    const sessionId = await sessionWithThread('orb');
    await h.agent.setSessionConfigOption({ sessionId, configId: 'thread-visibility', value: 'workspace' });

    await h.agent.prompt({ sessionId, prompt: text('/multiplayer 2h') });
    await h.agent.prompt({ sessionId, prompt: text('/multiplayer off') });

    expect(h.multiplayer).toEqual([
      { threadId, setting: { enabled: true, duration: { unit: 'hours', value: 2 } } },
      { threadId, setting: { enabled: false } },
    ]);
    expect(replies(h.updates)).toEqual([
      `Multiplayer is on for 2 hours.\n${threadUrl}`,
      `Multiplayer is off.\n${threadUrl}`,
    ]);
    expect(h.orbRequests).toHaveLength(1);
  });
});
