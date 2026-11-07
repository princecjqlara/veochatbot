import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import Integration from './VeoJaucianIntegration';
const flatten = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(flatten).join('');
afterEach(() => { vi.unstubAllGlobals(); });
const data = {
    jaucian: { checked_at: '2026-11-06T00:00:00Z', veo_connection: { ok: true }, recent_deliveries: [],
        groups: [{ chat_id: -123, name: 'Veo Existing', topics: { announcements: 5 }, identities: [{ user_id: 42, name: 'Telegram Person' }] }] },
    workspace: { teams: [{ id: 'team', name: 'App Team', manager_id: 'manager', telegram_chat_id: -123 }],
        accounts: [{ user_id: 'worker', role: 'member', name: 'App Worker', parent_id: 'manager', telegram_username: 'declared' }] }
};
it('shows missing setup and uses the mapped group’s observed identities without auto-binding a declared username', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
    const submit = vi.fn().mockResolvedValue({ saved: true });
    let view: any;
    await act(async () => { view = create(createElement(Integration, { submit, busy: false })); });
    try {
        expect(flatten(view.toJSON())).toContain('1 workers without a Telegram identity');
        expect(flatten(view.toJSON())).toContain('Jaucian can read VEO');
        const workerSelect = view.root.findAllByType('select').find((s: any) => s.findAllByType('option').some((o: any) => o.props.value === 'worker'));
        await act(async () => workerSelect.props.onChange({ target: { value: 'worker' } }));
        const identity = view.root.findAllByType('input').find((i: any) => i.props.pattern);
        expect(identity.props.value).toBe('');
        const observed = view.root.findAllByType('select').find((s: any) => s.findAllByType('option').some((o: any) => o.props.value === '42'));
        await act(async () => observed.props.onChange({ target: { value: '42' } }));
        await act(async () => view.root.findAllByType('form')[1].props.onSubmit({ preventDefault() {} }));
        expect(submit).toHaveBeenCalledWith({ action: 'mapping', user_id: 'worker', telegram_user_id: '42', chat_id: '-123' });
        expect(flatten(view.toJSON())).toContain('No workspace deliveries recorded yet');
    } finally { await act(async () => view.unmount()); }
});
it('shows an upstream failure explicitly and offers refresh without showing usable mapping forms', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Jaucian unavailable' }), { status: 503 })));
    let view: any;
    await act(async () => { view = create(createElement(Integration, { submit: vi.fn(), busy: false })); });
    try { expect(flatten(view.toJSON())).toContain('Jaucian unavailable'); expect(view.root.findAllByType('form')).toHaveLength(0); }
    finally { await act(async () => view.unmount()); }
});
it('distinguishes Closed and Done confirmations from availability polls in the delivery history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...data, jaucian: { ...data.jaucian, recent_deliveries: [
        { id: 1, chat_id: -123, status: 'sent', attempts: 1, veo_receipt_kind: 'closed' },
        { id: 2, chat_id: -123, status: 'sent', attempts: 1, veo_receipt_kind: 'done' },
        { id: 3, chat_id: -123, status: 'sent', attempts: 1, veo_availability_date: '2026-11-08' }
    ] } }))));
    let view: any;
    await act(async () => { view = create(createElement(Integration, { submit: vi.fn(), busy: false })); });
    try { const text = flatten(view.toJSON()); expect(text).toContain('Closed Deal confirmation'); expect(text).toContain('Done Deal confirmation'); expect(text).toContain('Active-tomorrow poll 2026-11-08'); }
    finally { await act(async () => view.unmount()); }
});
