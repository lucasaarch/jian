'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Camera, LoaderCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { AgentFace } from '../kit';
import type { Profile } from '../lib/api';
import { AVATAR_TYPES, encodeAvatar } from '../lib/avatar';
import { panelApi } from '../lib/query/client';
import { queries } from '../lib/query/profile';

/**
 * The agent's picture, which a click replaces with one chosen from this computer. It is made
 * square and small here, so a photo straight from a camera never reaches the gateway, and saved
 * at once against the agent's newest version.
 */
export function AgentAvatar({ profile, size }: { profile: Profile; size: number }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) {
      toast.error('Choose a PNG, JPEG or WebP picture.');
      return;
    }
    setSaving(true);
    try {
      const avatar = await encodeAvatar(file);
      const newest =
        client.getQueryData(queries.profiles().queryKey)?.find((item) => item.id === profile.id)
          ?.version ?? profile.version;
      const saved = await panelApi().updateProfile(profile.id, {
        expectedVersion: newest,
        avatar,
      });
      client.setQueryData(queries.profiles().queryKey, (profiles = []) =>
        profiles.map((item) => (item.id === saved.id ? saved : item)),
      );
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'The picture was not saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => input.current?.click()}
      disabled={saving}
      aria-label={`Change ${profile.name}'s picture`}
      title="Change picture"
      className="group relative shrink-0 rounded-full disabled:cursor-progress"
    >
      <AgentFace name={profile.name} avatar={profile.avatar} size={size} />
      <span
        className={`absolute inset-0 grid place-items-center rounded-full bg-black/55 text-white transition-opacity ${saving ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}
        aria-hidden="true"
      >
        {saving ? <LoaderCircle size={16} className="animate-spin" /> : <Camera size={16} />}
      </span>
      <input
        ref={input}
        type="file"
        accept={AVATAR_TYPES.join(',')}
        hidden
        onChange={(event) => {
          void choose(event.target.files?.[0]);
          // The same picture chosen again is still a choice.
          event.target.value = '';
        }}
      />
    </button>
  );
}
