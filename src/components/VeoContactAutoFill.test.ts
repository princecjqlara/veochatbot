import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import AutoFill from './VeoContactAutoFill';
let view: ReactTestRenderer;
const text = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('adds customer detail targets, explains unknowns and reports existing fields without duplicating them', async () => {
    const changed = vi.fn(async () => {}), fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ duplicate: true, requested_fields: [], analysis: { status: 'ready' } }))); vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(AutoFill, { contactId: 'contact', data: { analysis: { status: 'ready' } }, onChanged: changed })); });
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => view.root.findByType('input').props.onChange({ target: { value: 'Purpose' } }));
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ action: 'request', label: 'Purpose' });
    expect(text(view.toJSON())).toContain('already tracked'); expect(changed).toHaveBeenCalledTimes(1);
    expect(text(view.toJSON())).toContain('Manual corrections');
});
it('polls lightweight analysis metadata and reloads the main profile only when new analysis is ready', async () => {
    vi.useFakeTimers(); const changed = vi.fn(async () => {});
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ analysis: { status: 'queued', analyzed_at: null } }))).mockResolvedValueOnce(new Response(JSON.stringify({ analysis: { status: 'ready', analyzed_at: '2026-11-07T01:00:00Z' } })));
    vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(AutoFill, { contactId: 'contact', data: { analysis: { status: 'queued' } }, onChanged: changed })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(changed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(changed).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/workspace/profile-details?contact_id=contact');
});
