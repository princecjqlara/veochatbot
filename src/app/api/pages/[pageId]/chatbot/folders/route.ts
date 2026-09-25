import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { userHasPageAccess } from '@/lib/page-access';
import { ingestChatbotKnowledge } from '@/lib/chatbot-knowledge';
import {
    CHATBOT_DRIVE_FILE_FIELDS,
    CHATBOT_DRIVE_FOLDER_FIELDS,
    normalizeGoogleDriveFolderUrl,
    syncChatbotDriveFolder,
    type ChatbotDriveFile,
    type ChatbotDriveFolder
} from '@/lib/chatbot-drive-folders';
import { getGoogleDriveSyncStatus } from '@/lib/google-drive';

export const maxDuration = 300;

async function authorize(request: NextRequest, pageId: string) {
    const session = await getSessionFromRequest(request);
    const userId = session?.user?.id;
    if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    if (!await userHasPageAccess(userId, pageId)) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return { userId };
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorization = await authorize(request, pageId);
        if (authorization.error) return authorization.error;

        const supabase = getSupabaseAdmin();
        const [{ data, error }, { data: files, error: filesError }] = await Promise.all([
            supabase.from('chatbot_drive_folders')
                .select(CHATBOT_DRIVE_FOLDER_FIELDS)
                .eq('page_id', pageId)
                .order('created_at', { ascending: false }),
            supabase.from('chatbot_drive_files')
                .select(CHATBOT_DRIVE_FILE_FIELDS)
                .eq('page_id', pageId)
                .order('name', { ascending: true })
        ]);
        if (error) throw error;
        if (filesError) throw filesError;
        return NextResponse.json({
            folders: (data || []) as unknown as ChatbotDriveFolder[],
            files: (files || []) as unknown as ChatbotDriveFile[],
            drive_sync: getGoogleDriveSyncStatus()
        });
    } catch (error) {
        console.error('[CHATBOT_DRIVE_FOLDERS_GET]', error);
        return NextResponse.json(
            { error: 'Failed to load Drive folders', message: (error as Error).message },
            { status: 500 }
        );
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    let knowledgeDocumentId: string | null = null;
    try {
        const { pageId } = await params;
        const authorization = await authorize(request, pageId);
        if (authorization.error || !authorization.userId) return authorization.error;

        const body = await request.json().catch(() => ({}));
        if (body.action === 'sync') {
            const folderId = typeof body.folder_id === 'string' ? body.folder_id : '';
            if (!folderId) return NextResponse.json({ error: 'folder_id is required' }, { status: 400 });
            const result = await syncChatbotDriveFolder({
                pageId,
                folderId,
                userId: authorization.userId
            });
            return NextResponse.json(result);
        }
        const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
        const usageNotes = typeof body.usage_notes === 'string' ? body.usage_notes.trim().slice(0, 3000) : '';
        const buttonText = typeof body.button_text === 'string'
            ? body.button_text.trim().replace(/\s+/g, ' ').slice(0, 20)
            : '';
        if (!name) return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });
        const folderUrl = normalizeGoogleDriveFolderUrl(typeof body.folder_url === 'string' ? body.folder_url : '');

        const knowledgeContent = [
            `GOOGLE DRIVE MEDIA FOLDER: ${name}`,
            `Customer-facing folder link: ${folderUrl}`,
            usageNotes
                ? `Owner guidance, contents, and when to share: ${usageNotes}`
                : `This folder contains media samples related to ${name}. Share it only when the customer's request clearly relates to this folder.`,
            'This folder is a source collection, not the customer-facing selection. Use the individually indexed Drive file documents when choosing samples. Never claim a specific file exists unless it was indexed.'
        ].join('\n\n');
        const document = await ingestChatbotKnowledge({
            pageId,
            userId: authorization.userId,
            title: `[Drive folder] ${name}`,
            content: knowledgeContent,
            sourceType: 'manual'
        });
        knowledgeDocumentId = document.id;

        const { data, error } = await getSupabaseAdmin()
            .from('chatbot_drive_folders')
            .insert({
                page_id: pageId,
                knowledge_document_id: document.id,
                name,
                folder_url: folderUrl,
                usage_notes: usageNotes,
                button_text: buttonText || 'View media samples',
                auto_send: false,
                created_by: authorization.userId
            })
            .select(CHATBOT_DRIVE_FOLDER_FIELDS)
            .single();
        if (error || !data) throw error || new Error('Could not save the Drive folder');
        try {
            const synced = await syncChatbotDriveFolder({
                pageId,
                folderId: data.id,
                userId: authorization.userId
            });
            return NextResponse.json({ folder: synced.folder, document, indexed: synced.indexed }, { status: 201 });
        } catch (syncError) {
            return NextResponse.json({
                folder: data,
                document,
                indexed: 0,
                sync_warning: (syncError as Error).message
            }, { status: 201 });
        }
    } catch (error) {
        if (knowledgeDocumentId) {
            await getSupabaseAdmin().from('chatbot_knowledge_documents').delete().eq('id', knowledgeDocumentId);
        }
        const message = (error as Error).message;
        console.error('[CHATBOT_DRIVE_FOLDERS_POST]', message);
        return NextResponse.json(
            { error: 'Failed to add Drive folder', message },
            { status: /valid Google Drive|Use a Google Drive/.test(message) ? 400 : 500 }
        );
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorization = await authorize(request, pageId);
        if (authorization.error) return authorization.error;
        const body = await request.json().catch(() => ({}));
        const folderId = typeof body.folder_id === 'string' ? body.folder_id : '';
        if (!folderId) return NextResponse.json({ error: 'folder_id is required' }, { status: 400 });

        const supabase = getSupabaseAdmin();
        const { data: folder, error } = await supabase
            .from('chatbot_drive_folders')
            .select('id, knowledge_document_id')
            .eq('id', folderId)
            .eq('page_id', pageId)
            .maybeSingle();
        if (error) throw error;
        if (!folder) return NextResponse.json({ error: 'Drive folder not found' }, { status: 404 });

        const deletion = folder.knowledge_document_id
            ? await supabase.from('chatbot_knowledge_documents').delete()
                .eq('id', folder.knowledge_document_id).eq('page_id', pageId)
            : await supabase.from('chatbot_drive_folders').delete()
                .eq('id', folder.id).eq('page_id', pageId);
        if (deletion.error) throw deletion.error;
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[CHATBOT_DRIVE_FOLDERS_DELETE]', error);
        return NextResponse.json(
            { error: 'Failed to delete Drive folder', message: (error as Error).message },
            { status: 500 }
        );
    }
}
