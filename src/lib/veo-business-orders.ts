import { parseMoneyMinor } from './money-minor';
import type { MessengerHistoryMessage } from './messaging-auto-tag';
export type BusinessOrderNotice = { invoice_id: string; message_id: string; total_minor: number; currency: 'PHP'; occurred_at: string };
/** An exact Page-authored Meta order notice is an order source, never payment proof. */
export function parseBusinessOrderNotice(message: MessengerHistoryMessage, pageId: string, launchAt: string): BusinessOrderNotice | null {
    if (message.from?.id !== pageId || !message.id) return null;
    const at = Date.parse(message.created_time || '');
    if (!Number.isFinite(at) || at < Date.parse(launchAt) || at > Date.now()) return null;
    const match = /^You (?:created an order for|requested) (?:PHP|₱)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\.?(?:\s+View:\s*)(fb-pma:\/\/payments\/orderdetails\/\?[^\s]+)\s*$/i.exec(message.message?.trim() || '');
    if (!match) return null;
    try {
        const url = new URL(match[2]), invoice = url.searchParams.get('invoice_id');
        if (!invoice || !/^\d{1,80}$/.test(invoice)) return null;
        return { invoice_id: invoice, message_id: message.id, total_minor: parseMoneyMinor(match[1]), currency: 'PHP', occurred_at: new Date(at).toISOString() };
    } catch { return null; }
}

export async function fetchBusinessOrderNotices(input: { pageId: string; psid: string; token: string; launchAt: string }) {
    const start = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(input.pageId)}/conversations`);
    start.searchParams.set('user_id', input.psid);
    start.searchParams.set('fields', 'id,participants,messages.limit(100){id,message,from,created_time}');
    const headers = { Authorization: `Bearer ${input.token}` }, deadline = Date.now() + 25000;
    async function read(url: URL) {
        if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') throw Error('Unexpected Facebook pagination');
        url.searchParams.delete('access_token');
        const r = await fetch(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))) }), b = await r.json();
        if (!r.ok || b.error) throw Error(b.error?.code === 190 ? 'Facebook Page connection expired. Ask the Owner to reconnect it.' : 'Facebook could not return order notices. Check Page messaging access and retry.');
        return b;
    }
    const body = await read(start);
    if (!Array.isArray(body.data)) throw Error('Facebook conversation data unavailable');
    const thread = body.data.find((c: any) => c.participants?.data?.some((p: any) => String(p.id) === input.psid));
    if (!thread) return { orders: [] as BusinessOrderNotice[], complete: true, pages_checked: 0, coverage: 'No accessible Facebook conversation for this client.' };
    let batch = thread.messages, pages = 0, complete = false;
    const orders = new Map<string, BusinessOrderNotice>(), visited = new Set<string>();
    while (batch && pages < 5 && Date.now() < deadline) {
        if (!Array.isArray(batch.data)) throw Error('Facebook message data unavailable');
        pages++;
        for (const m of batch.data) {
            const order = parseBusinessOrderNotice(m, input.pageId, input.launchAt);
            if (order && !orders.has(order.invoice_id)) orders.set(order.invoice_id, order);
        }
        const reachedCutoff = batch.data.some((m: any) => Date.parse(m.created_time) < Date.parse(input.launchAt));
        if (!batch.paging?.next || reachedCutoff) { complete = true; break; }
        if (pages >= 5 || Date.now() >= deadline) break;
        const next = String(batch.paging.next);if (visited.has(next)) throw Error('Repeated Facebook pagination');visited.add(next);
        const url = new URL(next);url.searchParams.set('fields', 'id,message,from,created_time');
        batch = await read(url);
    }
    return { orders: [...orders.values()], complete, pages_checked: pages, coverage: complete ? 'Available order notices since launch checked. Meta may omit order details.' : 'Partial Facebook order-notice scan; older notices may be unavailable. Fetch again or check Business Suite.' };
}
