import { describe, expect, it } from 'vitest';
import {
    classifyMessengerSystemMessage,
    findLatestMessengerSystemSignal
} from './messaging-auto-tag';

describe('classifyMessengerSystemMessage', () => {
    it('accepts qualified, not-qualified, and converted stage records', () => {
        expect(classifyMessengerSystemMessage('Lead stage set to Qualified')).toBe('qualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Not Qualified')).toBe('not_qualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Disqualified.')).toBe('not_qualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Converted')).toBe('converted');
        expect(classifyMessengerSystemMessage('Lead stage set to Order Created')).toBe('order_created');
    });

    it('accepts explicit created and requested order notifications', () => {
        expect(classifyMessengerSystemMessage('You created an order for PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
        expect(classifyMessengerSystemMessage('You requested PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
    });

    it('does not mistake payment claims or ordinary text for a qualifying event', () => {
        expect(classifyMessengerSystemMessage('I paid PHP699')).toBeNull();
        expect(classifyMessengerSystemMessage('You created an order for PHP699')).toBeNull();
    });

    it('finds the newest Lead Center stage written by the Page', () => {
        expect(findLatestMessengerSystemSignal([
            {
                message: 'Lead stage set to Qualified',
                from: { id: 'page-1' },
                created_time: '2026-09-25T10:00:00Z'
            },
            {
                message: 'Lead stage set to Converted',
                from: { id: 'page-1' },
                created_time: '2026-09-26T10:00:00Z'
            }
        ], 'page-1')).toBe('converted');
    });

    it('ignores stage-like text sent by a customer', () => {
        expect(findLatestMessengerSystemSignal([{
            message: 'Lead stage set to Qualified',
            from: { id: 'customer-1' },
            created_time: '2026-09-26T10:00:00Z'
        }], 'page-1')).toBeNull();
    });
});
