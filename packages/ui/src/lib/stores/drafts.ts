import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MediaUpload } from '../api';
import type { AttachmentKind } from '../attachments';

type Drafts = {
  /** What was written and not sent, by `draftKey`; nothing is kept for an empty field. */
  texts: Record<string, string>;
  write: (key: string, text: string) => void;
  forgetAll: () => void;
};

/** A conversation's own, or the one new chat an agent is being written. */
export const draftKey = (profileId: string, sessionId?: string) =>
  `${profileId}:${sessionId ?? 'new'}`;

/**
 * What the owner was writing, kept in this browser so that going to another page, or closing the
 * window, loses nothing. Words only: the files attached are kept apart, in `useAttached`.
 */
export const useDrafts = create<Drafts>()(
  persist(
    (set) => ({
      texts: {},
      write: (key, text) =>
        set((state) => {
          const { [key]: _was, ...rest } = state.texts;
          return { texts: text ? { ...rest, [key]: text } : rest };
        }),
      forgetAll: () => set({ texts: {} }),
    }),
    { name: 'jian-drafts', partialize: ({ texts }) => ({ texts }) },
  ),
);

/** A file in the composer, uploading or ready to go with the message. */
export type Attachment = {
  key: string;
  name: string;
  kind: AttachmentKind;
  bytes: number;
  /** A local address for the picture or the recording, released when the file leaves the draft. */
  preview?: string;
  state: 'uploading' | 'ready' | 'failed';
  id?: string;
  file?: File;
  mimeType?: MediaUpload['mimeType'];
  voice?: boolean;
};

type Attached = {
  /** The files of each draft, by `draftKey`; nothing is kept for a draft without any. */
  files: Record<string, Attachment[]>;
  change: (key: string, next: (files: Attachment[]) => Attachment[]) => void;
  /** Lets the draft's files go, and the memory their previews hold. */
  forget: (key: string) => void;
  forgetAll: () => void;
};

const release = (files: Attachment[] = []) => {
  for (const file of files) if (file.preview) URL.revokeObjectURL(file.preview);
};

/**
 * The files attached to each draft, so that going to another conversation and back finds them
 * where they were. Kept in memory only: a file not yet uploaded is the file itself, which no
 * browser storage holds, so closing the window loses them while the words stay. An upload that
 * ends after the composer has gone still lands here.
 */
export const useAttached = create<Attached>()((set, get) => ({
  files: {},
  change: (key, next) =>
    set((state) => {
      const { [key]: was = [], ...rest } = state.files;
      const files = next(was);
      return { files: files.length ? { ...rest, [key]: files } : rest };
    }),
  forget: (key) => {
    release(get().files[key]);
    set((state) => {
      const { [key]: _was, ...rest } = state.files;
      return { files: rest };
    });
  },
  forgetAll: () => {
    for (const files of Object.values(get().files)) release(files);
    set({ files: {} });
  },
}));
