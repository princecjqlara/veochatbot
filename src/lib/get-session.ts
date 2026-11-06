import { getServerSession } from 'next-auth';
import { NextRequest } from 'next/server';
import { authOptions } from './auth';
import { workspaceEnabled, workspaceScope } from './veo-workspace';

export async function getSessionFromRequest(_request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) return null;
        if (workspaceEnabled()) {
            const scope = await workspaceScope(session.user.id);
            if (!scope?.launch_at) return null;
            session.user.role = scope.role;
        }
        return session;
    } catch { return null; }
}
