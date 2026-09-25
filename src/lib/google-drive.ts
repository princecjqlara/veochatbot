import { createSign } from 'node:crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const MAX_SYNCED_DRIVE_FILES = 500;
const MAX_FOLDER_DEPTH = 5;
const MAX_PUBLIC_FOLDER_HTML_BYTES = 2_000_000;

type GoogleTokenResponse = {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
};

type GoogleDriveApiFile = {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
    webViewLink?: string;
    thumbnailLink?: string;
    modifiedTime?: string;
    resourceKey?: string;
};

type GoogleDriveListResponse = {
    files?: GoogleDriveApiFile[];
    nextPageToken?: string;
    error?: { message?: string };
};

export type GoogleDriveMediaFile = {
    driveFileId: string;
    name: string;
    mimeType: string;
    mediaType: 'image' | 'video';
    sizeBytes: number | null;
    webViewUrl: string;
    thumbnailUrl: string;
    modifiedTime: string | null;
    relativePath: string;
};

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

function base64UrlJson(value: unknown) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function serviceAccountCredentials() {
    const json = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON?.trim();
    if (json) {
        try {
            const parsed = JSON.parse(json) as { client_email?: string; private_key?: string };
            if (parsed.client_email && parsed.private_key) {
                return {
                    email: parsed.client_email.trim(),
                    privateKey: parsed.private_key.replace(/\\n/g, '\n')
                };
            }
        } catch {
            throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not valid JSON');
        }
    }

    const email = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL?.trim();
    const privateKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY?.trim().replace(/\\n/g, '\n');
    if (!email || !privateKey) {
        throw new Error(
            'Google Drive sync is not configured. Add GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL and GOOGLE_DRIVE_PRIVATE_KEY, then share the Drive folder with that service-account email as Viewer.'
        );
    }
    return { email, privateKey };
}

export function getGoogleDriveSyncStatus() {
    try {
        const credentials = serviceAccountCredentials();
        return {
            configured: true,
            mode: 'service_account' as const,
            service_account_email: credentials.email,
            message: 'Private and public Drive folders can be indexed by link without copying their files.'
        };
    } catch {
        return {
            configured: true,
            mode: 'public_link' as const,
            service_account_email: null,
            message: 'Public-link indexer is active. Folder contents remain in Google Drive.'
        };
    }
}

async function getGoogleDriveAccessToken() {
    if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
        return cachedAccessToken.value;
    }
    const credentials = serviceAccountCredentials();
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson({
        iss: credentials.email,
        scope: DRIVE_READ_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat: now,
        exp: now + 3600
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const assertion = `${unsigned}.${signer.sign(credentials.privateKey).toString('base64url')}`;
    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        })
    });
    const body = await response.json().catch(() => ({})) as GoogleTokenResponse;
    if (!response.ok || !body.access_token) {
        throw new Error(body.error_description || body.error || `Google authentication failed (${response.status})`);
    }
    cachedAccessToken = {
        value: body.access_token,
        expiresAt: Date.now() + Math.max(300, body.expires_in || 3600) * 1000
    };
    return body.access_token;
}

async function listFolderChildren(folderId: string, accessToken: string) {
    const results: GoogleDriveApiFile[] = [];
    let pageToken = '';
    do {
        const url = new URL(GOOGLE_DRIVE_FILES_URL);
        url.searchParams.set('q', `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`);
        url.searchParams.set('pageSize', '1000');
        url.searchParams.set('orderBy', 'name_natural');
        url.searchParams.set('supportsAllDrives', 'true');
        url.searchParams.set('includeItemsFromAllDrives', 'true');
        url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,webViewLink,thumbnailLink,modifiedTime,resourceKey)');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const body = await response.json().catch(() => ({})) as GoogleDriveListResponse;
        if (!response.ok) {
            const detail = body.error?.message || `Google Drive list failed (${response.status})`;
            if (response.status === 404 || response.status === 403) {
                throw new Error(`${detail}. Share the folder with the configured service-account email as Viewer.`);
            }
            throw new Error(detail);
        }
        results.push(...(body.files || []));
        pageToken = body.nextPageToken || '';
    } while (pageToken && results.length < MAX_SYNCED_DRIVE_FILES);
    return results;
}

async function listGoogleDriveFolderMediaWithServiceAccount(folderId: string): Promise<GoogleDriveMediaFile[]> {
    const accessToken = await getGoogleDriveAccessToken();
    const media: GoogleDriveMediaFile[] = [];
    const queue: Array<{ id: string; depth: number; path: string[] }> = [{ id: folderId, depth: 0, path: [] }];
    const seenFolders = new Set<string>();

    while (queue.length > 0 && media.length < MAX_SYNCED_DRIVE_FILES) {
        const current = queue.shift()!;
        if (seenFolders.has(current.id)) continue;
        seenFolders.add(current.id);
        const children = await listFolderChildren(current.id, accessToken);
        for (const file of children) {
            if (!file.id || !file.name || !file.mimeType) continue;
            if (file.mimeType === DRIVE_FOLDER_MIME_TYPE) {
                if (current.depth < MAX_FOLDER_DEPTH) {
                    queue.push({ id: file.id, depth: current.depth + 1, path: [...current.path, file.name] });
                }
                continue;
            }
            const mediaType = file.mimeType.startsWith('image/')
                ? 'image'
                : file.mimeType.startsWith('video/')
                    ? 'video'
                    : null;
            if (!mediaType) continue;
            const resourceKey = file.resourceKey ? `&resourcekey=${encodeURIComponent(file.resourceKey)}` : '';
            media.push({
                driveFileId: file.id,
                name: file.name.trim().slice(0, 255),
                mimeType: file.mimeType,
                mediaType,
                sizeBytes: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
                webViewUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view?usp=sharing${resourceKey}`,
                thumbnailUrl: `https://drive.google.com/thumbnail?id=${encodeURIComponent(file.id)}&sz=w800${resourceKey}`,
                modifiedTime: file.modifiedTime || null,
                relativePath: [...current.path, file.name].join('/')
            });
            if (media.length >= MAX_SYNCED_DRIVE_FILES) break;
        }
    }
    return media;
}

