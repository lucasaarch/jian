import type { Memory } from '@jian/contracts';

export interface MemoryWriter {
  memories(profileId: string): Promise<Memory[]>;
  remember(profileId: string, input: unknown, sourceSessionId?: string): Promise<Memory>;
  forget(profileId: string, key: unknown): Promise<Memory>;
  search(profileId: string, query: string, limit?: number): Promise<Memory[]>;
  edit(profileId: string, key: unknown, input: unknown): Promise<Memory>;
  link(profileId: string, key: unknown, linkedKey: unknown): Promise<Memory>;
  unlink(profileId: string, key: unknown, linkedKey: unknown): Promise<Memory>;
}
