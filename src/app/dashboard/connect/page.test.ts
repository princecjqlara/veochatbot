import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: m.redirect }));
import Page from './page';
it('retires Facebook connection setup and returns to the workspace', () => { Page(); expect(m.redirect).toHaveBeenCalledWith('/dashboard/workspace'); });
