import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import ChatbotSalesSettings from './ChatbotSalesSettings';
import { DEFAULT_SALES_SETTINGS } from '@/lib/chatbot-sales-assistant';

describe('explicit sales-flow selection', () => {
    it('does not show an inactive pricing OFF switch or change empty settings while mounting the original flow', () => {
        const change = vi.fn(), disable = vi.fn(); let view: ReturnType<typeof create>;
        act(() => { view = create(<ChatbotSalesSettings value={{}} onChange={change} onDisable={disable} />); });
        expect(JSON.stringify(view!.toJSON())).toContain('Original in-chat sales flow is active');
        expect(view!.root.findAllByType('input')).toHaveLength(0); expect(change).not.toHaveBeenCalled();
        act(() => { view!.root.findByType('button').props.onClick(); }); expect(change).toHaveBeenCalledWith(DEFAULT_SALES_SETTINGS);
        act(() => { view!.unmount(); });
    });
    it('allows an explicitly configured assistant to return to the original flow', () => {
        const disable = vi.fn(); let view: ReturnType<typeof create>;
        act(() => { view = create(<ChatbotSalesSettings value={DEFAULT_SALES_SETTINGS} onChange={vi.fn()} onDisable={disable} />); });
        act(() => { view!.root.findAllByType('button').find(button => button.children.join('') === 'Use original in-chat flow instead')!.props.onClick(); });
        expect(disable).toHaveBeenCalledTimes(1); act(() => { view!.unmount(); });
    });
});
