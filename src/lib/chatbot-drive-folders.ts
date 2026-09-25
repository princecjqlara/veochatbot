import { createHash, randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase';
import { generateEmbeddings } from '@/lib/chatbot-knowledge';
import { listGoogleDriveFolderMedia, type GoogleDriveMediaFile } from '@/lib/google-drive';

export type ChatbotDriveFolder = {
    id: string;
    page_id: string;
    knowledge_document_id: string | null;
    name: string;
    folder_url: string;
    usage_notes: string;
    button_text: string;
    auto_send: boolean;
    file_count: number;
    last_synced_at: string | null;
    sync_status: 'idle' | 'syncing' | 'ready' | 'failed';
    sync_error: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
};

export type ChatbotDriveFile = {
    id: string;
    page_id: string;
    folder_id: string;
    knowledge_document_id: string | null;
    drive_file_id: string;
    name: string;
    relative_path: string;
    mime_type: string;
    media_type: 'image' | 'video';
    size_bytes: number | null;
    web_view_url: string;
    thumbnail_url: string | null;
    modified_time: string | null;
    auto_send: boolean;
    created_by: string | null;
    created_at: string;
    updated_at: string;
};

export const CHATBOT_DRIVE_FOLDER_FIELDS = 'id, page_id, knowledge_document_id, name, folder_url, usage_notes, button_text, auto_send, file_count, last_synced_at, sync_status, sync_error, created_by, created_at, updated_at';
export const CHATBOT_DRIVE_FILE_FIELDS = 'id, page_id, folder_id, knowledge_document_id, drive_file_id, name, relative_path, mime_type, media_type, size_bytes, web_view_url, thumbnail_url, modified_time, auto_send, created_by, created_at, updated_at';

const DRIVE_INDEX_WRITE_BATCH = 100;
const DRIVE_CHUNK_WRITE_BATCH = 50;

async function deleteIds(table: string, column: string, ids: string[]) {
    const supabase = getSupabaseAdmin();
    for (let offset = 0; offset < ids.length; offset += DRIVE_INDEX_WRITE_BATCH) {
        const batch = ids.slice(offset, offset + DRIVE_INDEX_WRITE_BATCH);
        if (batch.length === 0) continue;
        const { error } = await supabase.from(table).delete().in(column, batch);
        if (error) throw new Error(error.message || `Could not clean up ${table}`);
    }
}

function driveKnowledgeContent(folder: ChatbotDriveFolder, remote: GoogleDriveMediaFile) {
    return [
        `GOOGLE DRIVE MEDIA FILE (${remote.mediaType.toUpperCase()}): ${remote.name}`,
        `Media category and folder path: ${remote.relativePath}`,
        `Parent media collection: ${folder.name}`,
        `Drive file ID: ${remote.driveFileId}`,
        folder.usage_notes
            ? `Owner guidance and when this sample is useful: ${folder.usage_notes}`
            : `This is a ${remote.mediaType} sample from ${folder.name}.`,
        'Select this exact document ID only when this individual file directly helps the customer. VeoBot will send it as one card or include it in a relevant carousel.'
    ].join('\n\n');
}

async function ingestDriveKnowledgeBatch(input: {
    pageId: string;
    userId: string;
    folder: ChatbotDriveFolder;
    files: GoogleDriveMediaFile[];
}) {
    if (input.files.length === 0) return new Map<string, string>();
    const prepared = input.files.map((file) => {
        const content = driveKnowledgeContent(input.folder, file);
        return {
            file,
            documentId: randomUUID(),
            title: `[Drive ${file.mediaType}] ${file.name}`.slice(0, 160),
            content,
            contentHash: createHash('sha256').update(content).digest('hex')
        };
    });
    const embeddings = await generateEmbeddings(prepared.map((item) => item.content), 'search_document');
    const supabase = getSupabaseAdmin();
    const insertedIds: string[] = [];
    try {
        for (let offset = 0; offset < prepared.length; offset += DRIVE_INDEX_WRITE_BATCH) {
            const batch = prepared.slice(offset, offset + DRIVE_INDEX_WRITE_BATCH);
            const { error } = await supabase.from('chatbot_knowledge_documents').insert(batch.map((item) => ({
                id: item.documentId,
                page_id: input.pageId,
                title: item.title,
                source_type: 'manual',
                original_filename: null,
                content: item.content,
                content_hash: item.contentHash,
                char_count: item.content.length,
                chunk_count: 0,
                status: 'processing',
                created_by: input.userId
            })));
            if (error) throw new Error(error.message || 'Could not create Drive knowledge documents');
            insertedIds.push(...batch.map((item) => item.documentId));
        }
        for (let offset = 0; offset < prepared.length; offset += DRIVE_CHUNK_WRITE_BATCH) {
            const batch = prepared.slice(offset, offset + DRIVE_CHUNK_WRITE_BATCH);
            const { error } = await supabase.from('chatbot_knowledge_chunks').insert(batch.map((item, index) => ({
                document_id: item.documentId,
                page_id: input.pageId,
                chunk_index: 0,
                content: item.content,
                char_count: item.content.length,
                embedding: JSON.stringify(embeddings[offset + index])
            })));
            if (error) throw new Error(error.message || 'Could not store Drive knowledge embeddings');
        }
        for (let offset = 0; offset < insertedIds.length; offset += DRIVE_INDEX_WRITE_BATCH) {
            const { error } = await supabase.from('chatbot_knowledge_documents')
                .update({ status: 'ready', chunk_count: 1, error_message: null })
                .in('id', insertedIds.slice(offset, offset + DRIVE_INDEX_WRITE_BATCH));
            if (error) throw new Error(error.message || 'Could not finalize Drive knowledge documents');
        }
        return new Map(prepared.map((item) => [item.file.driveFileId, item.documentId]));
    } catch (error) {
        await deleteIds('chatbot_knowledge_documents', 'id', insertedIds).catch(() => undefined);
        throw error;
    }
}

export function getGoogleDriveFolderId(value: string) {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error('Enter a valid Google Drive folder link');
    }
    const folderMatch = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'drive.google.com' || !folderMatch?.[1]) {
        throw new Error('Use a Google Drive folder link such as https://drive.google.com/drive/folders/...');
    }
    return folderMatch[1];
}

