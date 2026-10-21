// Run using the workspace's tsx loader and injected .env.local. Read-only by default.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { chunkKnowledgeText, generateEmbeddings } from '../src/lib/chatbot-knowledge.ts';
import { COMMERCIAL_VIDEO_REQUIRED_DETAILS, normalizeCommercialVideoDetails, getMissingCommercialVideoDetails } from '../src/lib/chatbot-intake.ts';

const sourcePage = 'd3f40d05-aa54-498e-bff7-e9c4410b7471';
const applySchema = process.argv.includes('--apply-schema');
const applySettings = process.argv.includes('--apply-settings');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 15000 });
const outputDir = new URL('../../data/', import.meta.url);
const stamp = new Date().toISOString().replaceAll(':', '-');
const instructions = `Current commercial-video intake policy: Offer a free concept or a free script. Never promise a free personalized video sample or free commercial production. Existing portfolio examples and knowledge remain available. Prioritize Business Name, Business Location, Goal ng video, and Contact Number, all four required. The full form is one intact message; after partial answers ask only missing fields. Answer the customer's inquiry before returning to the form. Form completion alone does not stop follow-ups. A clear request alone does not stop collection of missing required fields. Hand intake to the team when both the form is complete and the customer clearly requests a commercial video, free concept, or free script. Staff intervention pauses automatic messages. Eligible temporary handoffs are reviewed at 23:59 Asia/Manila when either the form is incomplete OR no clear request exists. Explicit holds, opt-outs, refusals, and closed outcomes remain stopped.`;
const followup = `Continue this customer's conversation naturally in their language using saved answers and verified Page knowledge. Keep follow-ups short and specific. Offer only a free concept or free script as the free pre-production offer; never offer a free personalized video sample, invent discounts, or add unapproved freebies. Relevant existing portfolio work remains available. Prioritize missing Business Name, Business Location, Goal ng video, and Contact Number. When all four are known without a clear request, clarify whether they want a commercial video, free concept, or free script; do not repeat the form. When a clear request is already known, finish only missing required details. The complete form must be one message. Do not repeat earlier wording, known answers, or previously sent samples. Honor staff ownership and stop rules.`;

function patchConfig(config) {
    return { commercial_video_intake_enabled: true, details_to_collect: [...COMMERCIAL_VIDEO_REQUIRED_DETAILS],
        details_completion_percent: 100, stop_when_details_collected: false, continuation_review_enabled: true,
        continuation_review_hour: 23, continuation_review_minute: 59,
        instructions: config.instructions.replace(/Stop when the contact opts out, refuses, completes intake, or a human sets a terminal lead stage\./g,
            'Honor opt-outs, refusals, explicit staff holds, and terminal lead stages.').replace(/Keep the entire reply under 320 characters\./g,
            'Keep ordinary replies under 320 characters; preserve the complete structured intake form.') + '\n\n' + instructions,
        bot_dos: config.bot_dos.replace(/Hand over once intake is complete or a human takes over\./g,
            'Pause on staff intervention; hand off completed intake when the requested next step is clear.') + '\nSend the full four-field form as one message; remember partial answers.',
        bot_donts: config.bot_donts.replace(/Do not ask multiple questions or ask for already supplied details\./g,
            'Do not re-ask supplied details. The four-field form is allowed together in one message.') + '\nDo not offer a free personalized video sample or free commercial production.',
        follow_up_prompt: followup, follow_up_ai_instructions: followup };
}

