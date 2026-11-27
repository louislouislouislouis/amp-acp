import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const BINARY_PATH = path.resolve(__dirname, '../dist/amp-acp-test');
// Looks like Bun's placeholder, so the startup repair would overwrite it.
const PROJECT_CLI_STUB = '#!/bin/sh\n# Amp native binary not installed\ntouch "$(dirname "$0")/ran"\nexit 1\n';

let projectDir: string;
let projectCliBin: string;
let fakeAmpPath: string;

beforeAll(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'amp-acp-project-cli-'));

  const cliDir = path.join(projectDir, 'node_modules', '@ampcode', 'cli');
  await mkdir(path.join(cliDir, 'bin'), { recursive: true });
  await writeFile(path.join(cliDir, 'package.json'), JSON.stringify({
    name: '@ampcode/cli',
    version: '0.0.0',
    bin: { amp: 'bin/amp.exe' },
  }));
  projectCliBin = path.join(cliDir, 'bin', 'amp.exe');
  await writeFile(projectCliBin, PROJECT_CLI_STUB);
  await chmod(projectCliBin, 0o755);

  const nativePkg = `@ampcode/cli-${process.platform}-${process.arch}`;
  const nativeDir = path.join(projectDir, 'node_modules', nativePkg);
  await mkdir(nativeDir, { recursive: true });
  await writeFile(path.join(nativeDir, 'package.json'), JSON.stringify({ name: nativePkg, version: '0.0.0' }));
  await writeFile(path.join(nativeDir, 'amp'), 'native amp');

  fakeAmpPath = path.join(projectDir, 'amp.mjs');
  await writeFile(fakeAmpPath, `#!/usr/bin/env node
if (!process.argv.includes('--orb-execute')) process.exit(0);
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'T-01a03c00-e608-7007-8181-5c1cc56757be' }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'orb:' + prompt }], stop_reason: 'end_turn' },
  }));
});
`);
  await chmod(fakeAmpPath, 0o755);
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('compiled binary in a project with its own @ampcode/cli', () => {
  it('runs Orb turns with AMP_CLI_PATH and leaves the project CLI alone', async () => {
    const env = {
      ...globalThis.process.env,
      AMP_CLI_PATH: fakeAmpPath,
      AMP_API_KEY: 'test-key',
      AMP_ACP_STATE_DIR: path.join(projectDir, 'state'),
      AMP_ACP_DISABLE_PLUGIN_LIST: '1',
      AMP_ACP_DISABLE_SHOW_AGENT_OPTIONS: '1',
    };
    delete env.AMP_ACP_TRANSPORT;
    const process = spawn(BINARY_PATH, [], { cwd: projectDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    process.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));

    const updates: SessionNotification[] = [];
    const stream = ndJsonStream(
      Writable.toWeb(process.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdout!) as ReadableStream<Uint8Array>,
    );

    try {
      const response = await client({ name: 'amp-acp-project-cli-client' })
        .onNotification(methods.client.session.update, (context) => {
          updates.push(context.params);
        })
        .connectWith(stream, async (agent) => {
          await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await agent.request(methods.agent.session.new, { cwd: projectDir, mcpServers: [] });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: 'execution-environment',
            value: 'orb',
          });
          return agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'hello' }],
          });
        });

      expect(response.stopReason).toBe('end_turn');
      expect(updates.map((notification) => notification.update)).toContainEqual(expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'orb:hello' },
      }));
      expect(await readFile(projectCliBin, 'utf8')).toBe(PROJECT_CLI_STUB);
      expect(existsSync(path.join(path.dirname(projectCliBin), 'ran'))).toBe(false);
    } catch (error) {
      const logs = Buffer.concat(stderr).toString().trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\namp-acp stderr:\n${logs}` : ''}`);
    } finally {
      process.kill('SIGTERM');
    }
  });
});
