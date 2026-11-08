import fs from 'node:fs';
import { expect, it } from 'vitest';
import { assertKnownHierarchyDefinitions, hierarchyMigration } from './repair-veo-hierarchy.mjs';
function definitions(file) {
    const sql = fs.readFileSync(file, 'utf8');
    return ['veo_branch', 'veo_descendants', 'veo_grant_parent', 'veo_can_page'].map(proname => {
        const pattern = new RegExp('CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?' + proname + '\\([\\s\\S]*?\\bAS\\s+\\$\\$([\\s\\S]*?)\\$\\$;', 'i');
        return { proname, prosrc: pattern.exec(sql)[1], prosecdef: true };
    });
}
it('accepts only the known deployed or already repaired hierarchy functions', () => {
    expect(() => assertKnownHierarchyDefinitions(definitions('supabase/migrations/202611050020_veo_staff_and_delivery.sql'))).not.toThrow();
    expect(() => assertKnownHierarchyDefinitions(definitions('supabase/migrations/' + hierarchyMigration))).not.toThrow();
    const unexpected = definitions('supabase/migrations/' + hierarchyMigration);
    unexpected[0].prosrc = 'SELECT user_id FROM veo_accounts';
    expect(() => assertKnownHierarchyDefinitions(unexpected)).toThrow('Unexpected hierarchy definition');
    expect(() => assertKnownHierarchyDefinitions(unexpected.slice(1))).toThrow('Expected all four');
});
