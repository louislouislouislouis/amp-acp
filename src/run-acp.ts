import { ndJsonStream } from '@agentclientprotocol/sdk/unstable';
import { createAgentApp } from './agent-app.js';
import { nodeToWebWritable, nodeToWebReadable, shutdownOnExit } from './utils.js';

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(
    input as unknown as WritableStream<Uint8Array>,
    output as unknown as ReadableStream<Uint8Array>,
  );
  const { app, getAgent } = createAgentApp();
  const connection = app.connect(stream);
  shutdownOnExit(connection.closed, getAgent);
}
