---
name: page-anatomy
description: Use before adding or changing a screen in Jian's panel (a page in the chat's place such as Schedules, Artifacts, Pull requests or Activity, or a page of settings). Every screen has the same width, heading, sticky toolbar and cards; this is how to build one so it matches the rest.
---

# Page anatomy

Every screen in Jian is one page built from `packages/ui/src/kit/page-layout.tsx`. A screen that
is wider, starts lower, has its own bar or its own card style is a bug. Read the `glass-kit` skill
for the pieces; this one is about how a screen goes together.

## Where a screen lives

- **In the chat's place**, with the sidebar beside it: Schedules, Artifacts, Pull requests,
  Activity. This is the default for anything of the agent's that is listed, read or managed.
  - An address in `lib/navigation.ts`: `xPath(profileId)` and `onX(pathname)`.
  - A branch in `app/chats.tsx`, in `AgentChats` and in `opened`, so a phone shows it.
  - Its title in `app/phone-bar.tsx`; its button in `chat-sidebar.tsx` (`aria-current` from
    `onX`); its command in `commands/agent-commands.tsx` (`place(xPath(...))`).
  - A web route `apps/web/app/(workspace)/agents/[profileId]/x/page.tsx` returning `null`: the
    layout draws it.
  - `useNoInspector()` at its top: a screen with no conversation has no Inspector.
- **A room of pages** (kit `Page` + `SettingsLayout`) only for settings: the app's and the
  agent's. Nothing else swaps the sidebar for a list of its own.

## The page

```tsx
<div className="flex h-full min-h-0">
  <PageBody labelledBy="x-title">
    <PageHeading id="x-title" title="X" description="One line of what it is." actions={…} />
    <PageToolbar>
      <SearchField label="Search x" className="min-w-44 flex-1" … />
      {/* Segmented, FilterSelect… */}
    </PageToolbar>
    {/* sections */}
  </PageBody>
  {/* dialogs */}
</div>
```

- **One width.** `PageBody` is 60rem at most on every screen, rows, forms, cards or a table.
  Never pass a width of your own or wrap the content in another `max-w-*`.
- **The heading** holds what acts on the whole screen (New, Import, Refresh, settings) at its
  right: `Action tone="outline" size="small" className="h-8"`, or `iconButton`s with a
  `HoverTip`. No bar of tools at the window's top (`ScreenHeader`): that is only for a document
  open full size, as an Artifact is.
- **The toolbar** is sticky: it stays under the title bar while the page scrolls. Put the search
  first, taking the room left, then filters. Anything that narrows the list goes here, never
  above the heading or inside a section.
- **Sections**: a `SectionHeading` over a `surfaceCard`, or a `SettingsGroup`. A list is a card
  with `divide-y divide-glass-edge overflow-hidden`, each row a full-width button `px-4 py-3`
  that hovers `bg-glass-press`. A table lies in a card too (`@container overflow-hidden`), its
  outer cells inset `pl-4`/`pr-4`.
- **Empty, loading and failed** are in the same column: a `surfaceCard` paragraph
  (`px-4 py-3 text-[13px] text-muted`), a `SkeletonRegion` of cards, an alert with Try again.

## One item open

A list whose item opens in full (a schedule, an Artifact) opens it on the same screen, not in a
dialog or a side list:

- The open one is in the address as a query (`?schedule=id`, `?schedule=new`), read with
  `useSearchParams`, so the browser's back and a link both work.
- Opening pushes; closing goes `router.back()` when this page pushed it, else
  `router.replace(xPath)`. Copy `open`/`close` from `app/schedules/schedules-screen.tsx`.
- Its page is the same anatomy: `PageHeading` with `onBack` and `backLabel` naming the list.
- An id no longer listed (deleted meanwhile) shows the list.

## Checks

- A test renders the screen at its address (`memoryNavigation.go(...)` after building the agent
  cache) and covers opening, going back and the search.
- Look at it on a phone width: the toolbar wraps, rows truncate, nothing scrolls sideways.
