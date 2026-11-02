import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getUserPageIds } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { paymentSignal } from '@/lib/conversion-runtime/evidence.js';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
 const session = await getSessionFromRequest(request);
 if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 const pageId = request.nextUrl.searchParams.get('pageId'), contactId = request.nextUrl.searchParams.get('contactId');
 const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if (!uuid.test(pageId || '') || !uuid.test(contactId || '')) return NextResponse.json({ error: 'Choose a contact and Page' }, { status: 400 });
 if (!(await getUserPageIds(session.user.id)).includes(pageId!)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
 try {
  const db = getSupabaseAdmin();
  const [saved, page] = await Promise.all([
   db.from('contact_conversion_cache').select('first_inquiry_at,payment_at,payment_evidence_id,source_cutoff_at,complete_history,dirty_at').eq('page_id', pageId).eq('contact_id', contactId).maybeSingle(),
   db.from('pages').select('fb_page_id,access_token').eq('id', pageId).maybeSingle()
  ]);
  if (saved.error || page.error) throw Error('Could not load confirmation sources');
  const source = saved.data;
  if (!source?.complete_history || !source.payment_evidence_id || !page.data) return NextResponse.json({ error: 'No documented conversation confirmation is available' }, { status: 404 });
  const at = Date.parse(source.payment_at), cutoff = Date.parse(source.source_cutoff_at), first = Date.parse(source.first_inquiry_at);
  if (![at, cutoff, first].every(Number.isFinite) || at < first || at > cutoff || cutoff > Date.now()) return NextResponse.json({ error: 'This confirmation needs a fresh conversation review' }, { status: 409 });
  const url = new URL('https://graph.facebook.com/v24.0/' + encodeURIComponent(source.payment_evidence_id));
  url.searchParams.set('fields', 'id,message,from,created_time');
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + page.data.access_token }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  const message = await response.json();
  if (!response.ok || message.error) return NextResponse.json({ error: 'Facebook could not reopen this evidence. Review the Page connection or refresh the contact conversation.' }, { status: 409 });
  if (message.id !== source.payment_evidence_id || message.from?.id !== page.data.fb_page_id || Date.parse(message.created_time) !== at || typeof message.message !== 'string' || message.message.length > 50000)
   return NextResponse.json({ error: 'The current message does not match the saved confirmation. Refresh the contact conversation.' }, { status: 409 });
  const proof = { id: message.id, text: message.message, sender: 'page', ms: at, i: 0, attachments: [] };
  const signal = paymentSignal(proof, [proof]);
  if (!signal?.confirmed || !['payment_ack', 'full_payment_ack'].includes(signal.kind)) return NextResponse.json({ error: 'This message no longer supports the saved payment confirmation. Refresh the contact conversation.' }, { status: 409 });
  return NextResponse.json({ message_id: message.id, text: message.message, occurred_at: new Date(at).toISOString(), source_cutoff_at: source.source_cutoff_at,
   amount: signal.amount, currency: signal.amount != null && /PHP|₱/i.test(message.message) ? 'PHP' : null,
   confirmation_kind: signal.kind, verification: 'conversation_documented', ledger_verified: false,
   newer_activity: Date.parse(source.dirty_at || '') > cutoff }, { headers: { 'Cache-Control': 'no-store' } });
 } catch { return NextResponse.json({ error: 'Confirmation evidence is temporarily unavailable' }, { status: 503 }); }
}
