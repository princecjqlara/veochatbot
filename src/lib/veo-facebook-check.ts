import { fetchBusinessOrderNotices } from './veo-business-orders';

function checked(result: any) {
    if (result.error) throw Object.assign(Error(result.error.code === '42501' ? 'Client Page access changed' : 'Facebook check could not be saved. Retry.'), { status: result.error.code === '42501' ? 403 : 503 });
    return result.data;
}

/** Only the server supplies observations. A failed refresh invalidates older success. */
export async function refreshReceiptFacebook(db: any, actor: string, contactId: string, timeoutMs?: number) {
    const context = checked(await db.rpc('veo_facebook_check_context', { p_actor: actor, p_contact: contactId }));
    const startedAt = new Date().toISOString();
    let scan: any;
    try {
        const page = await db.from('pages').select('fb_page_id,access_token').eq('id', context.page_id).single();
        if (page.error || !page.data?.access_token || !context.psid) throw Error('Facebook Page connection or client conversation unavailable. Ask the Owner to check the Page connection.');
        scan = await fetchBusinessOrderNotices({ pageId: page.data.fb_page_id, psid: context.psid, token: page.data.access_token, launchAt: context.launch_at, ...(timeoutMs ? { timeoutMs } : {}) });
    } catch (e: any) {
        scan = { orders: [], stage: null, complete: false, pages_checked: 0, coverage: 'Facebook evidence unavailable; receipt submission is blocked.', error: e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Facebook check timed out. Retry shortly.' : e.message || 'Facebook check unavailable. Retry.' };
    }
    return checked(await db.rpc('veo_record_facebook_check', { p_actor: actor, p_contact: contactId, p_started_at: startedAt, p_scan: scan }));
}

/** Cron and the authenticated Jaucian read use the receipt's current authorized actor. */
export async function refreshSubmissionFacebook(db: any, submissionId: string) {
    const context = checked(await db.rpc('veo_submission_facebook_context', { p_submission: submissionId }));
    if (!context) return false;
    // Jaucian's existing authoritative HTTP read has a 15-second timeout.
    // Bound the external read to leave time for authorization and DB checks.
    const scan = await refreshReceiptFacebook(db, context.actor_id, context.contact_id, 8000);
    if (scan.error || !scan.complete) throw Error('Facebook eligibility unavailable; retry scheduled');
    return true;
}
