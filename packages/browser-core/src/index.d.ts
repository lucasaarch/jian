export type DocumentSnapshot = {
  title: string;
  text: string;
  textTruncated: boolean;
  html: string;
  htmlTruncated: boolean;
  scroll: { x: number; y: number; width: number; height: number };
  elements: Array<{
    selector: string;
    tag: string;
    text: string;
    bounds: { x: number; y: number; width: number; height: number };
    styles: Record<string, string>;
  }>;
  elementsTruncated: boolean;
  controls: Array<{
    selector: string;
    tag: string;
    name: string;
    type: string | null;
    href: string | null;
  }>;
  assets: Array<{ url: string; alt: string; width: number; height: number }>;
};
export type CapturedFrame = DocumentSnapshot & { index: number; url: string };
export type Resource = { url: string; mimeType: string; data: Uint8Array };
export type BlockedResource = { url: string; reason: string };
export type InspectionSnapshot = {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  actions: unknown[];
  frames: Array<Omit<CapturedFrame, 'html'>>;
  resources: Array<{ url: string; mimeType: string; bytes: number; path: string }>;
  blocked: BlockedResource[];
  framesTruncated: boolean;
  sourceNote: string;
};
export type InspectionCapture = {
  screenshot: Uint8Array;
  archive: Uint8Array;
  snapshot: InspectionSnapshot;
};
export function snapshotDocument(): DocumentSnapshot;
export function packInspection(input: {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  actions: unknown[];
  frames: CapturedFrame[];
  resources: Resource[];
  blocked: BlockedResource[];
  framesTruncated?: boolean;
}): { archive: Uint8Array; snapshot: InspectionSnapshot };
