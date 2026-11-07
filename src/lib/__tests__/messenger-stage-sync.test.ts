import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMessengerStageEvent, syncMessengerStageHistory } from '@/lib/messenger-stage-sync';

const notice = (label: string, at = '2026-11-01T10:00:00Z', id = label) => ({
    id, message: `Lead stage set to ${label}`, from: { id: 'page' }, created_time: at
});
afterEach(() => vi.unstubAllEnvs());

describe('authoritative Meta stage events', () => {
    it('keeps VEO invoice notices separate from explicit lead stages while preserving legacy behavior', async () => {
        const order = { ...notice('Qualified'), message: 'You created an order for PHP100. View: fb-pma://payments/orderdetails/?invoice_id=123' };
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'false'); expect(parseMessengerStageEvent(order, 'page')?.stage).toBe('order_created');
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); expect(parseMessengerStageEvent(order, 'page')).toBeNull();
        expect(parseMessengerStageEvent(notice('Order Created'), 'page')?.stage).toBe('order_created');
        const rpc = vi.fn().mockResolvedValue({ data: { applied: true } });
        expect(await syncMessengerStageHistory({ rpc }, { pageId: 'p', contactId: 'c', facebookPageId: 'page', messages: [notice('Qualified'), order] })).toEqual({ events: 1, applied: 1 });
        expect(rpc).toHaveBeenCalledTimes(1); expect(rpc.mock.calls[0][1].p_stage).toBe('qualified');
    });
    it.each([['Qualified', 'qualified'], ['Converted', 'converted'], ['Not Qualified', 'not_qualified'],
        ['Intake', 'new'], ['Contacted', 'engaged'], ['Custom consultation', 'engaged'], ['Opted Out', 'opted_out']])(
        'preserves the exact %s label and maps the current pipeline bucket', (label, stage) => {
            expect(parseMessengerStageEvent(notice(label), 'page')).toMatchObject({ label, stage });
        });
    it('rejects customer text, ordinary staff replies, missing timestamps and acknowledged old stages', () => {
        expect(parseMessengerStageEvent({ ...notice('Qualified'), from: { id: 'customer' } }, 'page')).toBeNull();
        expect(parseMessengerStageEvent({ ...notice('Qualified'), message: 'Thanks for your inquiry' }, 'page')).toBeNull();
        expect(parseMessengerStageEvent({ ...notice('Qualified'), created_time: undefined }, 'page')).toBeNull();
        expect(parseMessengerStageEvent(notice('Qualified'), 'page', { historyResetAt: '2026-11-01T11:00:00Z' })).toBeNull();
    });
    it('records a reversal in event order and keeps every historical observation', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { applied: true }, error: null });
        const result = await syncMessengerStageHistory({ rpc }, { pageId: 'db-page', contactId: 'contact', facebookPageId: 'page',
            messages: [notice('Not Qualified', '2026-11-01T12:00:00Z'), notice('Converted', '2026-11-01T11:00:00Z'), notice('Qualified')] });
        expect(result).toEqual({ events: 3, applied: 3 });
        expect(rpc.mock.calls.map(call => call[1].p_label)).toEqual(['Qualified', 'Converted', 'Not Qualified']);
        expect(rpc.mock.calls[2][1]).toMatchObject({ p_stage: 'not_qualified', p_occurred_at: '2026-11-01T12:00:00.000Z' });
    });
    it('counts stale/duplicate events without treating them as current stage changes', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { applied: false, reason: 'older_event' }, error: null });
        expect(await syncMessengerStageHistory({ rpc }, { pageId: 'p', contactId: 'c', facebookPageId: 'page', messages: [notice('Converted')] }))
            .toEqual({ events: 1, applied: 0 });
    });
    it('does not advance a scan checkpoint when durable stage storage fails', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'Database unavailable' } });
        await expect(syncMessengerStageHistory({ rpc }, { pageId: 'p', contactId: 'c', facebookPageId: 'page', messages: [notice('Qualified')] }))
            .rejects.toThrow('Database unavailable');
    });
});
