import { normalizeContactName } from './contact-names';

export async function readContactIdentityBatch(page: { fb_page_id: string; access_token: string }, cursor?: string, signal?: AbortSignal) {
    if (!/^\d+$/.test(page.fb_page_id) || !page.access_token) throw Object.assign(new Error('Page connection needs attention'), { status: 409 });
    if (cursor && (typeof cursor !== 'string' || cursor.length > 2048)) throw Object.assign(new Error('Invalid sync cursor'), { status: 400 });
    const url = new URL(`https://graph.facebook.com/v24.0/${page.fb_page_id}/conversations`);
    url.searchParams.set('fields', 'participants{id,name}');
    url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('after', cursor);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${page.access_token}` }, signal });
    const body = await response.json();
    if (!response.ok || body.error) throw Object.assign(new Error('Facebook could not read this Page. Check its connection and retry.'), { status: 502 });
    if (!Array.isArray(body.data) || body.data.length > 50) throw Object.assign(new Error('Facebook returned an invalid contact batch'), { status: 502 });
    const contacts = new Map<string, { psid: string; name: string | null }>();
    for (const conversation of body.data) for (const person of conversation.participants?.data || []) {
        if (typeof person.id !== 'string' || !/^\d{1,40}$/.test(person.id) || person.id === page.fb_page_id) continue;
        const name = typeof person.name === 'string' ? normalizeContactName(person.name) : null;
        contacts.set(person.id, { psid: person.id, name: name?.slice(0, 200) || null });
    }
    if (contacts.size > 50) throw Object.assign(new Error('Facebook returned too many contact identities'), { status: 502 });
    const next = body.paging?.next ? body.paging?.cursors?.after : null;
    if (body.paging?.next && (typeof next !== 'string' || !next || next.length > 2048 || next === cursor)) throw Object.assign(new Error('Facebook pagination did not advance; retry this batch'), { status: 502 });
    return { contacts: [...contacts.values()], next_cursor: typeof next === 'string' ? next : null };
}
