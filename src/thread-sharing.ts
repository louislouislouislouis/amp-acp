import type { PromptRequest } from '@agentclientprotocol/sdk/unstable';
import type { AmpMultiplayerSetting, AmpThreadVisibility } from './amp-transport.js';

/** `default` sends no `--visibility`, so Amp applies the user's own default. */
export type VisibilitySetting = 'default' | AmpThreadVisibility;

export const VISIBILITY_SETTINGS = ['default', 'private', 'workspace', 'group', 'unlisted'] as const satisfies readonly VisibilitySetting[];

export const VISIBILITY_LABELS: Record<VisibilitySetting, string> = {
  default: 'Amp default',
  private: 'Private',
  workspace: 'Workspace',
  group: 'Group',
  unlisted: 'Link',
};

export const VISIBILITY_DESCRIPTIONS: Record<VisibilitySetting, string> = {
  default: "Use Amp's default visibility for the new thread. Cannot be chosen once the thread exists.",
  private: 'Only you can see the thread.',
  workspace: 'Members of your Amp workspace can see the thread.',
  group: 'Members of your Amp groups can see the thread.',
  unlisted: 'Anyone with the link can see the thread.',
};

export function isVisibilitySetting(value: string): value is VisibilitySetting {
  return VISIBILITY_SETTINGS.some((candidate) => candidate === value);
}

/** Maps an exported `meta.visibility` to a setting; Amp's legacy `public` means unlisted. */
export function visibilityFromAmp(value: unknown): AmpThreadVisibility | undefined {
  if (value === 'public') return 'unlisted';
  if (typeof value !== 'string' || !isVisibilitySetting(value) || value === 'default') return undefined;
  return value;
}

export interface CollaborationCommand {
  name: 'share' | 'link' | 'multiplayer';
  arg?: string;
}

const COMMAND_PATTERN = /^\/(share|link|multiplayer)(?:\s+(\S+))?$/;

/**
 * Matches a prompt made only of `/share`, `/link`, or `/multiplayer` plus at
 * most one word. Anything longer stays a normal prompt for Amp.
 */
export function parseCollaborationCommand(prompt: PromptRequest['prompt']): CollaborationCommand | null {
  if (prompt.length === 0 || prompt.some((block) => block.type !== 'text')) return null;
  const text = prompt.map((block) => block.type === 'text' ? block.text : '').join('').trim();
  const match = COMMAND_PATTERN.exec(text);
  if (!match) return null;
  const name = match[1] as CollaborationCommand['name'];
  return match[2] ? { name, arg: match[2] } : { name };
}

const SHARE_ALIASES: Record<string, AmpThreadVisibility> = {
  private: 'private',
  workspace: 'workspace',
  group: 'group',
  link: 'unlisted',
  unlisted: 'unlisted',
  public: 'unlisted',
};

/** `/share` alone shares with the workspace, the usual collaboration target. */
export function parseShareArgument(arg: string | undefined): AmpThreadVisibility | null {
  if (arg === undefined) return 'workspace';
  return SHARE_ALIASES[arg.toLowerCase()] ?? null;
}

const DURATION_UNITS = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks' } as const;
const SECONDS_PER_UNIT = { minutes: 60, hours: 3_600, days: 86_400, weeks: 604_800 } as const;

/** Amp accepts multiplayer windows between 5 minutes and 7 days. */
export function parseMultiplayerArgument(arg: string | undefined): AmpMultiplayerSetting | null {
  const value = (arg ?? 'on').toLowerCase();
  if (value === 'on') return { enabled: true };
  if (value === 'off') return { enabled: false };
  const match = /^(\d+)([mhdw])$/.exec(value);
  if (!match) return null;
  const amount = Number.parseInt(match[1]!, 10);
  const unit = DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS];
  const seconds = amount * SECONDS_PER_UNIT[unit];
  if (seconds < 5 * 60 || seconds > 7 * 86_400) return null;
  return { enabled: true, duration: { unit, value: amount } };
}

export function describeMultiplayer(setting: AmpMultiplayerSetting): string {
  if (!setting.enabled) return 'Multiplayer is off.';
  if (!setting.duration) return "Multiplayer is on for Amp's default window.";
  const { value, unit } = setting.duration;
  return `Multiplayer is on for ${value} ${value === 1 ? unit.slice(0, -1) : unit}.`;
}