type PublicDriveEntry = {
    id: string;
    name: string;
    url: string;
    isFolder: boolean;
};

function decodeDriveHtmlText(value: string) {
    return value
        .replace(/<[^>]+>/g, '')
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

async function listPublicFolderEntries(folderId: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(
            `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#grid`,
            {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VeoBot-Drive-Indexer/1.0)' },
                signal: controller.signal
            }
        );
        if (!response.ok) throw new Error(`Google Drive public folder returned ${response.status}`);
        const html = await response.text();
        if (html.length > MAX_PUBLIC_FOLDER_HTML_BYTES) {
            throw new Error('Google Drive public folder listing is too large to index safely');
        }
        if (!html.includes('flip-entries')) {
            throw new Error('Google Drive folder is not publicly listable. Set it to Anyone with the link → Viewer.');
        }
        const folderName = decodeDriveHtmlText(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || folderId);
        const entries: PublicDriveEntry[] = [];
        const entryPattern = /<a href="([^"]+)" target="_blank">[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div><\/a>/gi;
        let match: RegExpExecArray | null;
        while ((match = entryPattern.exec(html))) {
            const url = decodeDriveHtmlText(match[1]);
            const name = decodeDriveHtmlText(match[2]).slice(0, 255);
            const folderMatch = url.match(/\/drive\/folders\/([A-Za-z0-9_-]+)/);
            const fileMatch = url.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
            if (!name || (!folderMatch && !fileMatch)) continue;
            entries.push({
                id: (folderMatch || fileMatch)![1],
                name,
                url,
                isFolder: Boolean(folderMatch)
            });
        }
        return { folderName, entries };
    } catch (error) {
        if (controller.signal.aborted) throw new Error('Google Drive public folder listing timed out');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

const PUBLIC_MEDIA_EXTENSIONS: Record<string, { mimeType: string; mediaType: 'image' | 'video' }> = {
    jpg: { mimeType: 'image/jpeg', mediaType: 'image' },
    jpeg: { mimeType: 'image/jpeg', mediaType: 'image' },
    png: { mimeType: 'image/png', mediaType: 'image' },
    webp: { mimeType: 'image/webp', mediaType: 'image' },
    gif: { mimeType: 'image/gif', mediaType: 'image' },
    mp4: { mimeType: 'video/mp4', mediaType: 'video' },
    mov: { mimeType: 'video/quicktime', mediaType: 'video' },
    webm: { mimeType: 'video/webm', mediaType: 'video' },
    m4v: { mimeType: 'video/x-m4v', mediaType: 'video' }
};

async function listPublicGoogleDriveFolderMedia(folderId: string): Promise<GoogleDriveMediaFile[]> {
    const media: GoogleDriveMediaFile[] = [];
    const queue: Array<{ id: string; depth: number; path: string[] }> = [{ id: folderId, depth: 0, path: [] }];
    const seenFolders = new Set<string>();

    while (queue.length > 0 && media.length < MAX_SYNCED_DRIVE_FILES) {
        const current = queue.shift()!;
        if (seenFolders.has(current.id)) continue;
        seenFolders.add(current.id);
        const listing = await listPublicFolderEntries(current.id);
        const currentPath = [...current.path, listing.folderName];
        for (const entry of listing.entries) {
            if (entry.isFolder) {
                if (current.depth < MAX_FOLDER_DEPTH) {
                    queue.push({ id: entry.id, depth: current.depth + 1, path: currentPath });
                }
                continue;
            }
            const extension = entry.name.split('.').pop()?.toLowerCase() || '';
            const supported = PUBLIC_MEDIA_EXTENSIONS[extension];
            if (!supported) continue;
            media.push({
                driveFileId: entry.id,
                name: entry.name,
                mimeType: supported.mimeType,
                mediaType: supported.mediaType,
                sizeBytes: null,
                webViewUrl: `https://drive.google.com/file/d/${entry.id}/view?usp=sharing`,
                thumbnailUrl: `https://drive.google.com/thumbnail?id=${encodeURIComponent(entry.id)}&sz=w800`,
                modifiedTime: null,
                relativePath: [...currentPath, entry.name].join('/')
            });
            if (media.length >= MAX_SYNCED_DRIVE_FILES) break;
        }
    }
    return media;
}

export async function listGoogleDriveFolderMedia(folderId: string): Promise<GoogleDriveMediaFile[]> {
    try {
        serviceAccountCredentials();
        return await listGoogleDriveFolderMediaWithServiceAccount(folderId);
    } catch (credentialError) {
        if (!/not configured/i.test((credentialError as Error).message)) throw credentialError;
        return await listPublicGoogleDriveFolderMedia(folderId);
    }
}
