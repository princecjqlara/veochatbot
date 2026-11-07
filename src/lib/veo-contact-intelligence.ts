import { demographicKey, type DemographicMessage } from './veo-demographics';
export type ProfileFieldDefinition = { key: string; label: string };
export const profileInsightFields: ProfileFieldDefinition[] = [
    { key: 'buying_purpose', label: 'Purpose of buying' },
    { key: 'problems_encountered', label: 'Problems encountered' },
    { key: 'best_contact_time', label: 'Stated best time to contact' }
];
const flat = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = new Map<string, string>([
    ...['purpose', 'purposeofbuying', 'buyingpurpose', 'goal', 'goals', 'purchasepurpose'].map(k => [k, 'buying_purpose'] as const),
    ...['problem', 'problems', 'problemsencountered', 'issues', 'painpoints'].map(k => [k, 'problems_encountered'] as const),
    ...['bestcontacttime', 'besttimetocontact', 'statedbesttimetocontact', 'preferredcontacttime', 'preferredtime'].map(k => [k, 'best_contact_time'] as const),
    ...['phone', 'phonenumber', 'mobile', 'mobilenumber', 'contactnumber'].map(k => [k, 'phone'] as const),
    ...['email', 'emailaddress'].map(k => [k, 'email'] as const),
    ...['company', 'companyname', 'businessname'].map(k => [k, 'company_name'] as const),
    ...['name', 'fullname', 'contactname'].map(k => [k, 'full_name'] as const)
]);
export function profileFieldKey(label: string) {
    const unprefixed = flat(label).replace(/^(?:customers?|clients?)/, '');
    const slug = label.normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return demographicKey(label) || demographicKey(unprefixed) || aliases.get(flat(label)) || aliases.get(unprefixed) || (/^\d/.test(slug) ? 'detail_' + slug : slug).slice(0, 64);
}
export function allowedProfileField(label: unknown): label is string {
    return typeof label === 'string' && label.trim().length >= 2 && label.length <= 80 && Boolean(profileFieldKey(label))
        && !/payment|paid|refund|salary|commission|gross|profit|lifetime|ltv|stage|verified|amount|ordertotal|averageorder|revenue|aov|password|token|secret/i.test(flat(label));
}
export function profileFieldDefinitions(pageFields: unknown = [], requested: unknown = []): ProfileFieldDefinition[] {
    const result = new Map(profileInsightFields.map(f => [f.key, f]));
    for (const entry of [...(Array.isArray(requested) ? requested : []), ...(Array.isArray(pageFields) ? pageFields : [])]) {
        const label = typeof entry === 'string' ? entry : entry?.label;
        if (!allowedProfileField(label)) continue;
        const key = profileFieldKey(label);
        if (!result.has(key) && !demographicKey(key) && result.size < 48) result.set(key, { key, label: label.trim() });
    }
    return [...result.values()];
}
const known = (v: unknown): v is string => typeof v === 'string' && Boolean(v.trim()) && !/^(?:unknown|unavailable|not known|not provided|n\/?a|none|null|undefined|declined|withheld|prefer not to say|[-?]+)$/i.test(v.trim());
export function groundProfileDetails(input: any, messages: DemographicMessage[], definitions: ProfileFieldDefinition[]) {
    const allowed = new Set(definitions.map(f => f.key)), sources = new Map(messages.filter(m => m.sender === 'customer').map(m => [m.id, m]));
    const result = new Map<string, any>();
    for (const f of Array.isArray(input?.fields) ? input.fields.slice(0, 70) : []) {
        if (!allowed.has(f?.field) || !known(f.value) || f.value.length > 600) continue;
        const evidence = (Array.isArray(f.evidence) ? f.evidence.slice(0, 3) : []).flatMap((e: any) => {
            const m = sources.get(e?.message_id), quote = typeof e?.quote === 'string' ? e.quote.trim() : '';
            return m && quote && quote.length <= 1000 && m.text.includes(quote) && quote.includes(f.value.trim())
                ? [{ message_id: m.id, quote, at: m.at, basis: m.basis || 'customer_message' }] : [];
        });
        if (!evidence.length) continue;
        const fact = { field: f.field, value: f.value.trim(), evidence }, previous = result.get(f.field);
        if (!previous || Math.max(...evidence.map((e: any) => Date.parse(e.at))) >= Math.max(...previous.evidence.map((e: any) => Date.parse(e.at)))) result.set(f.field, fact);
    }
    return [...result.values()];
}
export function contactIntelligence(input: any, legacyFacts: any[] = input.profile_facts || []) {
    const definitions = profileFieldDefinitions(input.chatbot_fields, input.requested_fields);
    const layers = [input.manual_fields || {}, input.saved_fields || {}, Object.fromEntries((input.analysis?.fields || []).map((f: any) => [f.field, f.value])),
        Object.fromEntries((input.extracted_answers || []).filter((f: any) => f.evidence?.length).map((f: any) => [f.field, f.value]))];
    const indexed = layers.map(layer => new Map(Object.entries(layer).map(([k, v]) => [profileFieldKey(k), v])));
    const fields = definitions.map(f => {
        for (let i = 0; i < indexed.length; i++) {
            if (!indexed[i].has(f.key)) continue;
            const value = indexed[i].get(f.key);
            if (!known(value) && i !== 0) continue;
            return { ...f, value: known(value) ? value : 'Unknown', source: ['manual', 'saved', 'ai', 'extracted'][i], evidence: i === 2 ? input.analysis.fields.find((a: any) => a.field === f.key)?.evidence || [] : i === 3 ? input.extracted_answers.find((a: any) => profileFieldKey(a.field) === f.key)?.evidence || [] : [] };
        }
        const category = f.key === 'buying_purpose' ? 'purpose' : f.key === 'problems_encountered' ? 'problem' : null;
        const prior = legacyFacts.filter(old => old.evidence?.length && known(old.value) && (profileFieldKey(old.key || '') === f.key || category && old.category === category)).at(-1);
        if (prior) return { ...f, value: prior.value, source: 'extracted', evidence: prior.evidence };
        return { ...f, value: 'Unknown', source: 'unknown', evidence: [] };
    });
    let facts = [...legacyFacts];
    for (const [key, category] of [['buying_purpose', 'purpose'], ['problems_encountered', 'problem']]) {
        const f = fields.find(f => f.key === key)!;
        if (f.source === 'manual') facts = facts.filter(old => old.category !== category);
        if (!known(f.value) || f.source === 'unknown') continue;
        if (!facts.some(old => old.category === category && flat(old.value) === flat(f.value))) facts.push({ category, key: f.label, value: f.value, evidence: f.evidence, source: f.source });
    }
    const details = Object.fromEntries(fields.filter(f => !profileInsightFields.some(i => i.key === f.key) && known(f.value)).map(f => [f.label, f.value]));
    return { fields, facts, details, requested_fields: input.requested_fields || [], analysis: input.analysis ? { status: input.analysis.status, analyzed_at: input.analysis.analyzed_at, last_error: input.analysis.last_error } : null };
}
export function bestContactTime(contact: any, stated?: any) {
    if (stated && stated.source !== 'unknown' && known(stated.value)) return { value: stated.value, source: stated.source, note: stated.source === 'manual' ? 'Manually corrected contact-time preference; timezone is as entered.' : 'Customer-stated preference; timezone is as stated.', evidence: stated.evidence };
    const hour = contact.best_contact_hour;
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23 && contact.best_contact_confidence && contact.best_contact_confidence !== 'none') {
        const label = (h: number) => new Intl.DateTimeFormat('en-PH', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h)));
        return { value: `${label(hour)}–${label((hour + 1) % 24)} PHT`, source: 'activity', note: `Saved activity estimate · ${contact.best_contact_confidence} confidence. This is not a confirmed customer preference.`, evidence: [] };
    }
    return { value: 'Unknown', source: 'unknown', note: 'No stated preference or supported activity estimate is available.', evidence: [] };
}
export function mergeContactDetailLayers(definitions: ProfileFieldDefinition[], ...layers: Record<string, any>[]) {
    const labels = new Map(definitions.map(f => [f.key, f.label])), result = new Map<string, [string, any]>();
    for (const layer of layers) for (const [label, value] of Object.entries(layer || {})) {
        const key = profileFieldKey(label); result.set(key, [labels.get(key) || label, value]);
    }
    return Object.fromEntries([...result.values()]);
}
