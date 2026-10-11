import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), getSupabaseAdmin: vi.fn(),
    sendUtilityMessage: vi.fn(), stopChatbotForManualReply: vi.fn(), recordOutboundMessageEvent: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/facebook', () => ({ sendUtilityMessage: mocks.sendUtilityMessage }));
vi.mock('@/lib/chatbot-handoff', () => ({ stopChatbotForManualReply: mocks.stopChatbotForManualReply }));
vi.mock('@/lib/outbound-message-events', () => ({ recordOutboundMessageEvent: mocks.recordOutboundMessageEvent }));
import { POST } from './route';

function request() {
    return new NextRequest('http://localhost/api/facebook/templates/send', { method: 'POST',
        body: JSON.stringify({ pageId: 'page', recipientPsid: 'customer', templateName: 'notice', messageText: 'Hello' }) });
}
describe('manual template handoffs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'agent', name: 'Agent' } });
        mocks.getSupabaseAdmin.mockReturnValue({ from: (table: string) => {
            const chain: any = { select: () => chain, eq: () => chain,
                single: async () => ({ data: table === 'pages' ? { fb_page_id: 'fb-page', access_token: 'token' } : { page_id: 'page' }, error: null }),
                maybeSingle: async () => ({ data: { id: 'contact' }, error: null }) };
            return chain;
        } });
        mocks.stopChatbotForManualReply.mockResolvedValue(null);
        mocks.sendUtilityMessage.mockResolvedValue({ message_id: 'template', recipient_id: 'customer' });
        mocks.recordOutboundMessageEvent.mockResolvedValue(undefined);
    });
    it('saves the human handoff before sending a manual utility template', async () => {
        const order: string[] = [];
        mocks.stopChatbotForManualReply.mockImplementationOnce(async () => { order.push('stop'); return null; });
        mocks.sendUtilityMessage.mockImplementationOnce(async () => { order.push('send'); return { message_id: 'template' }; });
        expect((await POST(request())).status).toBe(200);
        expect(order).toEqual(['stop', 'send']);
        expect(mocks.stopChatbotForManualReply).toHaveBeenCalledWith(expect.objectContaining({ pageId: 'page', contactId: 'contact' }));
    });
    it('does not send a manual template when the handoff cannot be saved', async () => {
        mocks.stopChatbotForManualReply.mockRejectedValueOnce(new Error('Database unavailable'));
        expect((await POST(request())).status).toBe(500);
        expect(mocks.sendUtilityMessage).not.toHaveBeenCalled();
    });
    it('does not touch the bot or send anything without a signed-in staff identity', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);
        expect((await POST(request())).status).toBe(401);
        expect(mocks.stopChatbotForManualReply).not.toHaveBeenCalled();
        expect(mocks.sendUtilityMessage).not.toHaveBeenCalled();
    });
});
