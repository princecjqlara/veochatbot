import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { getGoogleDriveSyncStatus, listGoogleDriveFolderMedia } from '@/lib/google-drive';

afterEach(() => {
    delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_DRIVE_PRIVATE_KEY;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Google Drive folder media sync', () => {
    it('enables public-link indexing when credentials are absent', () => {
        delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
        delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL;
        delete process.env.GOOGLE_DRIVE_PRIVATE_KEY;
        expect(getGoogleDriveSyncStatus()).toEqual(expect.objectContaining({
            configured: true,
            mode: 'public_link',
            service_account_email: null
        }));
    });

    it('recursively indexes public folder HTML without downloading media', async () => {
        const publicHtml = (title: string, entries: string) => `<!doctype html><html><head><title>${title}</title></head><body><div class="flip-entries">${entries}</div></body></html>`;
        const entry = (url: string, title: string) => `<div class="flip-entry"><a href="${url}" target="_blank"><div class="flip-entry-title">${title}</div></a></div>`;
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => publicHtml('Samples', entry('https://drive.google.com/drive/folders/subfolder-1', 'Food &amp; Beverage'))
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => publicHtml('Food &amp; Beverage', [
                    entry('https://drive.google.com/file/d/video-1/view?usp=drive_web', 'Coffee Shop - Sample Video.mp4'),
                    entry('https://drive.google.com/file/d/text-1/view?usp=drive_web', 'Notes.txt')
                ].join(''))
            });
        vi.stubGlobal('fetch', fetchMock);

        await expect(listGoogleDriveFolderMedia('folder-1')).resolves.toEqual([
            expect.objectContaining({
                driveFileId: 'video-1',
                mediaType: 'video',
                relativePath: 'Samples/Food & Beverage/Coffee Shop - Sample Video.mp4'
            })
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][0]).toContain('embeddedfolderview');
    });

    it('uses read-only service-account auth and recursively returns only image/video files', async () => {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL = 'veobot-drive@test-project.iam.gserviceaccount.com';
        process.env.GOOGLE_DRIVE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ access_token: 'drive-token', expires_in: 3600 })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    files: [
                        { id: 'image-1', name: 'Salon sample.jpg', mimeType: 'image/jpeg', size: '1234', modifiedTime: '2026-09-24T00:00:00Z' },
                        { id: 'notes-1', name: 'Notes.txt', mimeType: 'text/plain' },
                        { id: 'subfolder-1', name: 'Videos', mimeType: 'application/vnd.google-apps.folder' }
                    ]
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    files: [{ id: 'video-1', name: 'Restaurant reel.mp4', mimeType: 'video/mp4', size: '9999' }]
                })
            });
        vi.stubGlobal('fetch', fetchMock);

        const files = await listGoogleDriveFolderMedia('folder-1');

        expect(files).toEqual([
            expect.objectContaining({ driveFileId: 'image-1', mediaType: 'image', name: 'Salon sample.jpg', relativePath: 'Salon sample.jpg' }),
            expect.objectContaining({ driveFileId: 'video-1', mediaType: 'video', name: 'Restaurant reel.mp4', relativePath: 'Videos/Restaurant reel.mp4' })
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer drive-token');
    });
});
