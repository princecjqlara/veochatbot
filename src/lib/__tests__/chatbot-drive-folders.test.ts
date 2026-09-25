import { describe, expect, it } from 'vitest';
import { normalizeGoogleDriveFolderUrl } from '@/lib/chatbot-drive-folders';

describe('normalizeGoogleDriveFolderUrl', () => {
    it('normalizes standard and account-scoped Google Drive folder links', () => {
        expect(normalizeGoogleDriveFolderUrl(
            'https://drive.google.com/drive/u/2/folders/folder_ID-123?usp=sharing'
        )).toBe('https://drive.google.com/drive/folders/folder_ID-123');
    });

    it('rejects file links and non-Google hosts', () => {
        expect(() => normalizeGoogleDriveFolderUrl(
            'https://drive.google.com/file/d/file-id/view'
        )).toThrow('Google Drive folder link');
        expect(() => normalizeGoogleDriveFolderUrl(
            'https://example.com/drive/folders/folder-id'
        )).toThrow('Google Drive folder link');
    });
});
