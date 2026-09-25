export function parseTelegramMediaRoutes(raw: string | undefined): Record<string, string> {
    if (!raw?.trim()) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('TELEGRAM_MEDIA_ROUTES must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('TELEGRAM_MEDIA_ROUTES must map Telegram chat IDs to Page UUIDs');
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const routes: Record<string, string> = {};
    for (const [chatId, pageId] of Object.entries(parsed as Record<string, unknown>)) {
        if (!/^-?\d+$/.test(chatId) || typeof pageId !== 'string' || !uuid.test(pageId)) {
            throw new Error('TELEGRAM_MEDIA_ROUTES contains an invalid chat ID or Page UUID');
        }
        routes[chatId] = pageId;
    }
    return routes;
}