export function normalizeGoogleDriveFolderUrl(value: string) {
    return `https://drive.google.com/drive/folders/${getGoogleDriveFolderId(value)}`;
}

export async function getReadyChatbotDriveFolderForDocument(input: {
    pageId: string;
    documentId: string;
}): Promise<ChatbotDriveFolder | null> {
    const { data, error } = await getSupabaseAdmin()
        .from('chatbot_drive_folders')
        .select(CHATBOT_DRIVE_FOLDER_FIELDS)
        .eq('page_id', input.pageId)
        .eq('knowledge_document_id', input.documentId)
        .eq('auto_send', true)
        .maybeSingle();
    if (error) throw new Error(error.message || 'Could not load chatbot Drive folder');
    return data as ChatbotDriveFolder | null;
}

export async function getReadyChatbotDriveFilesForDocuments(input: {
    pageId: string;
    documentIds: string[];
}): Promise<ChatbotDriveFile[]> {
    const documentIds = [...new Set(input.documentIds.filter(Boolean))].slice(0, 10);
    if (documentIds.length === 0) return [];
    const { data, error } = await getSupabaseAdmin()
        .from('chatbot_drive_files')
        .select(CHATBOT_DRIVE_FILE_FIELDS)
        .eq('page_id', input.pageId)
        .in('knowledge_document_id', documentIds)
        .eq('auto_send', true);
    if (error) throw new Error(error.message || 'Could not load indexed Drive files');
    const order = new Map(documentIds.map((documentId, index) => [documentId, index]));
    return ((data || []) as ChatbotDriveFile[]).sort((left, right) =>
        (order.get(left.knowledge_document_id || '') ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.knowledge_document_id || '') ?? Number.MAX_SAFE_INTEGER)
    );
}

