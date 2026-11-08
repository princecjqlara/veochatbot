import { getServerSession } from 'next-auth';
import { getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { authOptions } from './auth';
import { workspaceEnabled, workspaceScope } from './veo-workspace';

export async function getSessionFromRequest(request: NextRequest) {
    try {
        if (!workspaceEnabled()) return await getServerSession(authOptions);
        const token = await getToken({ req: request });
        if (!token?.id || token.facebookId || token.accessToken) return null;
        const scope = await workspaceScope(token.id, request);
        if (!scope?.launch_at) return null;
        return { user: { id: token.id, name: token.name, email: token.email, image: token.picture, role: scope.role },
            expires: new Date((typeof token.exp === 'number' ? token.exp : 0) * 1000).toISOString() };
    } catch (error: any) {
        if (workspaceEnabled() && (error.status === 503 || error.code === 'DATABASE_UNAVAILABLE')) {
            throw Object.assign(new Error('Workspace permissions are temporarily unavailable. Retry shortly.'), { status: 503 });
        }
        return null;
    }
}
