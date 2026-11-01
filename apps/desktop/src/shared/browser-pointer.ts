/** The sprite's canvas and where its tip is in it, as the Computer Use helpers draw it. */
export const POINTER_SIZE = 60;
export const POINTER_HOTSPOT = 12;
export const POINTER_ACTIVE_ALPHA = 0.94;
export const POINTER_IDLE_ALPHA = 0.18;

/** Where the agent's pointer stands in the page, and whether it has dimmed for want of use. */
export type PointerAt = { x: number; y: number; dimmed: boolean };

/** The page as it looks now, for the panel to hold while something is drawn over it. */
export type PagePicture = { image: string; pointer: PointerAt | null };
