import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';

type ProfileScope = { error: NextResponse } | { pageId: string; contactId: string; actorId: string };

export async function authorizeContactProfile(request: NextRequest, params: Promise<{ pageId: string; contactId: string }>, write = false): Promise<ProfileScope> {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const scope = await params;
    if (!await userHasPageAccess(session.user.id, scope.pageId)) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    if (write && request.headers.get('origin') !== new URL(request.url).origin) return { error: NextResponse.json({ error: 'Same-origin request required' }, { status: 403 }) };
    return { ...scope, actorId: session.user.id };
}
