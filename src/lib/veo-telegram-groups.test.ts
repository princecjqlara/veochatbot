import { expect, it } from 'vitest';
import { telegramGroupCatalog, telegramGroupInput } from './veo-telegram-groups';
const page = '00000000-0000-4000-8000-000000000001';
it('imports approved group Page metadata and observed identities without trusting unmatched Pages or arbitrary payloads', () => {
    const result = telegramGroupCatalog([{ chat_id: -123, name: 'VEO', pages: { One: page, Unknown: 'foreign' }, topics: { close: 4, secret: 7 }, identities: [{ user_id: 42, name: 'Worker', text: 'private message' }, { user_id: -1 }] }, { chat_id: -456, name: 'Suno' }], [{ id: page, name: 'Page One' }], new Set(['-123']));
    expect(result).toHaveLength(1);expect(result[0].pages).toEqual([{ id: page, name: 'Page One', source_id: page, matched: true }, { id: null, name: 'Unknown', source_id: 'foreign', matched: false }]);
    expect(result[0].topics).toEqual({ close: 4 });expect(result[0].identities).toEqual([{ user_id: 42, name: 'Worker', membership: 'unverified' }]);
});
it('requires bounded Page selections, valid group and identity IDs, and explicit boolean movement options', () => {
    expect(() => telegramGroupInput({ action: 'group', chat_id: -123, team_id: page, page_ids: [page], move_pages: true })).not.toThrow();
    for (const change of [{ page_ids: [] }, { page_ids: ['bad'] }, { chat_id: 123 }, { primary: 'true' }, { thread_id: -1 }]) expect(() => telegramGroupInput({ action: 'group', chat_id: -123, team_id: page, page_ids: [page], ...change })).toThrow();
    expect(() => telegramGroupInput({ action: 'membership', user_id: page, chat_id: -123, telegram_user_id: 'username' })).toThrow();
});
