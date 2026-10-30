import { Search } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';

/** A text field with the search icon inside it. The label names what is searched. */
export function SearchField({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { 'aria-label': string }) {
  return (
    <div className={`search-field ${className}`}>
      <Search size={16} aria-hidden="true" />
      <input {...props} />
    </div>
  );
}
