import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pg from 'pg';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const base = process.argv.find(arg => arg.startsWith('--base='))?.slice(7) || 'https://veochatbot.vercel.app';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const receipt = { at: new Date().toISOString(), base, financial_writes: 0, attribution_changes: 0, checks: [] };
try {
    await db.connect();
    const selected = (await db.query(`SELECT s.contact_id,s.page_id,s.origin_ad_id,s.origin_evidence_key,up.user_id,p.name
        FROM ad_contact_sources s JOIN ad_source_catalog a ON a.page_id=s.page_id AND a.ad_id=s.origin_ad_id
        JOIN ad_referral_events e ON e.event_key=s.origin_evidence_key AND e.page_id=s.page_id AND e.contact_id=s.contact_id
        JOIN user_pages up ON up.page_id=s.page_id JOIN pages p ON p.id=s.page_id
        WHERE s.attribution_status='verified_inline' AND (a.video_url IS NOT NULL OR a.photo_url IS NOT NULL)
        ORDER BY (a.video_url IS NOT NULL) DESC,s.first_inquiry_at DESC LIMIT 1`)).rows[0];
    assert(selected, 'No authorized creative with source evidence available for verification');
    const jwt = await encode({ token: { id: selected.user_id, name: 'Ad-source release verification' }, secret: process.env.NEXTAUTH_SECRET, maxAge: 600 });
    const headers = { Cookie: (new URL(base).protocol === 'https:' ? '__Secure-next-auth.session-token=' : 'next-auth.session-token=') + jwt };
    const path = `/api/pages/${selected.page_id}/contacts/${selected.contact_id}/profile/sources`;
    assert.equal((await fetch(base + path)).status, 401); receipt.checks.push('Source evidence requires authentication');
    const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data.origin.ad.ad_id, selected.origin_ad_id);
    assert.equal(data.origin.evidence.event_key, selected.origin_evidence_key);
    assert(data.origin.ad.video_url || data.origin.ad.photo_url || data.origin.ad.catalog_preview?.video_url || data.origin.ad.catalog_preview?.photo_url);
    assert(data.touches.length <= 25); assert(data.total >= data.touches.length);
    const focus = await (await fetch(base + path + '?eventKey=' + encodeURIComponent(selected.origin_evidence_key), { headers })).json();
    assert.equal(focus.total, 1); assert.equal(focus.touches[0].role, 'origin');
    assert.equal(focus.touches[0].event_key, selected.origin_evidence_key);
    const actual = (await db.query('SELECT count(*)::int AS n FROM ad_referral_events WHERE page_id=$1 AND contact_id=$2', [selected.page_id, selected.contact_id])).rows[0].n;
    assert.equal(data.total, actual);
    if (data.total > 25) {
        const second = await (await fetch(base + path + '?page=2', { headers })).json(); assert.equal(second.page, 2);
        assert(second.touches.every(touch => !data.touches.some(first => first.event_key === touch.event_key)));
    }
    receipt.checks.push('Verified origin joins the exact referral event and Page-scoped creative', 'Photo/video previews and metadata are returned', 'Timeline event references resolve to the exact source', 'Touch total matches the database before pagination');
    Object.assign(receipt, { passed: true, page_id: selected.page_id, contact_id: selected.contact_id, page: selected.name,
        ad_id: selected.origin_ad_id, touch_count: data.total, creative_basis: data.origin.ad.creative_basis,
        has_video: Boolean(data.origin.ad.video_url || data.origin.ad.catalog_preview?.video_url), has_campaign: Boolean(data.origin.ad.campaign_name), has_ad_set: Boolean(data.origin.ad.adset_name) });
} catch (error) { Object.assign(receipt, { passed: false, error: String(error.message).slice(0, 500) }); process.exitCode = 1; }
finally { await db.end(); fs.writeFileSync('.vercel/sources-live-' + (new URL(base).hostname === 'localhost' ? 'local' : 'production') + '.json', JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2)); }
