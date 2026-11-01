'use client';

import { Search } from 'lucide-react';
import { useId } from 'react';
import { RowInput, SwitchControl } from '../../kit';

/**
 * The field that narrows a list of changed files. It takes what room its line leaves. The first
 * Escape takes back what was typed; only the next closes the panel it is in.
 */
export function FileFilter({
  value,
  onChange,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const label = useId();

  return (
    <div className={`relative min-w-0 flex-1 ${className}`}>
      <span id={label} className="sr-only">
        Filter changed files
      </span>
      <Search
        size={13}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
      />
      <RowInput
        labelledBy={label}
        placeholder="Filter files"
        className="w-full pl-7 text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !value) return;
          event.stopPropagation();
          onChange('');
        }}
      />
    </div>
  );
}

/** Long lines fold under themselves, or scroll sideways: for every diff in the panel it is in. */
export function WrapSwitch({ wrap, setWrap }: { wrap: boolean; setWrap: (wrap: boolean) => void }) {
  return (
    <div className="changes-fade inline-flex shrink-0 items-center gap-2 text-xs text-muted">
      Wrap lines
      <SwitchControl checked={wrap} onCheckedChange={setWrap} label="Wrap lines" />
    </div>
  );
}
