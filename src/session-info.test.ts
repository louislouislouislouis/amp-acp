import type { AcpClient } from './acp-client.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SessionNotification } from '@agentclientprotocol/sdk/unstable';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AmpStreamMessage, AmpTransport } from './amp-transport.js';
import { AmpAcpAgent } from './server.js';
import type { ExportedThreadMessage } from './thread-history.js';

const threadId = 'T-01234567-89ab-cdef-0123-456789abcdef';
const MESSAGE: ExportedThreadMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
};

function createTransport(): AmpTransport {
  return {
    name: 'cli',
    async *execute(): AsyncIterable<AmpStreamMessage> {
      yield { type: 'system', subtype: 'init', session_id: threadId };
      yield { type: 'result', subtype: 'success', is_error: false };
    },
  };
}

function createClient(updates: SessionNotification[]): AcpClient {
  return {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    readTextFile: async () => ({ text: '' }),
    writeTextFile: async () => ({}),
    requestPermission: async () => ({ optionId: '' }),
    createTerminal: async () => ({ id: '' }),
    extMethod: async () => ({}),
    extNotification: async () => {},
  } as unknown as AcpClient;
}

function sessionInfoUpdates(updates: SessionNotification[]) {
  return updates.flatMap((notification) => {
    const update = notification.update;
    return update.sessionUpdate === 'session_info_update' ? [update] : [];
  });
}

describe('session title and updatedAt', () => {
  let stateDir: string;
  let updates: SessionNotification[];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-state-'));
    process.env.AMP_ACP_STATE_DIR = stateDir;
    updates = [];
  });

  afterEach(() => {
    delete process.env.AMP_ACP_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function createAgent(exportThread = async () => [MESSAGE]) {
    return new AmpAcpAgent(createClient(updates), createTransport(), {
      exportThread,
      replayRetry: { attempts: 1, delayMs: 0 },
      discoverPluginModes: () => [],
      discoverModels: () => [],
    });
  }

  it('derives a title from the first prompt and updates it on later turns', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '  Fix   the\nlogin bug  ' }],
    });

    const first = sessionInfoUpdates(updates);
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toBe('Fix the login bug');
    expect(first[0]!.updatedAt).toBeString();
    expect(new Date(first[0]!.updatedAt!).toISOString()).toBe(first[0]!.updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Now add a test' }],
    });

    const second = sessionInfoUpdates(updates);
    expect(second).toHaveLength(2);
    expect(second[1]!.title).toBe('Fix the login bug');
    expect(second[1]!.updatedAt).not.toBe(first[0]!.updatedAt);
  });

  it('truncates a long first prompt to 60 characters', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'x'.repeat(80) }],
    });

    expect(sessionInfoUpdates(updates)[0]!.title).toHaveLength(60);
  });

  it.each([
    {
      name: 'one text block',
      prompt: [{
        type: 'text' as const,
        text: '<t3_code_instructions>\nUse the repo tools.\n</t3_code_instructions>\n\n<user_request>\n  Fix the\n login bug\n</user_request>',
      }],
      title: 'Fix the login bug',
    },
    {
      name: 'separate text blocks',
      prompt: [
        { type: 'text' as const, text: '<t3_code_instructions>Use the repo tools.</t3_code_instructions>' },
        { type: 'text' as const, text: '<user_request>Add a test</user_request>' },
      ],
      title: 'Add a test',
    },
    {
      name: 'an empty request',
      prompt: [{ type: 'text' as const, text: '<t3_code_instructions>Rules</t3_code_instructions><user_request> </user_request>' }],
      title: 'Amp session',
    },
    {
      name: 'an unclosed tag',
      prompt: [{ type: 'text' as const, text: 'Explain <user_request> tags' }],
      title: 'Explain <user_request> tags',
    },
  ])('takes the title from the <user_request> block with $name', async ({ prompt, title }) => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await agent.prompt({ sessionId: session.sessionId, prompt });

    expect(sessionInfoUpdates(updates)[0]!.title).toBe(title);
  });

  it('uses a fallback title when the first turn has no text', async () => {
    const agent = createAgent();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    });

    expect(sessionInfoUpdates(updates)[0]!.title).toBe('Amp session');
  });

  it('restores the persisted title and timestamp on load', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Persist this title' }],
    });
    const persisted = sessionInfoUpdates(updates)[0]!;
    updates.length = 0;

    const second = createAgent();
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await second.loadSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });

    const restored = sessionInfoUpdates(updates);
    expect(restored.at(-1)?.title).toBe('Persist this title');
    expect(restored.at(-1)?.updatedAt).toBe(persisted.updatedAt);
  });

  it('prefers the title and timestamp exported by Amp', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Local title' }],
    });
    updates.length = 0;

    const second = createAgent(async () => ({
      messages: [MESSAGE],
      title: 'Amp exported title',
      updatedAt: '2026-10-31T12:00:00.000Z',
    }));
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await second.loadSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });

    const restored = sessionInfoUpdates(updates);
    expect(restored.at(-1)?.title).toBe('Amp exported title');
    expect(restored.at(-1)?.updatedAt).toBe('2026-10-31T12:00:00.000Z');
  });

  it('publishes the persisted title on resume', async () => {
    const first = createAgent();
    await first.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await first.newSession({ cwd: '/tmp', mcpServers: [] });
    await first.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Resume title' }],
    });
    updates.length = 0;

    const second = createAgent();
    await second.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await second.resumeSession({ sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] });

    expect(sessionInfoUpdates(updates).at(-1)?.title).toBe('Resume title');
  });
});
