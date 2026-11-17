import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Controls from './VeoDisciplineControls';
let view: ReactTestRenderer;
const worker = { id: 'worker', name: 'Member', role: 'member', active: true, warning_count: 1, warnings: [{ key: 'overdue:order', severity: 'warning', title: 'Overdue project' }], discipline_policy: { warning_limit: 3 } };
const onChanged = vi.fn();
const text = (v: any): string => typeof v === 'string' ? v : (v?.children || []).map(text).join('');
beforeEach(() => { onChanged.mockClear();vi.stubGlobal('fetch', vi.fn(async () => Response.json({}))); });
afterEach(async () => { if (view) await act(async () => view.unmount());vi.unstubAllGlobals(); });
async function mount(members: any[] = [worker]) { await act(async () => { view = create(createElement(Controls, { workers: [...members, { id: 'manager', role: 'manager', name: 'Manager' }], policy: { warning_limit: 3, auto_suspend: false, suspension_minutes: null }, onChanged })); }); }
async function change(label: string, value: any) { await act(async () => view.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } })); }
async function submit(index = 1) { await act(async () => view.root.findAllByType('form')[index].props.onSubmit({ preventDefault() {} })); }
const payloads = () => vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
it('limits controls to members and records a warning with a stable retry reference', async () => {
    await mount();
    expect(view.root.findByProps({ 'aria-label': 'Discipline member' }).findAllByType('option').map(o => o.props.value)).toEqual(['', 'worker']);
    await change('Discipline member', 'worker');await change('Discipline reason', 'Repeated missed obligation');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: 'Save could not be confirmed' }, { status: 503 }));
    await submit();expect(onChanged).not.toHaveBeenCalled();await submit();
    expect(payloads()[0]).toMatchObject({ action: 'issue', user_id: 'worker', reason: 'Repeated missed obligation' });
    expect(payloads()[1].request_id).toBe(payloads()[0].request_id);expect(onChanged).toHaveBeenCalledOnce();
});
it('saves an automatic warning limit with an explicit manual-lift suspension default', async () => {
    await mount();await change('Warnings before suspension', '2');
    await act(async () => view.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
    await submit(0);expect(payloads()[0]).toEqual({ action: 'policy', warning_limit: 2, auto_suspend: true, suspension_minutes: null });
});
it('submits timed suspensions in minutes and warning removal with the selected source key', async () => {
    await mount();await change('Discipline member', 'worker');await change('Discipline action', 'suspend');
    await change('Suspension ending', 'timed');await change('Suspension duration', '2');await change('Suspension duration unit', '60');
    await change('Discipline reason', 'Two-hour supervisor review');await submit();
    expect(payloads()[0]).toMatchObject({ action: 'suspend', user_id: 'worker', duration_minutes: 120 });
    await change('Discipline action', 'remove');await change('Warning to remove', 'overdue:order');await change('Discipline reason', 'Excused after review');await submit();
    expect(payloads()[1]).toEqual({ action: 'remove', user_id: 'worker', source_key: 'overdue:order', reason: 'Excused after review' });
});
it('lifts only the displayed suspension and explains when manual lifting is required', async () => {
    await mount([{ ...worker, suspension: { id: 'current', reason: 'Conduct review', ends_at: null } }]);
    await change('Discipline member', 'worker');expect(view.root.findByProps({ 'aria-label': 'Discipline action' }).props.value).toBe('lift');
    expect(text(view.toJSON())).toContain('must lift it');
    await change('Discipline reason', 'Review completed');await submit();
    expect(payloads()[0]).toEqual({ action: 'lift', user_id: 'worker', suspension_id: 'current', reason: 'Review completed' });
});
