---
name: glass-kit
description: Use before building or changing any UI in Jian, on desktop or web. The glass kit is the required visual standard, with its pieces, tokens and overlay patterns.
---

# The glass kit

Every surface in Jian is drawn with the kit in `packages/ui/src/kit`. A screen that looks different
from the rest is a bug.

## Before drawing anything

1. Look for the piece in `packages/ui/src/kit/index.ts`, then for a screen that already does it.
2. If the kit lacks it and it could be used twice, add it to the kit and export it there.
3. Only something that belongs to one screen is drawn in place, and still with the kit's surfaces
   and tokens.

## Pieces

| Need | Use |
|---|---|
| Button | `Action`, tones `primary`, `glass`, `quiet`, `outline`, `danger` |
| Field | `TextField`, `TextArea`, `SelectField`, `DateTimeField`, `RowInput` |
| On and off, or one of a few | `SwitchControl`, `Toggle`, `Segmented` |
| List that opens | `Picker`, `MenuEntry`, `MenuDivider`, `menuPopup` |
| Anything over the page | `Overlay`, `OverlayActions`, `ConfirmDialog` |
| Room of pages with a list | `Overlay` with `SettingsLayout`, `SettingsGroup`, `SettingsRow` |
| Things to connect, side by side | `SettingsCards` holding a `SettingsCard` each |
| Waiting | `Skeleton`, `SkeletonRegion`, `SettingsPageSkeleton`, `SettingsCardSkeleton`, `Progress` |
| State or a hint | `StatusPill`, `InfoTip`, `HoverTip` |
| An agent | `AgentFace`, `AgentHero` |
| Search and run | `CommandPalette` |

## Surfaces

- `glass`: a bar, list or popover that floats over content.
- `glass-strong`: an overlay holding a form, where text must stay legible over anything.
- `glass-bar`: a bar flat against the window's edge.
- `scroll-inset`: on a rounded surface that scrolls, so the scrollbar clears the corners.

## Tokens

Colours and blur come from tokens, as Tailwind classes or CSS variables: `canvas`, `ink`, `muted`,
`line`, `glass-edge`, `glass-hover`, `glass-press`, `accent`, `good`, `warn`, `bad` and their
`-soft` versions. Never write a raw colour: both themes depend on these.

Use the kit's own phone width with the `phone:` variant, or `usePhone` in code.

## Patterns

- **New screens are overlays.** The conversation is the only thing in the main area. Settings,
  agent settings and schedules are all an `Overlay` with `SettingsLayout`: copy that, and keep its
  `closeButton={false}`, since the layout has its own way back.
- **Overlay sizes.** `settings` for a room of pages, `form` for one form, `page` for a page to read.
- **An overlay's actions float.** Put a form's or page's buttons in `OverlayActions`, never in a row
  at the end of the content: they stay at the pane's bottom corners however it scrolls, a submit button
  still submits its form, and the close button floats the same way. A `flex-1` span separates left
  from right.
- **Everything in a form or page lines up.** Pad its content with `p-7`, which is where the floating
  actions and the close button stand, and give its header `pr-10` to clear the close button.
- **Destructive actions are red and ask first.** `danger` on the `MenuEntry`, `danger` on the
  command, and `ConfirmDialog` before it happens. Pass `phrase` when what is lost matters most,
  which makes the owner type a name.
- **Whole-window scenes** (onboarding, welcome, creating an agent, farewell) use `Stage` from
  `app/onboarding/stage.tsx`. They cover the status bar instead of removing it, so nothing moves.
- **Motion** respects `useAppearance().still`, and anything that waits on an animation also has a
  timer, since reduced motion may suppress its events.

## Traps

- A grid column left to `auto` grows to its widest child. Use `grid-cols-1` in anything holding
  text you do not control, or a long line scrolls the whole surface sideways.
- The desktop's native browser is drawn over the page, so anything covering it must be found by
  `COVERS` in `apps/desktop/src/renderer/chrome/browser-panel.tsx`. A kit `Overlay` or menu already
  is; a new kind of floating surface needs `role="dialog"` or `role="menu"`.
- Answer a `ResizeObserver` through `watchSize` from `lib/watch-size.ts`.
