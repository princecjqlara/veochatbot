import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'owner', role: 'owner' } } }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
import Details from './VeoContactDetails';
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); });
const fixture = (name: string) => ({ details: { fields: { Business: name } }, orders: [], payments: [], lifetime_value: {}, coverage: 'Recorded since launch' });
it('routes order and settlement shortcuts to the working receipts flow for the current client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture('Cafe'))));
    await act(async () => { view = create(createElement(Details, { contactId: 'client', pageId: 'page', name: 'Client' })); });
    const links = view.root.findAllByType('a').map(link => link.props.href);
    expect(links).toContain('/dashboard/workspace?view=receipts&contact_id=client'); expect(links).toContain('/dashboard/workspace?view=receipts&receipt_kind=done&contact_id=client');
    expect(links.some(link => link.includes('view=dashboard') || link.includes('view=clients'))).toBe(false);
});
it('clears the previous contact’s editable fields until the current details are loaded', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((path: string) => path.endsWith('second') ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json(fixture('First Client Business')))));
    await act(async () => { view = create(createElement(Details, { contactId: 'first', pageId: 'page', name: 'First' })); });
    expect(view.root.findByProps({ 'aria-label': 'Business' }).props.value).toBe('First Client Business');
    await act(async () => view.update(createElement(Details, { contactId: 'second', pageId: 'page', name: 'Second' })));
    expect(view.root.findAllByType('form')).toHaveLength(0); expect(JSON.stringify(view.toJSON())).not.toContain('First Client Business');
    await act(async () => { finish(Response.json(fixture('Second Client Business'))); });
    expect(view.root.findByProps({ 'aria-label': 'Business' }).props.value).toBe('Second Client Business');
});
