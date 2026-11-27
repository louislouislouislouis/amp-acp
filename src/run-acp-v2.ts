import { ndJsonStream } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import { nodeToWebWritable, nodeToWebReadable, shutdownOnExit } from './utils.js';
import { AcpV2Adapter } from './acp-v2.js';

export function runAcpV2(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(
    input as unknown as WritableStream<Uint8Array>,
    output as unknown as ReadableStream<Uint8Array>,
  );
  const adapter = new AcpV2Adapter();
  const connection = adapter.connect(stream);
  shutdownOnExit(connection.closed, () => adapter);
}
