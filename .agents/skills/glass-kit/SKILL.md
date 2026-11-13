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
| Button | `Action`, tones `primary`, `glass`, `quiet`, `outline`, `danger`; `size="icon"` for a round one holding only an icon, named by `aria-label` |
| Icon-only button in a bar | `iconButton` classes: round, 1.75rem, no ground or border until hovered |
| Field | `TextField`, `TextArea`, `SelectField`, `DateTimeField`, `RowInput` |
| Search and filter a list | `SearchField`, with a `FilterSelect` beside it |
| On and off, or one of a few | `SwitchControl`, `Toggle`, `Segmented` |
| List that opens | `Picker`, `MenuEntry`, `MenuDivider`, `menuPopup` |
| Row of tabs that can outgrow its bar | `ScrollStrip`: no scrollbar, wheel and fades |
| Anything over the page | `Overlay`, `OverlayActions`, `ConfirmDialog` |
| Room of pages with a list | `Page` with `SettingsLayout`, `SettingsGroup`, `SettingsRow` |
| A screen's column, heading and cards | `PageBody`, `PageHeading`, `PageToolbar`, `SectionHeading`, `surfaceCard` |
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

- **A room of pages takes the app's place.** Settings, agent settings and schedules are a kit
  `Page` holding a `SettingsLayout`: its list stands where the sidebar was, under a Back button,
  and the open page where the conversation was. The conversation stays mounted beneath, inert,
  and Escape goes back. Copy that for a new one, never an `Overlay`.
- **Every screen has one anatomy.** Settings, agent settings and each of their pages, schedules,
  activity, skills and memories, and any new screen of the kind, are built from `page-layout.tsx`:
  - `PageBody`: the column, 40rem for rows and forms, `wide` (72rem) for cards, a map or figures.
  - `PageHeading`: an `h1` in `text-xl`, what acts on the whole screen (Create, Import, Edit) at
    its right as `outline` `small` actions 2rem tall, and an arrow `iconButton` back only on a
    screen opened from a list inside it (one skill).
  - `PageToolbar` under it: the search taking the room left, then its `Segmented` and
    `FilterSelect`s. No bar of its own at the top: a screen that is only read has none.
  - Sections: `SettingsGroup`, or a `SectionHeading` (`text-xs` muted) over the content.
  - Cards: `surfaceCard` with `p-4`, never another radius, ground or border.
  - Spacing: `gap-7` between sections (`gap-5` on a phone), `gap-4` from heading to toolbar to
    content. A page with its own toolbar renders its own `PageHeading` (`ownHeading` on
    `SettingsLayout`), so the gap stays the same as on one that does not.
  - Every edge is the column's: no `px-1` or other nudge on a title, a note or a card. Text that
    stands a few pixels in from the card under it is the misalignment this rule exists to stop.
  Pull requests is the one exception: a table edge to edge under a `ScreenHeader` of tools.
- **A screen with no conversation has no Inspector.** A `Page` hides it by itself; a screen in the
  conversation's place, as Pull requests, calls `useNoInspector()`. Neither closes it: it comes
  back as it was with the conversation.
- **Overlay sizes.** `settings` for a room of pages, `form` for one form, `page` for a page to read.
- **An overlay's actions float.** Put a form's or page's buttons in `OverlayActions`, never in a row
  at the end of the content: they stay at the pane's bottom corners however it scrolls, a submit button
  still submits its form, and the close button floats the same way. A `flex-1` span separates left
  from right.
- **Everything in a form or page lines up.** Pad its content with `p-7`, which is where the floating
  actions and the close button stand, and give its header `pr-10` to clear the close button.
- **A bar's icon buttons are all one button.** The sidebar's, the title bar's, the Inspector's and
  a screen's header use `iconButton` from the kit, never a square, outlined or filled one of their
  own. An open and a close button for the same thing sit in the same place, in the same size. A
  bar keeps to a few of them: what else it can do goes behind one `Ellipsis` button opening a
  `menuPopup` of `MenuEntry`s, as the file viewer and the GitHub drawer do.
- **A field inside a bar has no box of its own.** A find or filter bar that is itself the surface
  holds a bare input (`bareInput` from `text-field.tsx`), not a `SearchField`, which would be a
  frame inside a frame.
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
