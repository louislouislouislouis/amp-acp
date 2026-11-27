import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep test sessions out of the user's real state dir. Spawned binaries inherit it through process.env.
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'amp-acp-test-state-'));
process.env.AMP_ACP_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
