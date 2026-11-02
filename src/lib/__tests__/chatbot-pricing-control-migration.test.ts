import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

describe('shared pricing switch migration', () => {
    it('is repeatable and preserves model, sales-flow and optional-assistant pricing settings', async () => {
        const db = await PGlite.create();
        try {
            await db.exec(`CREATE TABLE chatbot_configs (page_id text PRIMARY KEY, model text, sales_assistant_settings jsonb);
                INSERT INTO chatbot_configs VALUES ('original','custom/model','{}'), ('optional','other/model','{"pricing_enabled":false}');`);
            const sql = readFileSync('supabase/migrations/202611030001_chatbot_pricing_control.sql','utf8');
            await db.exec(sql); await db.exec(sql);
            const before = (await db.query('SELECT * FROM chatbot_configs ORDER BY page_id')).rows;
            expect(before).toEqual([
                { page_id: 'optional', model: 'other/model', sales_assistant_settings: { pricing_enabled: false }, pricing_enabled: true },
                { page_id: 'original', model: 'custom/model', sales_assistant_settings: {}, pricing_enabled: true }
            ]);
            await db.exec("UPDATE chatbot_configs SET pricing_enabled=false WHERE page_id='original'");
            await db.exec(sql);
            expect((await db.query("SELECT pricing_enabled FROM chatbot_configs WHERE page_id='original'")).rows[0]).toEqual({ pricing_enabled: false });
        } finally { await db.close(); }
    }, 60000);
});
