import { expect, it } from 'vitest';
import { allowedProfileField, bestContactTime, contactIntelligence, groundProfileDetails, mergeContactDetailLayers, profileFieldDefinitions, profileFieldKey } from './veo-contact-intelligence';
const evidence = [{ message_id: 'm', quote: 'Please contact me after 7 pm.', at: '2026-11-07T01:00:00Z' }];
it('deduplicates existing labels and aliases while blocking financial control fields', () => {
    const defs = profileFieldDefinitions(['Phone number', 'Company name', 'Purpose', 'Age'], [{ label: 'Customer phone', key: 'wrong' }, { label: 'Business name' }, { label: 'Delivery deadline' }]);
    expect(defs.filter(f => f.key === 'phone')).toHaveLength(1); expect(defs.filter(f => f.key === 'company_name')).toHaveLength(1);
    expect(defs.filter(f => f.key === 'buying_purpose')).toHaveLength(1); expect(defs.some(f => f.key === 'age')).toBe(false);
    expect(profileFieldKey("Client's gender")).toBe('gender');
    for (const label of ['Paid amount', 'Lead stage', 'Average order value', 'Salary rate', 'Account password']) expect(allowedProfileField(label)).toBe(false);
});
it('accepts only exact customer disclosures with traceable evidence and allows real negative problem statements', () => {
    const messages = [{ id: 'm', at: '2026-11-07T01:00:00Z', sender: 'customer', text: 'My videos are not working. Please contact me after 7 pm.' }, { id: 'page', at: '2026-11-07T02:00:00Z', sender: 'page', text: 'You paid PHP500.' }];
    const facts = groundProfileDetails({ fields: [
        { field: 'problems_encountered', value: 'not working', evidence: [{ message_id: 'm', quote: 'My videos are not working.' }] },
        { field: 'best_contact_time', value: 'after 7 pm', evidence: [{ message_id: 'm', quote: 'Please contact me after 7 pm.' }] },
        { field: 'buying_purpose', value: 'Business growth', evidence: [{ message_id: 'm', quote: 'Business growth' }] },
        { field: 'paid_amount', value: 'PHP500', evidence: [{ message_id: 'page', quote: 'You paid PHP500.' }] }
    ] }, messages, profileFieldDefinitions());
    expect(facts.map(f => f.field).sort()).toEqual(['best_contact_time', 'problems_encountered']); expect(facts[0].evidence[0].at).toBe(messages[0].at);
});
it('preserves manual corrections, saved answers and intentional Unknown instead of replacing them with AI', () => {
    const r = contactIntelligence({ manual_fields: { purpose: '', 'Phone number': '123' }, saved_fields: { phone: '456', preferred_time: 'after 6 pm' }, chatbot_fields: ['Phone'],
        analysis: { fields: [{ field: 'buying_purpose', value: 'Advertising', evidence }, { field: 'best_contact_time', value: 'after 7 pm', evidence }, { field: 'phone', value: '789', evidence }] } },
        [{ category: 'purpose', key: 'Goal', value: 'Advertising', evidence }, { category: 'problem', key: 'Problem', value: 'Not working', evidence }]);
    expect(r.fields.find(f => f.key === 'buying_purpose')).toMatchObject({ value: 'Unknown', source: 'manual' });
    expect(r.fields.find(f => f.key === 'phone')).toMatchObject({ value: '123', source: 'manual' });
    expect(r.fields.find(f => f.key === 'best_contact_time')).toMatchObject({ value: 'after 6 pm', source: 'saved' });
    expect(r.facts.filter(f => f.category === 'purpose')).toHaveLength(0); expect(r.facts.filter(f => f.category === 'problem')).toHaveLength(1);
});
it('fills additional answers and merges profile facts without duplicating a supported existing statement', () => {
    const legacy = [{ category: 'purpose', key: 'Goal', value: 'Advertising', evidence }];
    const r = contactIntelligence({ requested_fields: [{ key: 'delivery_deadline', label: 'Delivery deadline' }], analysis: { fields: [{ field: 'buying_purpose', value: 'Advertising', evidence }, { field: 'delivery_deadline', value: 'Friday', evidence }] } }, legacy);
    expect(r.facts).toHaveLength(1); expect(r.details).toEqual({ 'Delivery deadline': 'Friday' });
    expect(mergeContactDetailLayers(profileFieldDefinitions(['Phone number']), { Phone: '123' }, { mobile: '456' })).toEqual({ 'Phone number': '456' });
});
it('shows a stated preference before saved activity and never supplies a default contact time as fact', () => {
    expect(bestContactTime({ best_contact_hour: 12, best_contact_confidence: 'none' }).value).toBe('Unknown');
    expect(bestContactTime({ best_contact_hour: 0, best_contact_confidence: 'high' })).toMatchObject({ source: 'activity', value: '12 AM–1 AM PHT' });
    expect(bestContactTime({ best_contact_hour: 12, best_contact_confidence: 'high' }, { value: 'after 7 pm EST', source: 'ai', evidence })).toMatchObject({ value: 'after 7 pm EST', source: 'ai' });
});
