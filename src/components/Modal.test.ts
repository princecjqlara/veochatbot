import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Modal from './Modal';

let views: ReactTestRenderer[], listeners: Set<(event: any) => void>, doc: any;
beforeEach(() => {
    views = []; listeners = new Set();
    doc = { activeElement: null, body: { style: { overflow: 'scroll' } }, addEventListener: (_: string, callback: any) => listeners.add(callback), removeEventListener: (_: string, callback: any) => listeners.delete(callback) };
    vi.stubGlobal('document', doc);
});
afterEach(async () => { for (const view of views.reverse()) await act(async () => view.unmount()); vi.unstubAllGlobals(); });
function element() {
    const node: any = { isConnected: true, matches: () => false, closest: () => null, getClientRects: () => [{}] };
    node.focus = vi.fn(() => { doc.activeElement = node; });
    return node;
}
async function open(title = 'Confirm') {
    const first = element(), last = element(), dialog = element(), close = vi.fn();
    dialog.querySelectorAll = () => [first, last];
    dialog.contains = (node: any) => [first, last, dialog].includes(node);
    let view!: ReactTestRenderer;
    await act(async () => { view = create(createElement(Modal, { isOpen: true, onClose: close, title }, 'Content'), { createNodeMock: node => node.props.role === 'dialog' ? dialog : null }); });
    views.push(view);
    return { first, last, dialog, close, view };
}
async function key(key: string, shiftKey = false) {
    const event = { key, shiftKey, preventDefault: vi.fn() };
    await act(async () => { for (const listener of [...listeners]) listener(event); });
    return event;
}
it('keeps keyboard focus inside the dialog and restores the opening control and original scroll state', async () => {
    const opener = element(); doc.activeElement = opener;
    const modal = await open();
    expect(doc.activeElement).toBe(modal.first);
    expect(doc.body.style.overflow).toBe('hidden');
    doc.activeElement = modal.last;
    expect((await key('Tab')).preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(modal.first);
    await key('Tab', true); expect(doc.activeElement).toBe(modal.last);
    await key('Escape'); expect(modal.close).toHaveBeenCalledOnce();
    await act(async () => modal.view.unmount()); views = [];
    expect(doc.activeElement).toBe(opener); expect(doc.body.style.overflow).toBe('scroll'); expect(listeners.size).toBe(0);
});
it('gives nested dialogs distinct labels and closes only the top dialog on Escape', async () => {
    const parent = await open('Parent'), child = await open('Child');
    const parentId = parent.view.root.findByProps({ role: 'dialog' }).props['aria-labelledby'];
    expect(child.view.root.findByProps({ role: 'dialog' }).props['aria-labelledby']).not.toBe(parentId);
    await key('Escape'); expect(child.close).toHaveBeenCalledOnce(); expect(parent.close).not.toHaveBeenCalled();
    await act(async () => child.view.unmount()); views.pop();
    expect(doc.body.style.overflow).toBe('hidden'); expect(doc.activeElement).toBe(parent.first);
    await key('Escape'); expect(parent.close).toHaveBeenCalledOnce();
});
