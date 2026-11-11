import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import Access from './VeoAccountAccess';
let view: ReactTestRenderer;
const text = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
afterEach(async () => { if (view) await act(async () => view.unmount());vi.unstubAllGlobals(); });
it('explains missing login setup, keeps reset available for configured emails, and never edits departed accounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ accounts: [
        { id: 'one', name: 'Recovered leader', role: 'team_leader', active: true, status: 'email_required' },
        { id: 'two', name: 'Configured manager', role: 'manager', email: 'manager@example.com', active: true, status: 'ready' },
        { id: 'three', name: 'Former staff', role: 'member', active: false, status: 'departed' },
        { id: 'four', name: 'Locked staff', role: 'member', active: true, status: 'temporarily_locked', retry_at: '2026-11-12T00:00:00Z' }
    ] })));
    await act(async () => { view = create(createElement(Access, { onSaved: vi.fn() })); });
    const content = text(view.toJSON());expect(content).toContain('2 accounts need sign-in attention');expect(content).toContain('Login email and password required');expect(content).toContain('Cooldown ends');
    expect(view.root.findAllByType('form')).toHaveLength(3);
    expect(view.root.findAllByType('input').some(i => i.props.defaultValue === 'manager@example.com')).toBe(true);
    expect(content).not.toContain('Set up sign-in: Former staff');
});
it('keeps status failures visible and supports a fresh retry', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Status unavailable' }, { status: 503 })).mockResolvedValueOnce(Response.json({ accounts: [] }));vi.stubGlobal('fetch', fetch);
    await act(async () => { view = create(createElement(Access, { onSaved: vi.fn() })); });expect(text(view.toJSON())).toContain('Status unavailable');
    await act(async () => view.root.findAllByType('button')[0].props.onClick());expect(text(view.toJSON())).toContain('All active accounts have sign-in configured');
});
