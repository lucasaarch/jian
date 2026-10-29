'use client';

import type { ButtonHTMLAttributes } from 'react';

/**
 * A button that shows only an icon, so its label is required: it is the button's only name.
 * `control` stands beside a field, a select or a button and takes their height; the default is
 * the smaller one that sits in rows and headers.
 */
export function IconButton({
  size = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  'aria-label': string;
  size?: 'default' | 'control';
}) {
  return <button type="button" {...props} className={`icon-button ${size} ${className}`} />;
}
