import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ingestTelegramMedia, type TelegramMessage } from '@/lib/telegram-media';
import { parseTelegramMediaRoutes } from '@/lib/telegram-config';

export const maxDuration = 300;

type TelegramUpdate = {
    update_id?: number;
    message?: TelegramMessage;
    channel_post?: TelegramMessage;
};

function secureEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function POST(request: NextRequest) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || '';
    if (!botToken || !webhookSecret) {
        return NextResponse.json({ error: 'Telegram media bridge is not configured' }, { status: 503 });
    }

    const suppliedSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
    if (!suppliedSecret || !secureEqual(suppliedSecret, webhookSecret)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const routes = parseTelegramMediaRoutes(process.env.TELEGRAM_MEDIA_ROUTES);
        const update = await request.json() as TelegramUpdate;
        const message = update.message || update.channel_post;
        if (!message?.chat?.id || !message.message_id) {
            return NextResponse.json({ ok: true, status: 'ignored', reason: 'No message found' });
        }
        const pageId = routes[String(message.chat.id)];
        if (!pageId) {
            console.warn('[TELEGRAM_MEDIA_IGNORED]', { chatId: String(message.chat.id), updateId: update.update_id || null });
            return NextResponse.json({ ok: true, status: 'ignored', reason: 'Telegram chat is not mapped' });
        }

        const result = await ingestTelegramMedia({ botToken, pageId, message });
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        console.error('[TELEGRAM_MEDIA_WEBHOOK]', (error as Error).message);
        return NextResponse.json(
            { ok: false, error: 'Telegram media import failed', message: (error as Error).message },
            { status: 500 }
        );
    }
}
