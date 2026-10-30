'use client';

/** An agent's face in the kit: its picture, or its initial on glass. `size` in rem. */
export function AgentFace({
  name,
  avatar,
  size = 1.5,
}: {
  name: string;
  avatar?: string | null;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ width: `${size}rem`, height: `${size}rem`, fontSize: `${size * 0.45}rem` }}
      className="grid shrink-0 place-items-center overflow-hidden rounded-full border border-glass-edge bg-glass-press font-semibold text-ink [&_img]:size-full [&_img]:object-cover"
    >
      {avatar ? <img src={avatar} alt="" /> : name.slice(0, 1).toLocaleUpperCase()}
    </span>
  );
}
