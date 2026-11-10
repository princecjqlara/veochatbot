import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import VeoContactTags from './VeoContactTags';
afterEach(() => { vi.unstubAllGlobals(); });
it('adds available manual tags and preserves system-history tags as read-only', async () => {
    const changed = vi.fn(async () => {}), fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'manual', name: 'Follow up' }], total: 1 }) }).mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetcher); let tree: any;
    await act(async () => { tree = create(React.createElement(VeoContactTags, { contactId: 'client', pageId: 'veo', tags: [{ id: 'system', name: 'Converted history', system_key: 'stage_history:converted' }], onChanged: changed })); });
    expect(tree.root.findAllByProps({ 'aria-label': 'Remove Converted history tag' })).toHaveLength(0);
    await act(async () => tree.root.findByProps({ 'aria-label': 'Contact tag' }).props.onChange({ target: { value: 'manual' } }));
    await act(async () => tree.root.findAllByType('button').find((b: any) => b.children.join('') === 'Add tag').props.onClick());
    expect(changed).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[1][0]).toContain('bulk-add-tags');
});
it('shows failed tagging without claiming a successful update', async () => {
    const changed = vi.fn(async () => {}); vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'manual', name: 'Follow up' }], total: 1 }) }).mockResolvedValue({ ok: false, json: async () => ({ error: 'Page access denied' }) }));
    let tree: any; await act(async () => { tree = create(React.createElement(VeoContactTags, { contactId: 'client', pageId: 'veo', tags: [], onChanged: changed })); });
    await act(async () => tree.root.findByProps({ 'aria-label': 'Contact tag' }).props.onChange({ target: { value: 'manual' } }));
    await act(async () => tree.root.findAllByType('button').find((b: any) => b.children.join('') === 'Add tag').props.onClick());
    expect(changed).not.toHaveBeenCalled(); expect(JSON.stringify(tree.toJSON())).toContain('Page access denied'); expect(JSON.stringify(tree.toJSON())).not.toContain('Tag added.');
});
it('loads manual tags after the first 1000 and makes their remove action available', async () => {
    const tags = Array.from({ length: 1001 }, (_, index) => ({ id: 'tag-' + index, name: 'Manual ' + index }));
    const fetcher = vi.fn(async (path: string) => { const params = new URL(path, 'https://veo.test').searchParams; expect(params.get('kind')).toBe('manual'); const page = Number(params.get('page')); return Response.json({ items: tags.slice((page - 1) * 1000, page * 1000), total: tags.length }); });
    vi.stubGlobal('fetch', fetcher); let tree: any;
    await act(async () => { tree = create(React.createElement(VeoContactTags, { contactId: 'client', pageId: 'page', tags: [tags[1000]], onChanged: async () => {} })); });
    try { expect(fetcher).toHaveBeenCalledTimes(2); expect(tree.root.findByProps({ 'aria-label': 'Remove Manual 1000 tag' })).toBeTruthy(); expect(tree.root.findByProps({ 'aria-label': 'Contact tag' }).findAllByType('option')).toHaveLength(1001); }
    finally { await act(async () => tree.unmount()); }
});
it('rejects a partial tag list and retries the complete list before enabling tag changes', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ id: 'first', name: 'First' }], total: 2 })).mockResolvedValueOnce(Response.json({ error: 'source unavailable' }, { status: 503 }));
    vi.stubGlobal('fetch', fetcher); let tree: any;
    await act(async () => { tree = create(React.createElement(VeoContactTags, { contactId: 'client', pageId: 'page', tags: [], onChanged: async () => {} })); });
    try {
        expect(tree.root.findByProps({ role: 'alert' })).toBeTruthy(); expect(tree.root.findByProps({ 'aria-label': 'Contact tag' }).props.disabled).toBe(true);
        fetcher.mockResolvedValueOnce(Response.json({ items: [{ id: 'second', name: 'Recovered tag' }], total: 1 }));
        await act(async () => tree.root.findAllByType('button').find((button: any) => button.children.includes('Retry tags')).props.onClick());
        expect(tree.root.findByProps({ 'aria-label': 'Contact tag' }).props.disabled).toBe(false); expect(JSON.stringify(tree.toJSON())).toContain('Recovered tag');
    } finally { await act(async () => tree.unmount()); }
});
