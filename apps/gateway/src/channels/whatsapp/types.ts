import type { channelConnectionSchema, InlineMedia } from '@jian/contracts';
import type { z } from 'zod';
import type { EncryptedSecret } from '../../security/crypto.js';
import type { IncomingMessage } from '../channel.js';

export type ConnectionStatus = z.infer<typeof channelConnectionSchema>['status'];

export interface ConnectionRecord {
  id: string;
  profileId: string;
  desired: boolean;
  generation: number;
  fence?: number;
  status: ConnectionStatus;
  updatedAt: string;
  owner?: string;
  leaseUntil?: number;
  retryAt?: number;
  accountId?: string;
  sessionSavedAt?: string;
  error?: string;
  qr?: EncryptedSecret;
  qrExpiresAt?: number;
}

export interface DeviceAuthRecord {
  id: string;
  profileId: string;
  chunks: EncryptedSecret[];
}

export interface InboxRecord {
  id: string;
  profileId: string;
  channelId: string;
  generation: number;
  message: IncomingMessage;
  status: 'pending' | 'submitted' | 'discarded';
  receivedAt: string;
}

export interface DeviceSessionStore {
  load(): Promise<Buffer | undefined>;
  save(data: Buffer): Promise<void>;
  clear(): Promise<void>;
}

export interface DeviceCallbacks {
  qr(value: string): Promise<void>;
  ready(accountId: string): Promise<void>;
  disconnected(loggedOut: boolean): Promise<void>;
  message(message: IncomingMessage): Promise<void>;
  failed(): Promise<void>;
}

export interface LinkedDevice {
  start(): Promise<void>;
  send(chatId: string, text: string, signal: AbortSignal, media?: InlineMedia): Promise<string>;
  /** The composing bubble. WhatsApp drops it after a few seconds, so it is re-sent, not held. */
  typing(chatId: string): Promise<void>;
  /** The small profile picture WhatsApp shows for a person or a group, when it has one. */
  avatar?(chatId: string): Promise<InlineMedia | undefined>;
  /** The paired account's own profile picture; null takes it off. */
  setPicture?(picture: InlineMedia | null): Promise<void>;
  stop(logout: boolean): Promise<void>;
}

export type DeviceFactory = (
  id: string,
  store: DeviceSessionStore,
  callbacks: DeviceCallbacks,
) => Promise<LinkedDevice>;

export const DEVICE_SEND_TIMEOUT_MS = 20_000;
