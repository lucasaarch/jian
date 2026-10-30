import { afterEach, vi } from 'vitest';
import { route } from './route';

// Outside Next there is no router; a test sets `route` to the address it renders at.
vi.mock('next/navigation', () => ({
  useParams: () => route.params,
  usePathname: () => route.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('notFound');
  },
}));

afterEach(() => {
  route.params = {};
  route.pathname = '/';
});
