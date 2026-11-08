import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope } from '@/lib/veo-workspace';
import { jaucianRead, veoDirectory } from '@/lib/veo-jaucian';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
        const scope = await workspaceScope(session.user.id, request);
        if (scope?.role !== 'owner' || !scope.launch_at) return NextResponse.json({ error: 'Owner access required' }, { status: 403 });
        const [jaucian, workspace] = await Promise.all([jaucianRead(scope.tenant_id), veoDirectory(scope.tenant_id)]);
        return NextResponse.json({ jaucian, workspace }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || 'Jaucian connection unavailable' }, { status: error.status || 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
