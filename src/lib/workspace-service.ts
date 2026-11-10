import { NextResponse } from 'next/server';
import { isSupabaseUnavailable } from './supabase-errors';

export async function workspaceService(operation: () => Promise<NextResponse>) {
    try { return await operation(); }
    catch (error: any) {
        if (error.code === 'STORAGE_ATTENTION') return NextResponse.json({ error: error.message, code: error.code, retryable: true }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' } });
        if (isSupabaseUnavailable(error)) return NextResponse.json({ error: 'Workspace is temporarily unavailable. Please retry shortly.', retryable: true }, {
            status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' }
        });
        throw error;
    }
}
