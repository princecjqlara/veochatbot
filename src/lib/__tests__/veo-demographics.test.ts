import { expect, it } from 'vitest';
import { groundDemographics, recordedDemographics, demographicSubgroups } from '../veo-demographics';
const source = (text: string, sender = 'customer', id = 'm') => ({ id, text, sender, at: '2026-11-07T00:00:00Z' });
const fact = (field: string, value: string, quote: string, id = 'm') => ({ field, value, evidence: [{ message_id: id, quote }] });
it('accepts explicit customer demographics and subcategories with exact citations', () => {
    const text = 'Age: 34\nGender: Female\nCountry: Philippines\nIndustry: Food\nBusiness type: coffee shop';
    expect(groundDemographics({ fields: [fact('age', '34', 'Age: 34'), fact('gender', 'Female', 'Gender: Female'), fact('business_type', 'coffee shop', 'Business type: coffee shop')] }, [source(text)])).toHaveLength(3);
});
it('rejects names, Page pitches, fabricated citations and unsupported traits', () => {
    expect(groundDemographics({ fields: [fact('gender', 'Female', 'My name is Jane'), fact('age', '34', 'Age: 34'), fact('religion', 'X', 'X')] }, [source('My name is Jane')])).toEqual([]);
    expect(groundDemographics({ fields: [fact('gender', 'Female', 'Gender: Female')] }, [source('Gender: Female', 'page')])).toEqual([]);
});
it('does not turn another person, an example, or a negated statement into a customer trait', () => {
    for (const text of ['My client is 34 years old', 'Example Age: 34', 'I am not 34 years old']) expect(groundDemographics({ fields: [fact('age', '34', text)] }, [source(text)])).toEqual([]);
});
it('keeps the most recent supported disclosure and rejects impossible ages', () => {
    expect(groundDemographics({ fields: [fact('age', '121', 'Age: 121')] }, [source('Age: 121')])).toEqual([]);
    const result = groundDemographics({ fields: [fact('city', 'Cebu', 'City: Cebu', 'new'), fact('city', 'Manila', 'City: Manila', 'old')] }, [source('City: Cebu', 'customer', 'new'), { ...source('City: Manila', 'customer', 'old'), at: '2025-01-01T00:00:00Z' }]);
    expect(result[0].value).toBe('Cebu');
});
it('gives manual corrections and explicit clearings priority over saved or AI values', () => {
    const values = recordedDemographics({ manual_fields: { Gender: 'Male', gender: '', city: 'Cebu' }, ai_demographics: { gender: 'Female', city: 'Manila' }, extracted_answers: [{ field: 'Business Location', value: 'Davao', evidence: [{}] }] });
    expect(values.find(f => f.key === 'gender')).toMatchObject({ value: 'Unknown', source: 'manual' });
    expect(values.find(f => f.key === 'city')?.value).toBe('Cebu'); expect(values.find(f => f.key === 'location')?.value).toBe('Davao');
});
it('reports subgroups with both within-group and whole-cohort percentages including Unknown', () => {
    const rows = demographicSubgroups([{ manual_fields: { country: 'Philippines', province: 'Cebu', city: 'Cebu City', industry: 'Food', business_type: 'coffee shop' } }, { manual_fields: { country: 'Philippines', province: 'Cebu' } }, {}]);
    const location = rows[0], group = location.groups.find(g => g.parent === 'Philippines / Cebu')!;
    expect(group.count).toBe(2); expect(group.rows[0].group_percent).toBe(.5); expect(group.rows[0].cohort_percent).toBeCloseTo(1 / 3);
    expect(location.groups.reduce((n, g) => n + g.count, 0)).toBe(3);
});
it('fills unanswered saved fields from evidence without overriding manual clearings or a declined disclosure', () => {
    const values = recordedDemographics({ saved_fields: { city: '', industry: 'Unknown', gender: 'Prefer not to say' }, ai_demographics: { city: 'Cebu', industry: 'Food', gender: 'Female' } });
    expect(values.find(f => f.key === 'city')).toMatchObject({ value: 'Cebu', source: 'ai' });
    expect(values.find(f => f.key === 'industry')).toMatchObject({ value: 'Food', source: 'ai' });
    expect(values.find(f => f.key === 'gender')?.value).toBe('Unknown');
});
