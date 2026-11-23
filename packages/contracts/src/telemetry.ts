import { z } from 'zod';
import { COMPONENT_PROMPT_TARGETS, type ComponentPromptTarget } from './component-prompt.js';
import {
  deckExportQuerySchema,
  type SessionArtifactType,
  sessionArtifactTypeSchema,
} from './session-artifacts.js';

/**
 * What the panel counts of its own use, for the gateway's anonymous daily report. Every key is
 * fixed here, so a count is all that can leave: never a name, an address, a title or anything the
 * owner typed. A key, once reported, keeps its meaning; a feature that goes away keeps its key
 * unused rather than lending it to another.
 */
const FIXED = [
  // The panel loaded on this gateway: the count every other one is read against.
  'panel_opened',
  // The theme the panel opened in, and each switch to the other.
  'theme_dark',
  'theme_light',
  // A conversation opened in the chat's place, and the new chat screen.
  'chat',
  'new_chat',
  // Screens in the chat's place.
  'artifacts_page',
  'schedules',
  'pull_requests',
  'activity',
  'plugins',
  'skill_page',
  'connector_page',
  // The agent's settings, by page.
  'agent_identity',
  'memories',
  'agent_channels',
  'agent_secrets',
  // Settings, by page.
  'settings_general',
  'settings_appearance',
  'settings_keymaps',
  'settings_providers',
  'settings_models',
  'settings_ssh_keys',
  'settings_machines',
  'settings_mobile',
  'settings_updates',
  'settings_connection',
  // The Inspector opened, and a tab of each kind turned to.
  'inspector_opened',
  'inspector_browser',
  'inspector_files',
  'inspector_changes',
  'inspector_artifacts',
  'inspector_terminal',
  'inspector_github',
  'inspector_subagent',
  // What is done to an open Artifact, whatever its type.
  'artifact_view_code',
  'artifact_history_opened',
  'artifact_presented',
  'artifact_made_public',
  'artifact_fix_pressed',
  'artifact_tweaks_changed',
  'deck_slide_added',
  // The composer.
  'message_sent',
  'attachment_added',
  'voice_note_recorded',
  'model_changed',
  'effort_changed',
  // The command palette opened, and a command run from it or by its shortcut.
  'command_palette_opened',
  'command_run',
] as const;

/** A file an Artifact is taken away as: a format the gateway draws, or its source as written. */
const ARTIFACT_DOWNLOAD_FORMATS = [...deckExportQuerySchema.shape.format.options, 'source'];
type ArtifactDownloadFormat = z.infer<typeof deckExportQuerySchema>['format'] | 'source';

/** A key is snake_case throughout, so a target such as `react-native` is `react_native`. */
type Snake<S extends string> = S extends `${infer A}-${infer B}` ? `${A}_${Snake<B>}` : S;
const snake = (name: string) => name.replaceAll('-', '_');

export type PanelFeature =
  | (typeof FIXED)[number]
  // An Artifact opened, by type.
  | `artifact_opened_${SessionArtifactType}`
  // A stretch of editing by hand, counted once when its first change is heard, by type.
  | `artifact_hand_edit_${SessionArtifactType}`
  // A file taken away, by format.
  | `artifact_downloaded_${ArtifactDownloadFormat}`
  // A component copied as a prompt for another AI, by the framework asked for.
  | `artifact_prompt_copied_${Snake<ComponentPromptTarget>}`;

const types = sessionArtifactTypeSchema.options;

export const PANEL_FEATURES = [
  ...FIXED,
  ...types.map((type) => `artifact_opened_${type}`),
  ...types.map((type) => `artifact_hand_edit_${type}`),
  ...ARTIFACT_DOWNLOAD_FORMATS.map((format) => `artifact_downloaded_${format}`),
  ...COMPONENT_PROMPT_TARGETS.map((target) => `artifact_prompt_copied_${snake(target.id)}`),
] as [PanelFeature, ...PanelFeature[]];

export const panelFeatureSchema = z.enum(PANEL_FEATURES);

const known = new Set<string>(PANEL_FEATURES);

/** The key a name stands for, snake-cased, or none when the vocabulary has no such key. */
export function panelFeatureOf(name: string): PanelFeature | undefined {
  const key = snake(name);
  return known.has(key) ? (key as PanelFeature) : undefined;
}

/**
 * The most one key counts in one report from the panel. The panel sends every few minutes, so a
 * real count is far below it; the bound keeps a broken or hostile client from inflating a key.
 */
export const PANEL_USAGE_COUNT_MAX = 10_000;

/**
 * What the panel hands its gateway: counts since its last report, from one host, drawn at a
 * phone's width or not. A key outside the vocabulary refuses the whole report: what is stored and
 * sent on can only be a key listed here. A panel newer than its gateway loses that report, which
 * it drops rather than sending again.
 */
export const panelUsageSchema = z.strictObject({
  host: z.enum(['web', 'desktop']),
  /** The panel was at a phone's width when these were counted. */
  phone: z.boolean(),
  counts: z.partialRecord(panelFeatureSchema, z.number().int().min(0).max(PANEL_USAGE_COUNT_MAX)),
});

export type PanelUsage = z.infer<typeof panelUsageSchema>;