export async function syncChatbotDriveFolder(input: {
    pageId: string;
    folderId: string;
    userId: string;
}) {
    const supabase = getSupabaseAdmin();
    const { data: folderData, error: folderError } = await supabase
        .from('chatbot_drive_folders')
        .select(CHATBOT_DRIVE_FOLDER_FIELDS)
        .eq('id', input.folderId)
        .eq('page_id', input.pageId)
        .maybeSingle();
    if (folderError) throw new Error(folderError.message || 'Could not load Drive folder');
    if (!folderData) throw new Error('Drive folder not found');
    const folder = folderData as ChatbotDriveFolder;

    await supabase.from('chatbot_drive_folders').update({
        sync_status: 'syncing',
        sync_error: null
    }).eq('id', folder.id).eq('page_id', input.pageId);

    try {
        const remoteFiles = await listGoogleDriveFolderMedia(getGoogleDriveFolderId(folder.folder_url));
        const { data: existingData, error: existingError } = await supabase
            .from('chatbot_drive_files')
            .select(CHATBOT_DRIVE_FILE_FIELDS)
            .eq('folder_id', folder.id)
            .eq('page_id', input.pageId);
        if (existingError) throw new Error(existingError.message || 'Could not load existing Drive file index');
        const existingFiles = (existingData || []) as ChatbotDriveFile[];
        const existingByDriveId = new Map(existingFiles.map((file) => [file.drive_file_id, file]));
        const remoteIds = new Set(remoteFiles.map((file) => file.driveFileId));
        const changedFiles = remoteFiles.filter((remote) => {
            const existing = existingByDriveId.get(remote.driveFileId);
            return !existing?.knowledge_document_id ||
                existing.name !== remote.name ||
                existing.relative_path !== remote.relativePath ||
                existing.mime_type !== remote.mimeType ||
                (existing.modified_time || null) !== (remote.modifiedTime || null);
        });
        const replacedDocumentIds = changedFiles
            .map((remote) => existingByDriveId.get(remote.driveFileId)?.knowledge_document_id)
            .filter((value): value is string => Boolean(value));
        await deleteIds('chatbot_knowledge_documents', 'id', replacedDocumentIds);
        const newDocumentIds = await ingestDriveKnowledgeBatch({
            pageId: input.pageId,
            userId: input.userId,
            folder,
            files: changedFiles
        });

        const driveRows = remoteFiles.map((remote) => ({
            page_id: input.pageId,
            folder_id: folder.id,
            knowledge_document_id: newDocumentIds.get(remote.driveFileId) ||
                existingByDriveId.get(remote.driveFileId)?.knowledge_document_id,
            drive_file_id: remote.driveFileId,
            name: remote.name,
            relative_path: remote.relativePath,
            mime_type: remote.mimeType,
            media_type: remote.mediaType,
            size_bytes: remote.sizeBytes,
            web_view_url: remote.webViewUrl,
            thumbnail_url: remote.thumbnailUrl,
            modified_time: remote.modifiedTime,
            auto_send: true,
            created_by: input.userId
        }));
        for (let offset = 0; offset < driveRows.length; offset += DRIVE_INDEX_WRITE_BATCH) {
            const { error } = await supabase.from('chatbot_drive_files')
                .upsert(driveRows.slice(offset, offset + DRIVE_INDEX_WRITE_BATCH), {
                    onConflict: 'folder_id,drive_file_id'
                });
            if (error) throw new Error(error.message || 'Could not save the Drive file index');
        }
        const indexed = driveRows.length;

        for (const stale of existingFiles.filter((file) => !remoteIds.has(file.drive_file_id))) {
            const deletion = stale.knowledge_document_id
                ? await supabase.from('chatbot_knowledge_documents').delete()
                    .eq('id', stale.knowledge_document_id).eq('page_id', input.pageId)
                : await supabase.from('chatbot_drive_files').delete()
                    .eq('id', stale.id).eq('page_id', input.pageId);
            if (deletion.error) throw new Error(deletion.error.message || `Could not remove stale file ${stale.name}`);
        }

        const now = new Date().toISOString();
        const { data: updatedFolder, error: updateError } = await supabase
            .from('chatbot_drive_folders')
            .update({
                file_count: indexed,
                last_synced_at: now,
                sync_status: 'ready',
                sync_error: null,
                auto_send: false
            })
            .eq('id', folder.id)
            .eq('page_id', input.pageId)
            .select(CHATBOT_DRIVE_FOLDER_FIELDS)
            .single();
        if (updateError) throw new Error(updateError.message || 'Could not finalize Drive folder sync');
        return { folder: updatedFolder as ChatbotDriveFolder, indexed };
    } catch (error) {
        await supabase.from('chatbot_drive_folders').update({
            sync_status: 'failed',
            sync_error: (error as Error).message.slice(0, 1000)
        }).eq('id', folder.id).eq('page_id', input.pageId);
        throw error;
    }
}
