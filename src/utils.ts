import { WritableStream, ReadableStream } from 'node:stream/web';
import type { Writable, Readable } from 'node:stream';

export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk: Uint8Array): Promise<void> {
      return new Promise((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) reject(err); else resolve();
        });
      });
    },
  });
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err: Error) => controller.error(err));
    },
  });
}

interface Shutdownable {
  close(): void;
  shutdown(): Promise<void>;
}

/** Runs async cleanup when the ACP stream ends or on SIGINT/SIGTERM; `exit` only allows sync work. */
export function shutdownOnExit(closed: Promise<void>, getTarget: () => Shutdownable | undefined): void {
  const shutdown = async (exitCode?: number) => {
    try {
      await getTarget()?.shutdown();
    } catch (e) {
      console.error('[acp] shutdown failed', e);
    }
    if (exitCode !== undefined) process.exit(exitCode);
  };
  void closed.then(() => shutdown(), () => shutdown());
  process.once('exit', () => getTarget()?.close());
  process.once('SIGINT', () => void shutdown(130));
  process.once('SIGTERM', () => void shutdown(143));
}

export function unreachable(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
