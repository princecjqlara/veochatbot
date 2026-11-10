import { requestDeadline } from './request-deadline';
import type { Tag } from '@/types';
/** Complete current options. Failed or changing pages never become a partial list. */
export function loadTagOptions(pageId: string, parent?: AbortSignal, kind: 'all' | 'manual' = 'all') {
    return requestDeadline(async signal => {
        const tags: Tag[] = [], seen = new Set<string>();let expected: number | undefined;
        for (let page = 1; ; page++) {
            const q = new URLSearchParams({ scope: 'all', pageId, page: String(page), pageSize: '1000' });
            if (kind !== 'all') q.set('kind', kind);
            const response = await fetch('/api/tags?' + q, { cache: 'no-store', signal });
            const body = await response.json();
            if (!response.ok || !Array.isArray(body.items) || !Number.isSafeInteger(body.total) || body.total < 0) throw Error('Complete tag options are unavailable. Refresh to retry.');
            if (expected !== undefined && expected !== body.total) throw Error('Tag options changed while loading. Refresh to retry.');
            expected = Number(body.total);
            for (const tag of body.items) {
                if (!tag?.id || seen.has(tag.id)) throw Error('Tag options changed while loading. Refresh to retry.');
                seen.add(tag.id);tags.push(tag);
            }
            if (tags.length === expected) return tags;
            if (!body.items.length || tags.length > expected) throw Error('Complete tag options are unavailable. Refresh to retry.');
        }
    }, 20000, parent);
}
