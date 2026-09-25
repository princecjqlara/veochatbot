import { describe, expect, it } from 'vitest';
import { extractTelegramMediaCandidate, type TelegramMessage } from '@/lib/telegram-media';

function message(overrides: Partial<TelegramMessage>): TelegramMessage {
    return {
        message_id: 42,
        chat: { id: -1001234567890, title: 'Approved media group', type: 'supergroup' },
        ...overrides
    };
}

describe('extractTelegramMediaCandidate', () => {
    it('selects the largest Telegram photo variant', () => {
        const candidate = extractTelegramMediaCandidate(message({
            photo: [
                { file_id: 'small', file_unique_id: 'photo-small', file_size: 12_000 },
                { file_id: 'large', file_unique_id: 'photo-large', file_size: 450_000 }
            ]
        }));

        expect(candidate).toEqual({
            telegramFileId: 'large',
            telegramFileUniqueId: 'photo-large',
            fileName: 'telegram-image-42.jpg',
            mimeType: 'image/jpeg',
            fileSize: 450_000,
            mediaType: 'image'
        });
    });

    it('accepts supported Telegram documents using their extension', () => {
        const candidate = extractTelegramMediaCandidate(message({
            document: {
                file_id: 'document-file',
                file_unique_id: 'document-unique',
                file_name: 'Demo Clip.WEBM',
                file_size: 1_500_000,
                mime_type: 'application/octet-stream'
            }
        }));

        expect(candidate).toEqual(expect.objectContaining({
            fileName: 'Demo Clip.WEBM',
            mimeType: 'video/webm',
            mediaType: 'video'
        }));
    });

    it('ignores unsupported files', () => {
        const candidate = extractTelegramMediaCandidate(message({
            document: {
                file_id: 'pdf-file',
                file_unique_id: 'pdf-unique',
                file_name: 'brochure.pdf',
                mime_type: 'application/pdf'
            }
        }));

        expect(candidate).toBeNull();
    });
});
