export function newConversationContactRows(page, conversations, known, normalizeName, now = Date.now()) {
 const rows = new Map();
 for (const conversation of conversations) {
  const participants = conversation.participants?.data?.filter(person => person.id !== page.fb_page_id) || [];
  if (participants.length !== 1 || !/^\d+$/.test(participants[0].id) || known.has(participants[0].id) || !conversation.id) continue;
  const person = participants[0], time = Date.parse(conversation.updated_time);
  rows.set(person.id, { psid: person.id, name: normalizeName(person.name), conversation_id: conversation.id,
   last_interaction_at: Number.isFinite(time) && time <= now ? new Date(time).toISOString() : null });
 }
 return [...rows.values()];
}

export const discoveryJournalSql = `CREATE TABLE IF NOT EXISTS app_private.lead_contact_discovery_journal(
 contact_id uuid PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
 page_id uuid NOT NULL REFERENCES public.pages(id),conversation_id text NOT NULL,
 discovered_at timestamptz NOT NULL DEFAULT clock_timestamp());
 REVOKE ALL ON app_private.lead_contact_discovery_journal FROM PUBLIC,anon,authenticated`;

// Only new identities are inserted. Existing names, stages, tags, dates and bot
// controls are never replaced by a bulk refresh or a repeated conversation.
export const discoverContactsSql = `WITH candidates AS (
 SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(psid text,name text,conversation_id text,last_interaction_at timestamptz)
), inserted AS (
 INSERT INTO public.contacts(page_id,psid,name,last_interaction_at)
 SELECT $1::uuid,psid,name,last_interaction_at FROM candidates
 ON CONFLICT(page_id,psid) DO NOTHING RETURNING id,page_id,psid
), journal AS (
 INSERT INTO app_private.lead_contact_discovery_journal(contact_id,page_id,conversation_id)
 SELECT i.id,i.page_id,c.conversation_id FROM inserted i JOIN candidates c ON c.psid=i.psid
 RETURNING contact_id
) SELECT id,page_id,psid FROM inserted`;
