import { NextRequest } from 'next/server';
import { getFacebookPages } from '@/lib/facebook';
import { readFacebookPageGrant } from '@/lib/facebook-page-authorization';
import { PageSetupError, pageSetupFailure, pageSetupResponse, requirePageOwner } from '@/lib/veo-page-connections';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: NextRequest) {
    try {
        const scope = await requirePageOwner(request), grant = await readFacebookPageGrant(request, scope.user_id, undefined, scope.tenant_id);
        if (!grant) throw new PageSetupError('Authorize Facebook to choose from the Pages you manage.', 409, 'FACEBOOK_AUTHORIZATION_REQUIRED');
        const pages = await getFacebookPages(grant.token);
        // Tokens stay on the server; list every authorized Page, including new IDs.
        return pageSetupResponse({ pages: pages.map(page => ({ id: page.id, name: page.name, category: page.category || null, tasks: page.tasks || [] })), expiresAt: grant.expiresAt });
    } catch (error: any) {
        if (error?.requiresReauth) return pageSetupFailure(new PageSetupError('Facebook needs renewed permissions. Authorize Facebook Pages again.', 409, 'FACEBOOK_AUTHORIZATION_REQUIRED'));
        return pageSetupFailure(error);
    }
}
