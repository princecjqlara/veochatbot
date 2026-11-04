import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), signIn: vi.fn(), sync: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: m.session, signIn: m.signIn }));
vi.mock('@/lib/contact-sync-client', () => ({ runContactSyncToCompletion: m.sync }));
import ConnectPage from './page';
let view: ReactTestRenderer | undefined;
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const pages = [{ id: '100', name: 'Page A', access_token: 'token-a' }, { id: '200', name: 'Page B', access_token: 'token-b' }];
const buttons = (label: string) => view!.root.findAllByType('button').filter(button => text(button) === label);
beforeEach(() => {
 vi.clearAllMocks(); m.session.mockReturnValue({ data: { user: { id: 'owner' } }, status: 'authenticated' });
 m.sync.mockResolvedValue({ completed: true, totalSynced: 3, totalFailed: 0 });
});
afterEach(() => { if (view) act(() => view!.unmount()); view = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Connect Page actions', () => {
 it('recovers the screen when starting Facebook reauthorization fails', async () => {
  m.signIn.mockRejectedValueOnce(Error('Network unavailable'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/facebook/pages' ? json({ pages }) : json({ pages: [] })));
  await act(async () => { view = create(createElement(ConnectPage)); });
  await act(async () => { await buttons('Refresh Permissions')[0].props.onClick(); });
  expect(text(view!.root)).toContain('Facebook sign-in could not be started'); expect(buttons('Connect')).toHaveLength(2);
 });
 it('shows a database failure without claiming a disconnected status or starting contact sync', async () => {
  const network = vi.fn(async (url: string) => url === '/api/facebook/pages' ? json({ pages }) : json({ error: 'Database unavailable', message: 'Database is not responding', code: 'DATABASE_UNAVAILABLE' }, 503));
  vi.stubGlobal('fetch', network); await act(async () => { view = create(createElement(ConnectPage)); });
  expect(text(view!.root)).toContain('Status unavailable'); expect(text(view!.root)).not.toContain('Not Connected');
  await act(async () => { await buttons('Connect')[0].props.onClick(); });
  expect(text(view!.root)).toContain('Database is not responding'); expect(buttons('Connect')[0].props.disabled).toBe(false); expect(m.sync).not.toHaveBeenCalled();
 });
 it('confirms connection immediately and releases other Connect actions during a long initial sync', async () => {
  m.sync.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/facebook/pages' ? json({ pages }) : url.startsWith('/api/pages?') ? json({ pages: [] }) : json({ success: true, pageId: 'page-row', webhookSubscribed: true })));
  await act(async () => { view = create(createElement(ConnectPage)); });
  await act(async () => { await buttons('Connect')[0].props.onClick(); });
  expect(text(view!.root)).toContain('Successfully connected "Page A".'); expect(text(view!.root)).not.toContain('Connecting...');
  expect(buttons('Syncing contacts...')).toHaveLength(1); expect(buttons('Connect')[0].props.disabled).toBe(false);
  expect(m.sync).toHaveBeenCalledWith('page-row', expect.objectContaining({ forceFullSync: false }));
 });
 it('bulk syncs only verified saved Pages and resumes incrementally', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/facebook/pages' ? json({ pages }) : json({ pages: [
   { id: 'page-row-a', fb_page_id: '100', connectionStatus: 'ready' },
   { id: 'page-row-b', fb_page_id: '200', connectionStatus: 'ready' }
  ] })));
  await act(async () => { view = create(createElement(ConnectPage)); });
  await act(async () => { await buttons('Sync all connected Pages')[0].props.onClick(); });
  expect(m.sync).toHaveBeenNthCalledWith(1, 'page-row-a', { forceFullSync: false });
  expect(m.sync).toHaveBeenNthCalledWith(2, 'page-row-b', { forceFullSync: false });
 });
 it('requires a reconnect after partial webhook setup and does not start sync or show success', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/facebook/pages' ? json({ pages }) : url.startsWith('/api/pages?') ? json({ pages: [] }) : json({ success: false, saved: true, requiresReauth: true, message: 'Refresh Permissions to finish setup' }, 409)));
  await act(async () => { view = create(createElement(ConnectPage)); });
  await act(async () => { await buttons('Connect')[0].props.onClick(); });
  expect(text(view!.root)).toContain('Setup incomplete'); expect(buttons('Reconnect')).toHaveLength(1); expect(m.sync).not.toHaveBeenCalled();
  expect(text(view!.root)).not.toContain('Successfully connected');
 });
 it('does not let an older status request overwrite a successful Connect result', async () => {
  let release!: (value: Response) => void; const pending = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/facebook/pages' ? json({ pages }) : url.startsWith('/api/pages?') ? pending : json({ success: true, pageId: 'page-row', webhookSubscribed: true })));
  await act(async () => { view = create(createElement(ConnectPage)); });
  await act(async () => { await buttons('Connect')[0].props.onClick(); });
  await act(async () => { release(json({ pages: [] })); await pending; });
  expect(buttons('Reconnect')).toHaveLength(1); expect(text(view!.root)).toContain('Connected. Synced 3 contacts.');
 });
});
