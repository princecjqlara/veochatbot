import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from './get-session';
import { workspaceScope, type WorkspaceScope } from './veo-workspace';

export const PAGE_AUTH_COOKIE = 'veo-page-authorization';
export class PageSetupError extends Error {
    constructor(message: string, readonly status = 400, readonly code = 'PAGE_SETUP_FAILED') { super(message); }
}
export async function requirePageOwner(request: NextRequest, mutation = false): Promise<WorkspaceScope> {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) throw new PageSetupError('Sign in to manage Page connections.', 401, 'UNAUTHORIZED');
    const scope = await workspaceScope(session.user.id, request);
    if (!scope?.launch_at || scope.role !== 'owner') throw new PageSetupError('Only the workspace Owner can add or reconnect Pages.', 403, 'OWNER_REQUIRED');
    if (mutation && request.headers.get('origin') !== request.nextUrl.origin) throw new PageSetupError('Open this action from your workspace.', 403, 'INVALID_ORIGIN');
    return scope;
}
function key() {
    if (!process.env.NEXTAUTH_SECRET) throw new PageSetupError('Page authorization is not configured.', 503, 'SETUP_UNAVAILABLE');
    return createHash('sha256').update('veo-page-connections:' + process.env.NEXTAUTH_SECRET).digest();
}
export function encryptPageGrant(token: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function decryptPageGrant(value: string) {
    try {
        const bytes = Buffer.from(value, 'base64url');
        const cipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    } catch { throw new PageSetupError('Facebook authorization expired. Refresh permissions to continue.', 409, 'FACEBOOK_AUTHORIZATION_REQUIRED'); }
}
export function pageGrantCookie(id: string, actor: string) {
    return id + '.' + createHmac('sha256', key()).update(id + ':' + actor).digest('base64url');
}
export function readPageGrantCookie(request: NextRequest, actor: string) {
    const value = request.cookies.get(PAGE_AUTH_COOKIE)?.value || '', id = value.split('.')[0];
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    const expected = Buffer.from(pageGrantCookie(id, actor)), supplied = Buffer.from(value);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? id : null;
}
export function setPageGrantCookie(response: NextResponse, request: NextRequest, actor: string, id: string, maxAge: number) {
    response.cookies.set(PAGE_AUTH_COOKIE, pageGrantCookie(id, actor), { httpOnly: true, secure: request.nextUrl.protocol === 'https:', sameSite: 'lax', path: '/api', maxAge });
}
export function pageSetupResponse(body: unknown, status = 200) {
    return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
export function pageSetupFailure(error: unknown) {
    if (error instanceof PageSetupError) return pageSetupResponse({ error: error.message, code: error.code }, error.status);
    const status = (error as any)?.status === 403 || (error as any)?.code === '42501' ? 403 : 503;
    return pageSetupResponse({ error: status === 403 ? 'This Page cannot be connected to your workspace.' : 'Page setup is temporarily unavailable. Retry shortly.', code: status === 403 ? 'PAGE_FORBIDDEN' : 'SETUP_UNAVAILABLE' }, status);
}
export function checkedPageResult(result: any) {
    if (result.error) throw result.error;
    return result.data;
}
