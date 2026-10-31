import { z } from 'zod';

const target = { frame: z.number().int().min(0).max(30).default(0) };
export const pageInspectionInputSchema = z.object({
  url: z.url().max(2000),
  reusePage: z
    .boolean()
    .default(false)
    .describe(
      'Desktop only: inspect the matching page already open in the profile browser, preserving its current state and any login the owner completed. Server inspections open a fresh page.',
    ),
  width: z.number().int().min(320).max(1920).default(1440),
  height: z.number().int().min(240).max(1200).default(900),
  actions: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('click'), ...target, selector: z.string().min(1).max(500) }),
        z.object({
          type: z.literal('fill'),
          ...target,
          selector: z.string().min(1).max(500),
          text: z.string().max(4000),
        }),
        z.object({
          type: z.literal('scroll'),
          ...target,
          x: z.number().int().min(0).max(100000).default(0),
          y: z.number().int().min(0).max(100000),
        }),
      ]),
    )
    .max(12)
    .default([])
    .describe(
      'Each inspection opens a fresh page. Replay the complete action sequence to inspect another state. Frame indexes come from the previous inspection; selectors come from its controls or DOM.',
    ),
});

export type PageInspectionInput = z.infer<typeof pageInspectionInputSchema>;

/** One action in the page the owner can see, in the desktop app's browser. */
export const browserActionInputSchema = z
  .object({
    action: z
      .enum(['open', 'back', 'forward', 'reload', 'click', 'type', 'key', 'scroll', 'read'])
      .describe(
        'open navigates to url. click needs a selector or x and y. type enters text, into a selector when given, else where the focus is. key presses one key. scroll moves the page by deltaX and deltaY. read only reports the page as it stands.',
      ),
    url: z.url().max(2000).optional(),
    selector: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Must match exactly one element in the frame; take it from controls.'),
    frame: z.number().int().min(0).max(30).default(0),
    x: z.number().min(0).max(10000).optional().describe('Viewport pixels, as in the screenshot.'),
    y: z.number().min(0).max(10000).optional(),
    text: z.string().max(4000).optional(),
    submit: z.boolean().default(false).describe('Press Enter after typing.'),
    key: z.enum(['Enter', 'Escape', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Backspace']).optional(),
    deltaX: z.number().int().min(-20000).max(20000).default(0),
    deltaY: z.number().int().min(-20000).max(20000).default(0),
  })
  .superRefine((input, context) => {
    const missing = (message: string) => context.addIssue({ code: 'custom', message });
    if (input.action === 'open' && !input.url) missing('open needs a url');
    if (
      input.action === 'click' &&
      !input.selector &&
      (input.x === undefined || input.y === undefined)
    )
      missing('click needs a selector, or x and y');
    if (input.action === 'type' && input.text === undefined) missing('type needs text');
    if (input.action === 'key' && !input.key) missing('key needs a key');
  });

export type BrowserActionInput = z.infer<typeof browserActionInputSchema>;

/** What an action left on screen. Page text and controls are written by the website. */
export type BrowserActionFrame = {
  index: number;
  url: string;
  title: string;
  text: string;
  controls: unknown[];
};
export type BrowserActionResult<Image> = {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** False while the window is hidden or something covers the page: no input reaches it then. */
  visible: boolean;
  screenshot: Image | null;
  frames: BrowserActionFrame[];
};

/** What an agent can bring to the owner's Inspector, in the conversation it is working in. */
const GITHUB_ITEM = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+(?:[/?#].*)?$/;
export const inspectorFocusInputSchema = z
  .object({
    kind: z.enum(['pull_request', 'issue', 'subagent', 'browser']),
    url: z.url().max(2000).optional().describe('The GitHub link of the pull request or issue.'),
    runId: z.uuid().optional().describe('The subagent, as spawn_subagent returned it.'),
  })
  .superRefine((input, context) => {
    if (
      (input.kind === 'pull_request' || input.kind === 'issue') &&
      !GITHUB_ITEM.test(input.url ?? '')
    )
      context.addIssue({
        code: 'custom',
        message: 'This needs a GitHub pull request or issue url',
      });
    if (input.kind === 'subagent' && !input.runId)
      context.addIssue({ code: 'custom', message: 'A subagent is named by its runId' });
  });
export type InspectorFocusInput = z.infer<typeof inspectorFocusInputSchema>;

/** The desktop and its local gateway exchange page inspections over their private process port. */
export const nativeBrowserRequestSchema = z.strictObject({
  type: z.literal('browser:inspect'),
  id: z.uuid(),
  profileId: z.uuid(),
  sessionId: z.uuid(),
  input: pageInspectionInputSchema,
});
export const nativeBrowserActSchema = z.strictObject({
  type: z.literal('browser:act'),
  id: z.uuid(),
  profileId: z.uuid(),
  sessionId: z.uuid(),
  // The gateway validated it; the desktop parses it again, as it does an inspection.
  input: z.unknown(),
});
export const nativeBrowserCancelSchema = z.strictObject({
  type: z.literal('browser:cancel'),
  id: z.uuid(),
});
export type NativeBrowserRequest = z.infer<typeof nativeBrowserRequestSchema>;
export type NativeBrowserReply<Snapshot = unknown> = { type: 'browser:result'; id: string } & (
  | { error: string; capture?: never; acted?: never }
  | {
      error?: never;
      capture: { screenshot: string; archive: string; snapshot: Snapshot };
      acted?: never;
    }
  | { error?: never; capture?: never; acted: BrowserActionResult<string> }
);
