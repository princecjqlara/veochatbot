import { afterEach, expect, it, vi } from 'vitest';
import { loadTagOptions } from '../load-tag-options';
afterEach(() => { vi.unstubAllGlobals(); });
it('reads every option beyond 1000 rows instead of truncating the dropdown', async () => {
    const items = Array.from({ length: 1201 }, (_, i) => ({ id: 'tag-' + i }));
    const fetcher = vi.fn(async (path: string) => { const page = Number(new URL(path, 'https://veo.test').searchParams.get('page'));return Response.json({ items: items.slice((page - 1) * 1000, page * 1000), total: items.length }); });
    vi.stubGlobal('fetch', fetcher);expect(await loadTagOptions('page')).toHaveLength(1201);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('fails clearly for incomplete, unauthorized or changing results', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ id: 'first' }], total: 2 })).mockResolvedValueOnce(Response.json({ items: [], total: 2 }));vi.stubGlobal('fetch', fetcher);
    await expect(loadTagOptions('page')).rejects.toThrow('Complete tag');
    fetcher.mockResolvedValueOnce(Response.json({ error: 'denied' }, { status: 403 }));await expect(loadTagOptions('page')).rejects.toThrow('Complete tag');
    fetcher.mockResolvedValueOnce(Response.json({ items: [{ id: 'first' }], total: 2 })).mockResolvedValueOnce(Response.json({ items: [{ id: 'second' }], total: 3 }));await expect(loadTagOptions('page')).rejects.toThrow('changed');
});
it('cancels the tag read when its Page is left', async () => {
    vi.stubGlobal('fetch', vi.fn((_path, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))));
    const controller = new AbortController(), pending = loadTagOptions('page', controller.signal);await Promise.resolve();controller.abort();await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
