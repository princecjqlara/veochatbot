import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import VeoContactDemographics from './VeoContactDemographics';
afterEach(() => vi.unstubAllGlobals());
it('ignores a late demographic response for the previous contact', async () => {
    let oldReply: any; const old = new Promise(resolve => { oldReply = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old).mockResolvedValue({ ok: true, json: async () => ({ contact_id: 'new', fields: [{ key: 'city', group: 'Location', label: 'City', value: 'Cebu', source: 'manual' }] }) }));
    let tree: any; await act(async () => { tree = create(React.createElement(VeoContactDemographics, { contactId: 'old' })); });
    await act(async () => { tree.update(React.createElement(VeoContactDemographics, { contactId: 'new' })); });
    await act(async () => { oldReply({ ok: true, json: async () => ({ contact_id: 'old', fields: [{ key: 'city', group: 'Location', label: 'City', value: 'Manila', source: 'ai' }] }) }); });
    expect(tree.root.findByProps({ 'aria-label': 'City' }).props.value).toBe('Cebu'); tree.unmount();
});
