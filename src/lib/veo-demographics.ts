export const demographicFields = [
    { key: 'age', label: 'Age', group: 'Personal', aliases: ['edad'] },
    { key: 'gender', label: 'Gender (self-described)', group: 'Personal', aliases: ['sex', 'kasarian'] },
    { key: 'location', label: 'Recorded location', group: 'Location', aliases: ['business location', 'business_location'] },
    { key: 'country', label: 'Country', group: 'Location', aliases: ['bansa'] },
    { key: 'region', label: 'Region', group: 'Location', aliases: [] },
    { key: 'province', label: 'Province / state', group: 'Location', aliases: ['state', 'probinsya'] },
    { key: 'city', label: 'City / municipality', group: 'Location', aliases: ['municipality', 'lungsod'] },
    { key: 'industry', label: 'Industry', group: 'Business', aliases: ['business industry', 'business category'] },
    { key: 'business_type', label: 'Business subtype', group: 'Business', aliases: ['business type', 'business subcategory', 'industry subcategory'] },
    { key: 'occupation', label: 'Occupation', group: 'Work', aliases: ['profession', 'trabaho'] },
    { key: 'job_role', label: 'Role / job title', group: 'Work', aliases: ['job title', 'role'] },
    { key: 'preferred_language', label: 'Stated preferred language', group: 'Communication', aliases: ['preferred language', 'language preference'] }
] as const;
export type DemographicKey = typeof demographicFields[number]['key'];
export type DemographicMessage = { id: string; at: string; text: string; sender: string; basis?: string };
export type DemographicFact = { field: DemographicKey; value: string; evidence: Array<{ message_id: string; quote: string; at: string; basis?: string }> };
const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
export const demographicKey = (value: string) => demographicFields.find(f => [f.key, ...f.aliases].some(k => normalize(k) === normalize(value)))?.key;
const placeholder = /^(?:unknown|not known|unavailable|not provided|n\/?a|none|null|undefined|prefer not to say|[-?]+)$/i;
export function validDemographicValue(field: string, value: unknown) {
    if (typeof value !== 'string' || value.trim().length > 160) return false;
    if (!value.trim() || placeholder.test(value.trim())) return false;
    if (field === 'age') return /^\d{1,3}$/.test(value.trim()) && Number(value) <= 120;
    return Boolean(demographicKey(field));
}
/** Extracted values must be verbatim customer disclosures. Names, Page sales
 * copy, photos, pronouns and message language never supply personal traits. */
export function groundDemographics(input: any, messages: DemographicMessage[]): DemographicFact[] {
    const source = new Map(messages.filter(m => m.sender === 'customer').map(m => [m.id, m]));
    const found = new Map<string, DemographicFact>();
    for (const item of Array.isArray(input?.fields) ? input.fields.slice(0, 36) : []) {
        if (!demographicFields.some(f => f.key === item?.field) || !validDemographicValue(item.field, item.value)) continue;
        const evidence = (Array.isArray(item.evidence) ? item.evidence.slice(0, 3) : []).flatMap((e: any) => {
            const m = source.get(e?.message_id), q = typeof e?.quote === 'string' ? e.quote.trim() : '';
            if (!m || !q || q.length > 600 || !m.text.includes(q) || !q.toLowerCase().includes(item.value.toLowerCase())) return [];
            if (/\b(?:not|hindi|sample|example|hypothetical|client(?:'s)?|daughter|son|asawa|anak|target audience)\b/i.test(q)) return [];
            if (['age', 'gender'].includes(item.field) && /\b(?:sample|example|hypothetical|client(?:'s)?|daughter|son|asawa|anak|target audience|actor|actress)\b/i.test(m.text)) return [];
            if (item.field === 'preferred_language' && !/prefer|language|wika|please|paki|gamit|tayo/i.test(q)) return [];
            if (item.field === 'age' && !/(?:\bage\s*[:=]|\bedad\s*[:=]|\b(?:i am|i'm|im|ako(?: ay)?)\s+\d|\d+\s*(?:years?|yrs?|y\/?o|taong?)\s*(?:old|na|ako)?)/i.test(q)) return [];
            if (item.field === 'gender' && !/(?:\b(?:gender|sex|kasarian)\s*[:=]|\b(?:i am|i'm|im|ako(?: ay)?)\s+(?:a\s+)?(?:male|female|man|woman|non.?binary|lalaki|babae)|\b(?:lalaki|babae)\s+(?:po\s+)?ako)/i.test(q)) return [];
            return [{ message_id: m.id, quote: q, at: m.at, basis: m.basis || 'customer_message' }];
        });
        if (!evidence.length) continue;
        const fact: DemographicFact = { field: item.field as DemographicKey, value: item.value.trim(), evidence };
        const old = found.get(fact.field);
        if (!old || Math.max(...fact.evidence.map(e => Date.parse(e.at))) >= Math.max(...old.evidence.map(e => Date.parse(e.at)))) found.set(fact.field, fact);
    }
    return [...found.values()];
}
export function recordedDemographics(client: any) {
    const extracted = Object.fromEntries((client.extracted_answers || []).filter((a: any) => a.evidence?.length).map((a: any) => [a.field, a.value]));
    return demographicFields.map(f => {
        for (const [kind, layer] of [['manual', client.manual_fields], ['saved', client.saved_fields], ['ai', client.ai_demographics], ['extracted', extracted]] as const) {
            const entries = Object.entries(layer || {});
            const entry = entries.find(([k]) => k === f.key) || entries.find(([k]) => demographicKey(k) === f.key);
            if (entry) return { ...f, value: validDemographicValue(f.key, entry[1]) ? String(entry[1]).trim() : 'Unknown', source: kind };
        }
        return { ...f, value: 'Unknown', source: 'unknown' as const };
    });
}
export function demographicSubgroups(clients: any[]) {
    const values = clients.map(c => Object.fromEntries(recordedDemographics(c).map(f => [f.key, f.value])));
    return [
        { title: 'Country → province / state → city', parent: (c: any) => `${c.country} / ${c.province}`, child: (c: any) => c.city },
        { title: 'Industry → business subtype', parent: (c: any) => c.industry, child: (c: any) => c.business_type },
        { title: 'Occupation → role / job title', parent: (c: any) => c.occupation, child: (c: any) => c.job_role },
        { title: 'Communication → stated preferred language', parent: () => 'Preferred language', child: (c: any) => c.preferred_language }
    ].map(spec => {
        const groups = new Map<string, Map<string, number>>();
        for (const c of values) { const parent = spec.parent(c), rows = groups.get(parent) || new Map(); const label = spec.child(c); rows.set(label, (rows.get(label) || 0) + 1); groups.set(parent, rows); }
        return { title: spec.title, total: values.length, groups: [...groups].map(([parent, rows]) => {
            const total = [...rows.values()].reduce((a, b) => a + b, 0);
            return { parent, count: total, percent: values.length ? total / values.length : null, rows: [...rows].map(([label, count]) => ({ label, count, cohort_percent: values.length ? count / values.length : null, group_percent: count / total })).sort((a, b) => b.count - a.count) };
        }).sort((a, b) => b.count - a.count) };
    });
}
