import { createElement, useEffect, useState } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import VeoDeferredSection from './VeoDeferredSection';

it('loads a report on first open and retains its data and edits while collapsed', async () => {
    const load = vi.fn();
    function Report() {
        const [value, setValue] = useState('');
        useEffect(() => { load(); }, []);
        return createElement('input', { value, onChange: (event: any) => setValue(event.target.value) });
    }
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(createElement(VeoDeferredSection, { title: 'Report' }, createElement(Report))); });
    try {
        expect(load).not.toHaveBeenCalled();
        const toggle = () => view.root.findByType('button').props.onClick();
        await act(async () => toggle());
        await act(async () => view.root.findByType('input').props.onChange({ target: { value: 'Unsaved filter' } }));
        await act(async () => toggle());
        expect(view.root.findByType('div').props.hidden).toBe(true);
        await act(async () => toggle());
        expect(view.root.findByType('input').props.value).toBe('Unsaved filter');
        expect(load).toHaveBeenCalledOnce();
    } finally { await act(async () => view.unmount()); }
});
