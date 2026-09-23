import type { Profile } from '@jian/contracts';
import type { Queryable } from '../storage/database.js';

/** Passing the caller's transaction keeps the lookup inside it. */
export interface ProfileReader {
  profile(id: string, reader?: Queryable): Promise<Profile>;
}

export interface ProfileAdmin extends ProfileReader {
  profiles(): Promise<Profile[]>;
  createProfile(input: unknown): Promise<Profile>;
  updateProfile(id: string, input: unknown): Promise<Profile>;
  deleteProfile(id: string): Promise<{ id: string }>;
}
