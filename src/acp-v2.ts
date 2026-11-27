import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  ReplayFrom,
  RequestError,
  type AgentApp,
  type AgentConnection,
  agent,
} from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type * as v2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type {
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk/unstable';
import packageJson from '../package.json';
import type { AcpClient } from './acp-client.js';
import { AmpAcpAgent, preparePrompt } from './server.js';

const PACKAGE_VERSION: string = packageJson.version;
const PLAN_ID = 'amp-plan';
const INTERNAL_ERROR = -32603;

function toAcpV2ConfigOptions(
  options: NewSessionResponse['configOptions'],
): v2.NewSessionResponse['configOptions'] {
  return options?.map((option) => {
    const { id, ...rest } = option;
    return { ...rest, configId: id } as unknown as v2.SessionConfigOption;
  });
}

function toV1McpServers(
  servers: v2.NewSessionRequest['mcpServers'],
): NewSessionRequest['mcpServers'] | undefined {
  return servers?.map((server) => {
    if (server.type === 'stdio') {
      return {
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
      } as unknown as NewSessionRequest['mcpServers'][number];
    }
    return server as unknown as NewSessionRequest['mcpServers'][number];
  });
}

/**
 * Translates ACP v1 session updates into the v2 shapes that changed. Updates
 * that are already shared between both protocol versions pass through.
 */
export function toAcpV2Update(update: SessionUpdate): v2.SessionUpdate {
  switch (update.sessionUpdate) {
    case 'tool_call':
      return {
        ...update,
        sessionUpdate: 'tool_call_update',
      } as unknown as v2.SessionUpdate;
    case 'config_option_update':
      return {
        ...update,
        configOptions: toAcpV2ConfigOptions(update.configOptions) ?? [],
      } as v2.SessionUpdate;
    case 'plan':
      return {
        sessionUpdate: 'plan_update',
        plan: {
          type: 'items',
          planId: PLAN_ID,
          entries: update.entries,
        },
      } as unknown as v2.SessionUpdate;
    default:
      return update as unknown as v2.SessionUpdate;
  }
}

function textFromPrompt(prompt: PromptRequest['prompt']): string {
  return prompt
    .filter((block): block is Extract<PromptRequest['prompt'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function messageIdFor(sessionId: string): string {
  return `M-${sessionId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Experimental ACP v2 adapter. The session, model, prompt queue, cancellation,
 * and Amp transport behavior stay in the v1 `AmpAcpAgent`; this class translates
 * v2 wire requests into those calls and translates the resulting v1 updates
 * back to v2.
 *
 * Enabled with `AMP_ACP_PROTOCOL=v2`; the default entry point keeps using the
 * v1 agent app so existing clients are unaffected.
 */
export class AcpV2Adapter {
  private readonly app: AgentApp;
  private connection?: AgentConnection;
  private readonly inner: AmpAcpAgent;
  /** Turns not yet reported idle. Each promise settles after its final state update. */
  private readonly turnsBySession = new Map<string, Set<Promise<void>>>();

  constructor(createAgent: (client: AcpClient) => AmpAcpAgent = (client) => new AmpAcpAgent(client)) {
    const fakeClient: AcpClient = {
      sessionUpdate: (notification) => this.sendV1Notification(notification),
      notify: async () => {},
    };
    this.inner = createAgent(fakeClient);
    this.app = agent()
      .onConnect((connection) => {
        this.connection = connection;
      })
      .onRequest(AGENT_METHODS.initialize, ({ params }) => this.initialize(params))
      .onRequest(AGENT_METHODS.session_new, ({ params }) => this.newSession(params))
      .onRequest(AGENT_METHODS.session_resume, ({ params }) => this.resumeSession(params))
      .onRequest(AGENT_METHODS.session_close, ({ params }) => this.closeSession(params))
      .onRequest(AGENT_METHODS.session_delete, ({ params }) => this.deleteSession(params))
      .onRequest(AGENT_METHODS.session_list, ({ params }) => this.inner.listSessions(params))
      .onRequest(AGENT_METHODS.session_set_config_option, ({ params }) => this.setConfigOption(params))
      .onRequest(AGENT_METHODS.session_prompt, ({ params }) => this.prompt(params))
      .onNotification(AGENT_METHODS.session_cancel, ({ params }) => this.cancel(params));
  }

  connect(stream: v2.Stream): AgentConnection {
    return this.app.connect(stream);
  }

  private async initialize(request: v2.InitializeRequest): Promise<v2.InitializeResponse> {
    const response: InitializeResponse = await this.inner.initialize({
      protocolVersion: 1,
      clientCapabilities: request.capabilities as unknown as InitializeRequest['clientCapabilities'],
    });
    const v1Capabilities = response.agentCapabilities;
    return {
      protocolVersion: PROTOCOL_VERSION,
      info: {
        name: response.agentInfo?.name ?? 'amp-acp',
        title: response.agentInfo?.title ?? 'Amp ACP Agent',
        version: response.agentInfo?.version || PACKAGE_VERSION,
      },
      capabilities: {
        session: {
          prompt: {
            ...(v1Capabilities?.promptCapabilities?.image ? { image: {} } : {}),
            ...(v1Capabilities?.promptCapabilities?.embeddedContext ? { embeddedContext: {} } : {}),
          },
          mcp: {
            ...(v1Capabilities?.mcpCapabilities?.http || v1Capabilities?.mcpCapabilities?.sse
              ? { http: {} }
              : {}),
            stdio: {},
          },
          delete: {},
        },
      },
      authMethods: response.authMethods?.flatMap((method) => {
        if (!('type' in method) || method.type !== 'terminal') return [];
        const terminal = method as typeof method & { args?: string[] };
        return [{
          type: 'terminal' as const,
          methodId: method.id,
          name: method.name,
          ...(method.description ? { description: method.description } : {}),
          args: terminal.args ?? [],
        }];
      }),
    };
  }

  private async newSession(request: v2.NewSessionRequest): Promise<v2.NewSessionResponse> {
    const session: NewSessionResponse = await this.inner.newSession({
      cwd: request.cwd,
      ...(request.additionalDirectories ? { additionalDirectories: request.additionalDirectories } : {}),
      mcpServers: toV1McpServers(request.mcpServers),
    } as NewSessionRequest);
    const availableCommands = (session as { availableCommands?: v2.NewSessionResponse['availableCommands'] })
      .availableCommands;
    return {
      sessionId: session.sessionId,
      configOptions: toAcpV2ConfigOptions(session.configOptions),
      ...(availableCommands ? { availableCommands } : {}),
    };
  }

  private async resumeSession(request: v2.ResumeSessionRequest): Promise<v2.ResumeSessionResponse> {
    const replayFrom = request.replayFrom ?? null;
    if (replayFrom && !ReplayFrom.isStart(replayFrom)) {
      throw RequestError.invalidParams(undefined, `Unsupported replayFrom cursor: ${JSON.stringify(replayFrom)}`);
    }
    const session = await this.inner.resumeSession(
      {
        sessionId: request.sessionId,
        cwd: request.cwd,
        mcpServers: toV1McpServers(request.mcpServers),
      },
      replayFrom
        ? { replay: (notification) => this.sendUpdate(notification.sessionId, toAcpV2Update(notification.update)) }
        : {},
    );
    // v2 requires a state snapshot before the resume response.
    await this.sendUpdate(
      request.sessionId,
      this.turnsBySession.has(request.sessionId)
        ? { sessionUpdate: 'state_update', state: 'running' }
        : { sessionUpdate: 'state_update', state: 'idle' },
    );
    return { configOptions: toAcpV2ConfigOptions(session.configOptions) };
  }

  /** v2 requires the cancelled turns' final updates before the close response. */
  private async closeSession(request: v2.CloseSessionRequest): Promise<void> {
    const turns = [...(this.turnsBySession.get(request.sessionId) ?? [])];
    await this.inner.closeSession({ sessionId: request.sessionId });
    await Promise.all(turns);
  }

  private async deleteSession(request: v2.DeleteSessionRequest): Promise<void> {
    const turns = [...(this.turnsBySession.get(request.sessionId) ?? [])];
    await this.inner.deleteSession({ sessionId: request.sessionId });
    await Promise.all(turns);
  }

  private async setConfigOption(
    request: v2.SetSessionConfigOptionRequest,
  ): Promise<v2.SetSessionConfigOptionResponse> {
    const response = await this.inner.setSessionConfigOption(request as unknown as Parameters<AmpAcpAgent['setSessionConfigOption']>[0]);
    return { configOptions: toAcpV2ConfigOptions(response.configOptions) ?? [] };
  }

  private async prompt(request: v2.PromptRequest): Promise<v2.PromptResponse> {
    const prompt = request.prompt as unknown as PromptRequest['prompt'];
    // Reject invalid blocks before emitting messageId or a running update.
    preparePrompt(prompt);
    const messageId = messageIdFor(request.sessionId);
    const text = textFromPrompt(prompt);

    // v2 returns immediately; the turn runs in the background and reports its
    // state through session/update notifications.
    const started = this.sendUpdate(request.sessionId, {
      sessionUpdate: 'user_message_chunk',
      messageId,
      content: { type: 'text', text },
    }).then(() => this.sendUpdate(request.sessionId, { sessionUpdate: 'state_update', state: 'running' }));
    const turn = started
      .then(() => this.inner.prompt({ sessionId: request.sessionId, prompt }))
      .then(
        (response) => this.finishTurn(request.sessionId, response.stopReason, response.usage),
        (error: unknown) => this.failTurn(request.sessionId, error),
      );
    this.trackTurn(request.sessionId, turn);
    await started;

    return { messageId };
  }

  private trackTurn(sessionId: string, turn: Promise<void>): void {
    const turns = this.turnsBySession.get(sessionId) ?? new Set<Promise<void>>();
    turns.add(turn);
    this.turnsBySession.set(sessionId, turns);
    void turn.finally(() => {
      turns.delete(turn);
      if (turns.size === 0 && this.turnsBySession.get(sessionId) === turns) {
        this.turnsBySession.delete(sessionId);
      }
    });
  }

  private async cancel(request: v2.CancelSessionNotification): Promise<void> {
    await this.inner.cancel({ sessionId: request.sessionId } as CancelNotification);
  }

  private async finishTurn(
    sessionId: string,
    stopReason: PromptResponse['stopReason'],
    usage: PromptResponse['usage'],
  ): Promise<void> {
    // SDK 1.9 narrows the v2 idle state union separately from the v1 stop reason.
    await this.sendUpdate(sessionId, {
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason,
      usage: usage as unknown as v2.Usage,
    } as v2.SessionUpdate);
  }

  private async failTurn(sessionId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.sendUpdate(sessionId, {
      sessionUpdate: 'notice',
      severity: 'error',
      title: 'Amp request failed',
      description: message,
    });
    await this.sendUpdate(sessionId, {
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'error',
      error: { code: error instanceof RequestError ? error.code : INTERNAL_ERROR, message },
    });
  }

  private async sendV1Notification(notification: SessionNotification): Promise<void> {
    const update = notification.update;
    // The v2 facade emits the user message itself so the prompt response and
    // the echoed message always share one messageId.
    if (update.sessionUpdate === 'user_message_chunk') return;

    await this.sendUpdate(notification.sessionId, toAcpV2Update(update));
  }

  private async sendUpdate(sessionId: string, update: v2.SessionUpdate): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.client.notify(CLIENT_METHODS.session_update, { sessionId, update });
    } catch (error) {
      console.error('[acp-v2] session/update failed', error);
    }
  }
}
