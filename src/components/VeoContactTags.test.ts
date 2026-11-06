import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import VeoContactTags from './VeoContactTags';
afterEach(() => { vi.unstubAllGlobals(); });
it('adds available manual tags and preserves system-history tags as read-only', async () => {
    const changed = vi.fn(async () => {}), fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'manual', name: 'Follow up' }] }) }).mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetcher); let tree: any;
    await act(async () => { tree = create(React.createElement(VeoContactTags, { contactId: 'client', pageId: 'veo', tags: [{ id: 'system', name: 'Converted history', system_key: 'stage_history:converted' }], onChanged: changed })); });
    expect(tree.root.findAllByProps({ 'aria-label': 'Remove Converted history tag' })).toHaveLength(0);
    await act(async () => tree.root.findByProps({ 'aria-label': 'Contact tag' }).props.onChange({ target: { value: 'manual' } }));
    await act(async () => tree.root.findAllByType('button').find((b: any) => b.children.join('') === 'Add tag').props.onClick());
    expect(changed).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[1][0]).toContain('bulk-add-tags');
});
it('shows failed tagging without claiming a successful update', async () => {
    const changed = vi.fn(async () => {}); vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'manual', name: 'Follow up' }] }) }).mockResolvedValue({ ok: false, json: async () => ({ error: 'Page access denied' }) }));
    let tree: any; await act(async () => { tree = create(React.createElement(VeoContactTags, { contactId: 'client', pageId: 'veo', tags: [], onChanged: changed })); });
    await act(async () => tree.root.findByProps({ 'aria-label': 'Contact tag' }).props.onChange({ target: { value: 'manual' } }));
    await act(async () => tree.root.findAllByType('button').find((b: any) => b.children.join('') === 'Add tag').props.onClick());
    expect(changed).not.toHaveBeenCalled(); expect(JSON.stringify(tree.toJSON())).toContain('Page access denied'); expect(JSON.stringify(tree.toJSON())).not.toContain('Tag added.');
});
