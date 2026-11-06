import { NextRequest, NextResponse } from 'next/server';
import { getUserPageIds } from './page-access';
import { workspaceEnabled } from './veo-workspace';
export async function workspaceTagAllowed(actor: string, tag: any) {
    if (!workspaceEnabled()) return true;
    const page = tag.owner_type === 'page' ? tag.owner_id : tag.page_id;
    return Boolean(page && (await getUserPageIds(actor)).includes(page));
}
export async function workspaceManualTags(db: any, actor: string, pageId: string, tagIds: string[]) {
    if (!workspaceEnabled()) return true;
    for (let offset = 0; offset < tagIds.length; offset += 100) {
        const ids = tagIds.slice(offset, offset + 100), r = await db.from('tags').select('id,page_id,owner_type,owner_id,is_shared,is_default,system_key').in('id', ids);
        if (r.error) throw Error('Tag permissions are unavailable');
        if ((r.data || []).length !== ids.length || r.data.some((t: any) => t.is_default || t.system_key || (t.owner_type === 'page' ? t.owner_id !== pageId : t.page_id !== pageId || t.owner_id !== actor && !t.is_shared))) return false;
        const personal = r.data.filter((t: any) => t.owner_type === 'user' && t.owner_id !== actor).map((t: any) => t.id);
        if (personal.length) {
            const shares = await db.from('tag_shares').select('tag_id,shared_with_user_id').in('tag_id', personal);
            if (shares.error) throw Error('Tag sharing permissions are unavailable');
            if (personal.some((id: string) => shares.data?.some((s: any) => s.tag_id === id) && !shares.data?.some((s: any) => s.tag_id === id && s.shared_with_user_id === actor))) return false;
        }
    }
    return true;
}
export async function workspaceTagList(request: NextRequest, actor: string, db: any) {
    const q = request.nextUrl.searchParams, pageId = q.get('pageId'), ids = await getUserPageIds(actor);
    const page = Number(q.get('page') || 1), pageSize = Number(q.get('pageSize') || 50), kind = q.get('kind') || 'all', scope = q.get('scope') || 'all', search = (q.get('search') || '').trim().toLowerCase();
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !['all', 'manual', 'history', 'system'].includes(kind) || !['all', 'page', 'user', 'business'].includes(scope)) return NextResponse.json({ error: 'Invalid tag filters' }, { status: 400 });
    if (pageId && !ids.includes(pageId)) return NextResponse.json({ error: 'Page access denied' }, { status: 403 });
    const selected = pageId ? [pageId] : ids, tags: any[] = [];
    if (selected.length) for (let offset = 0; offset < 20000; offset += 1000) {
        const r = await db.from('tags').select('*').in('page_id', selected).order('name').order('id').range(offset, offset + 999);
        if (r.error) throw Error('Tags are unavailable'); tags.push(...(r.data || []));
        if ((r.data || []).length < 1000) break;
        if (offset === 19000) throw Error('Choose a Page to complete the tag list');
    }
    const personal = tags.filter(t => t.owner_type === 'user' && t.owner_id !== actor && t.is_shared).map(t => t.id);
    const shares = personal.length ? await db.from('tag_shares').select('tag_id,shared_with_user_id').in('tag_id', personal) : { data: [], error: null };
    if (shares.error) throw Error('Tag sharing permissions are unavailable');
    const recipients = new Map<string, string[]>(); for (const r of shares.data || []) recipients.set(r.tag_id, [...(recipients.get(r.tag_id) || []), r.shared_with_user_id]);
    const category = (t: any) => t.system_key?.startsWith('stage_history:') ? 'history' : t.system_key || t.is_default ? 'system' : 'manual';
    const allowed = tags.filter(t => t.owner_type === 'page' && t.owner_id === t.page_id || t.owner_type === 'user' && (t.owner_id === actor || t.is_shared && (!recipients.has(t.id) || recipients.get(t.id)!.includes(actor))));
    const visible = allowed.filter(t => (scope === 'all' || scope === t.owner_type && (scope !== 'user' || t.owner_id === actor)) && (!search || t.name.toLowerCase().includes(search)));
    const counts = Object.fromEntries(['manual', 'history', 'system'].map(k => [k, visible.filter(t => category(t) === k).length]));
    const filtered = visible.filter(t => kind === 'all' || category(t) === kind), items = filtered.slice((page - 1) * pageSize, page * pageSize).map(t => ({ ...t, shared_with_user_ids: recipients.get(t.id) || [] }));
    return NextResponse.json({ items, tags: items, page, pageSize, total: filtered.length, kind_counts: counts }, { headers: { 'Cache-Control': 'no-store' } });
}
