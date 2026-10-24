'use client';

import type { ProfessionDefinition, ProfessionId } from '@jian/contracts';
import { Code2, Headset } from 'lucide-react';
import { Select } from '../ui/select';

const icons = { developer: Code2, attendant: Headset };

export function ProfessionSelect({
  professions,
  value,
  onValueChange,
  disabled,
  id,
}: {
  professions: ProfessionDefinition[];
  value: ProfessionId | '';
  onValueChange: (value: ProfessionId) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select
      id={id}
      aria-label={id ? undefined : 'Profession'}
      value={value}
      onValueChange={(next) => onValueChange(next as ProfessionId)}
      disabled={disabled || professions.length === 0}
      placeholder="Choose a profession"
      options={professions.map((profession) => {
        const Icon = icons[profession.id];
        return {
          value: profession.id,
          label: profession.label,
          detail: profession.description,
          icon: <Icon size={18} strokeWidth={1.7} />,
        };
      })}
    />
  );
}
