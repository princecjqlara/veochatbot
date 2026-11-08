import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { auditContactStorage } from './audit-contact-storage.mjs';

let db, report;
beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE contacts(id int PRIMARY KEY,page_id int NOT NULL,psid text NOT NULL,UNIQUE(page_id,psid));
        CREATE TABLE contact_tags(contact_id int NOT NULL,tag_id int NOT NULL,UNIQUE(contact_id,tag_id));
        CREATE TABLE contact_profile_snapshots(contact_id int,generation int,payload jsonb,PRIMARY KEY(contact_id,generation));
        CREATE TABLE tags(id int PRIMARY KEY,owner_type text,owner_id int,name text);
        CREATE TABLE veo_event_inbox(event_key text PRIMARY KEY);
        INSERT INTO contacts VALUES(1,10,'same-person'),(2,20,'same-person');
        INSERT INTO contact_tags VALUES(1,1);
        INSERT INTO contact_profile_snapshots VALUES(1,1,'{"facts":["original"]}'),(1,2,'{"facts":["original"]}'),
            (1,3,'{"facts":["updated"]}'),(2,1,'{"facts":["original"]}');
        INSERT INTO tags VALUES(1,'page',10,'Important'),(2,'page',10,' important '),(3,'page',20,'Important');`);
    report = await auditContactStorage(db, { scanSamples: true });
}, 30000);
afterAll(async () => { await db?.close(); });

it('distinguishes historical versions and repeated payloads from duplicate contacts', () => {
    expect(report.checks.profileVersions.rows[0]).toEqual({ snapshots: '4', contacts_with_profiles: '2', older_versions: '2' });
    expect(report.checks.matchingProfileSamples.rows[0]).toMatchObject({ sampled_rows: 4, matching_payload_groups: 1, extra_matching_versions: 1 });
    expect(report.checks.sameNameTagSamples.rows[0]).toMatchObject({ sampled_rows: 3, same_name_groups: 1, extra_same_name_tags: 1 });
    expect(report.checks.uniqueKeys.rows).toContainEqual(expect.objectContaining({ relation: 'contacts', valid: true, ready: true, columns: ['page_id', 'psid'], predicate: null }));
});
it('keeps contacts, tags, assignments and every profile intact without emitting private payloads', async () => {
    expect(report).toMatchObject({ read_only: true, deleted_rows: 0 });
    expect((await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(2);
    expect((await db.query('SELECT count(*)::int AS n FROM tags')).rows[0].n).toBe(3);
    expect((await db.query('SELECT count(*)::int AS n FROM contact_tags')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM contact_profile_snapshots')).rows[0].n).toBe(4);
    expect(JSON.stringify(report)).not.toMatch(/same-person|original|updated|Important/);
});
it('reports unavailable probes without changing read-only protection', async () => {
    const limited = await auditContactStorage({ query: async sql => {
        if (sql.startsWith('SET LOCAL temp_file_limit')) throw Object.assign(Error('permission denied'), { code: '42501' });
        return db.query(sql);
    } }, { scanSamples: true });
    expect(limited.checks.profileVersions).toEqual({ status: 'unavailable', code: '42501' });
    expect(limited.checks.uniqueKeys.status).toBe('complete');
    expect(limited.deleted_rows).toBe(0);
});
it('uses catalog checks by default and avoids scanning history or tags', async () => {
    const metadata = await auditContactStorage(db);
    expect(metadata.checks.profileVersions).toBeUndefined();
    expect(metadata.checks.matchingProfileSamples).toBeUndefined();
    expect(metadata.checks.sameNameTagSamples).toBeUndefined();
    expect(metadata.checks.uniqueKeys.status).toBe('complete');
});
