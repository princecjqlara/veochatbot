import { uuid } from './veo-workspace';

export function telegramGroupCatalog(groups: any[], pages: any[], approved: Set<string>) {
    if (!Array.isArray(groups) || groups.length > 200) throw Error('Invalid bot directory');
    return groups.filter(g => Number.isSafeInteger(Number(g.chat_id)) && Number(g.chat_id) < 0 && approved.has(String(g.chat_id))).map(g => ({
        chat_id: Number(g.chat_id), name: String(g.name || 'Unnamed group').slice(0, 200),
        topics: Object.fromEntries(Object.entries(g.topics || {}).filter(([key, value]) => ['close', 'done', 'announcements', 'active', 'clients'].includes(key) && Number.isSafeInteger(Number(value)) && Number(value) > 0)),
        pages: Object.entries(g.pages || {}).slice(0, 100).map(([name, source]) => {
            const sourceId = String(source), match = pages.find(p => p.id === sourceId || p.fb_page_id === sourceId);
            return { id: match?.id || null, name: String(match?.name || name).slice(0, 200), source_id: sourceId.slice(0, 200), matched: !!match };
        }),
        identities: (g.identities || []).filter((p: any) => Number.isSafeInteger(Number(p.user_id)) && Number(p.user_id) > 0).slice(0, 2000)
            .map((p: any) => ({ user_id: Number(p.user_id), name: String(p.name || 'Unknown name').slice(0, 200), membership: String(p.membership || 'unverified').slice(0, 40) }))
    }));
}

export function telegramGroupInput(body: any) {
    if (!['refresh', 'group', 'remove_group', 'membership', 'remove_membership'].includes(body?.action)) throw Error('Choose a group action');
    if (body.action === 'refresh') return;
    if (!Number.isSafeInteger(Number(body.chat_id)) || Number(body.chat_id) >= 0) throw Error('Choose a valid Telegram group');
    for (const key of ['primary', 'move_pages']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw Error('Choose valid group options');
    if (['group', 'remove_group'].includes(body.action) && !uuid(body.team_id)) throw Error('Choose a team');
    if (['membership', 'remove_membership'].includes(body.action) && !uuid(body.user_id)) throw Error('Choose an account');
    if (body.action === 'group' && (!Array.isArray(body.page_ids) || body.page_ids.length < 1 || body.page_ids.length > 100 || !body.page_ids.every(uuid))) throw Error('Choose at least one permitted Page');
    if (body.thread_id != null && body.thread_id !== '' && (!Number.isSafeInteger(Number(body.thread_id)) || Number(body.thread_id) <= 0)) throw Error('Choose a valid topic');
    if (body.action === 'membership' && (!Number.isSafeInteger(Number(body.telegram_user_id)) || Number(body.telegram_user_id) <= 0)) throw Error('Choose a numeric human Telegram identity');
}
