'use client';

import { Slider } from '@base-ui/react/slider';

/**
 * A number set by dragging between two bounds, its value read out at the end of its name. In the
 * ink, as the kit's switch is: no colour of its own. The arrow keys step it once it has the focus.
 */
export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  onValueChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (value: number) => void;
}) {
  return (
    <Slider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => onValueChange(typeof next === 'number' ? next : (next[0] ?? min))}
      className="grid min-w-0 grid-cols-1 gap-2"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <Slider.Label className="min-w-0 truncate text-[13px] font-medium text-ink">
          {label}
        </Slider.Label>
        <Slider.Value className="shrink-0 text-xs text-muted tabular-nums" />
      </div>
      <Slider.Control className="flex h-5 w-full touch-none items-center select-none">
        <Slider.Track className="h-1 w-full rounded-full bg-ink/15">
          <Slider.Indicator className="rounded-full bg-ink" />
          <Slider.Thumb className="size-3.5 rounded-full bg-ink shadow-sm outline-none transition-[box-shadow] focus-visible:shadow-[0_0_0_4px] focus-visible:shadow-ink/20 data-dragging:shadow-[0_0_0_4px] data-dragging:shadow-ink/20" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