function patchKnowledge(content) {
    let updated = content.replace(/## 7\. Information to collect[\s\S]*?(?=## 8\.)/, `## 7. Information to collect\n\nThe only required intake fields, in priority order, are:\n\n1. Business Name:\n2. Business Location:\n3. Goal ng video:\n4. Contact Number:\n\nAll four are required. Send the complete form in one intact Messenger message, or ask missing fields individually. Remember partial answers and corrections. Other discovery questions are optional and must not delay this form. Do not count a Messenger profile name as Business Name.\n\n`);
    updated = updated.replace(/## 11\. Follow-up policy[\s\S]*?(?=## 12\.)/, `## 11. Follow-up policy\n\n${followup}\n\n${instructions}\n\n`);
    updated = updated.replace(/> Business name, page\/link, location, goal, preferred length\/style, contact detail for the ad, and portrait or landscape format po\.[^\n]*/g,
        '> Pakisend po ang Business Name, Business Location, Goal ng video, at Contact Number. Optional na ang other references pagkatapos ng required details.');
    return `Current owner-approved intake and free-offer update (2026-10-17)\n\n${instructions}\n\nThis update governs free pre-production offers and intake; verified paid-package inclusions, pricing rules, portfolio examples, and other business knowledge below remain available.\n\n${updated}`;
}

try {
    await mkdir(outputDir, { recursive: true });
    if (applySchema) {
        for (const [version, file] of [['20261015_001', '202610150001_chatbot_continuation_reviews.sql'],
            ['20261017_001', '202610170001_commercial_video_nightly_handoff.sql']]) {
            const applied = await pool.query('SELECT 1 FROM app_private.schema_migrations WHERE version=$1', [version]);
            if (!applied.rowCount) await pool.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
            console.log(JSON.stringify({ schema: file, applied: true }));
        }
    }
    const configs = (await pool.query(`SELECT c.*,p.name FROM chatbot_configs c JOIN pages p ON p.id=c.page_id
        WHERE c.knowledge_source_page_id=$1 OR c.page_id=$1 ORDER BY c.page_id`, [sourcePage])).rows;
    if (!configs.length) throw new Error('No scoped commercial-video configurations found');
    const docs = (await pool.query(`SELECT * FROM chatbot_knowledge_documents WHERE page_id=$1 AND title='AI_COMMERCIAL_VIDEO_CHATBOT_KNOWLEDGE_VERSION_2'`, [sourcePage])).rows;
    if (docs.length !== 1) throw new Error('Expected exactly one authoritative business knowledge document');
    if (configs.some(config => config.commercial_video_intake_enabled) && applySettings) throw new Error('Policy already enabled; refuse to duplicate settings. Inspect read-back instead.');
    const patches = configs.map(config => ({ pageId: config.page_id, name: config.name, enabled: config.enabled,
        followUpEnabled: config.follow_up_enabled, ragEnabled: config.rag_enabled, patch: patchConfig(config) }));
    console.log(JSON.stringify({ mode: applySettings ? 'apply_settings' : 'preview', pages: patches.map(({ patch, ...page }) => page),
        required: COMMERCIAL_VIDEO_REQUIRED_DETAILS, schedule: '23:59 Asia/Manila', rule: 'incomplete form OR no clear request', knowledgeDocumentsEdited: 1 }));
    if (applySettings) {
        const document = docs[0], content = patchKnowledge(document.content);
        const chunks = chunkKnowledgeText(content);
        const embeddings = await generateEmbeddings(chunks, 'search_document');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout='10s'");
            const locked = (await client.query('SELECT * FROM chatbot_configs WHERE page_id=ANY($1::uuid[]) FOR UPDATE', [configs.map(c => c.page_id)])).rows;
            for (const original of configs) if (JSON.stringify(locked.find(c => c.page_id === original.page_id)) !== JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'name')))) {
                // JSON field order is irrelevant; compare the exact revision timestamp instead.
                if (new Date(locked.find(c => c.page_id === original.page_id)?.updated_at).getTime() !== new Date(original.updated_at).getTime()) throw new Error('Page settings changed while preparing release');
            }
            const docNow = (await client.query('SELECT * FROM chatbot_knowledge_documents WHERE id=$1 FOR UPDATE', [document.id])).rows[0];
            if (docNow.content_hash !== document.content_hash) throw new Error('Knowledge changed while preparing release');
            const originalChunks = (await client.query('SELECT * FROM chatbot_knowledge_chunks WHERE document_id=$1', [document.id])).rows;
            const states = (await client.query("SELECT * FROM chatbot_contact_states WHERE page_id=ANY($1::uuid[]) AND status='active' FOR UPDATE", [configs.map(c => c.page_id)])).rows;
            const jobs = (await client.query("SELECT * FROM chatbot_follow_up_jobs WHERE page_id=ANY($1::uuid[]) AND status IN ('pending','processing','ready_manual') FOR UPDATE", [configs.map(c => c.page_id)])).rows;
            await writeFile(new URL(`commercial-intake-backup-${stamp}.json`, outputDir), JSON.stringify({ at: stamp, configs, document, chunks: originalChunks, states, jobs }, null, 2));
            await client.query(`DO $$ DECLARE item record; BEGIN
                FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='public.chatbot_follow_up_jobs'::regclass
                    AND contype='u' AND cardinality(conkey)=4 LOOP
                    EXECUTE format('ALTER TABLE public.chatbot_follow_up_jobs DROP CONSTRAINT %I', item.conname);
                END LOOP; END $$`);
            for (const { pageId, patch } of patches) {
                const entries = Object.entries(patch);
                await client.query(`UPDATE chatbot_configs SET ${entries.map(([key], index) => `${key}=$${index + 2}`).join(',')},updated_at=clock_timestamp() WHERE page_id=$1`,
                    [pageId, ...entries.map(([key, value]) => key === 'details_to_collect' ? JSON.stringify(value) : value)]);
            }
            const normalizedStates = states.map(state => {
                const canonical = normalizeCommercialVideoDetails(state.collected_details);
                return { id: state.id, collected_details: { ...state.collected_details, ...canonical }, missing_details: getMissingCommercialVideoDetails(canonical) };
            });
            await client.query(`UPDATE chatbot_contact_states s SET collected_details=v.collected_details,missing_details=v.missing_details,
                detail_collection_target=NULL,form_version=1,policy_revision=cfg.policy_revision,updated_at=clock_timestamp()
                FROM jsonb_to_recordset($1::jsonb) AS v(id uuid,collected_details jsonb,missing_details jsonb),chatbot_configs cfg
                WHERE s.id=v.id AND cfg.page_id=s.page_id`, [JSON.stringify(normalizedStates)]);
            // Generated at send time: pending future reminders can adopt the new
            // policy without changing their cadence or replaying elapsed slots.
            await client.query(`UPDATE chatbot_follow_up_jobs j SET policy_revision=cfg.policy_revision,automation_epoch=s.automation_epoch
                FROM chatbot_configs cfg,chatbot_contact_states s WHERE j.page_id=cfg.page_id AND j.page_id=s.page_id AND j.contact_id=s.contact_id
                AND j.page_id=ANY($1::uuid[]) AND j.status='pending' AND s.status='active'`, [configs.map(c => c.page_id)]);
            await client.query(`UPDATE chatbot_follow_up_jobs SET status='cancelled',claimed_at=NULL,cancelled_at=clock_timestamp(),error_message='Policy changed during processing'
                WHERE page_id=ANY($1::uuid[]) AND status='processing'`, [configs.map(c => c.page_id)]);
            await client.query('DELETE FROM chatbot_knowledge_chunks WHERE document_id=$1', [document.id]);
            const chunkValues = chunks.flatMap((chunk, index) => [document.id, sourcePage, index, chunk, chunk.length, JSON.stringify(embeddings[index])]);
            const valueGroups = chunks.map((_, index) => `(${Array.from({ length: 6 }, (__, column) => `$${index * 6 + column + 1}`).join(',')})`);
            await client.query(`INSERT INTO chatbot_knowledge_chunks(document_id,page_id,chunk_index,content,char_count,embedding)
                VALUES ${valueGroups.join(',')}`, chunkValues);
            await client.query(`UPDATE chatbot_knowledge_documents SET content=$2,content_hash=$3,char_count=$4,chunk_count=$5,status='ready',error_message=NULL,updated_at=clock_timestamp() WHERE id=$1`,
                [document.id, content, createHash('sha256').update(content).digest('hex'), content.length, chunks.length]);
            await client.query('COMMIT');
            console.log(JSON.stringify({ settingsApplied: patches.length, activeStatesMigrated: states.length, knowledgeChunks: chunks.length,
                enabledAndFollowUpAndRagTogglesPreserved: true, backup: `commercial-intake-backup-${stamp}.json` }));
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
} finally { await pool.end(); }
