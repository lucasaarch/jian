'use client';

import type { ButtonHTMLAttributes } from 'react';

/**
 * A button that shows only an icon, so its label is required: it is the button's only name.
 * `control` stands beside a field, a select or a button and takes their height; the default is
 * the smaller one that sits in rows and headers. `primary` is filled, for the one action a
 * place is for; the default stays quiet until pointed at.
 */
export function IconButton({
  size = 'default',
  variant = 'ghost',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  'aria-label': string;
  size?: 'default' | 'control';
  variant?: 'ghost' | 'primary';
}) {
  return (
    <button type="button" {...props} className={`icon-button ${size} ${variant} ${className}`} />
  );
}
