import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('../chatbot', () => ({ DEFAULT_CHATBOT_MODEL: 'test-model' }));
import { extractDemographics, processVeoDemographics } from '../veo-demographics-worker';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('sends bounded customer sources and validates model output against the original message IDs', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ fields: [{ field: 'age', value: '34', evidence: [{ message_id: 'm0', quote: 'Age: 34' }] }, { field: 'gender', value: 'Male', evidence: [{ message_id: 'm0', quote: 'Age: 34' }] }] }) } }] }) }));
    const output = await extractDemographics([{ id: 'opaque-source-id', at: '2026-11-07T00:00:00Z', text: 'Age: 34', sender: 'customer' }]);
    expect(output).toHaveLength(1); expect(output[0].evidence[0].message_id).toBe('opaque-source-id');
    expect(JSON.parse((fetch as any).mock.calls[0][1].body).messages[0].content).toContain('Never infer');
});
it('does not call a model when there are no text sources', async () => { vi.stubGlobal('fetch', vi.fn()); expect(await extractDemographics([])).toEqual([]); expect(fetch).not.toHaveBeenCalled(); });
it('checkpoints an AI error without replacing old extracted data or fetching Meta conversations', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', ''); vi.stubGlobal('fetch', vi.fn());
    m.rpc.mockImplementation(async (name: string) => ({ data: name === 'veo_demographic_claim' ? [{ contact_id: 'c', claim_token: 'claim' }] : name === 'veo_demographic_sources' ? { messages: [{ id: 'm', at: '2026-11-07', sender: 'customer', text: 'City: Manila' }] } : true }));
    expect(await processVeoDemographics()).toMatchObject({ processed: 1, failed: 1, historical_imports: 0 });
    expect(m.rpc).toHaveBeenCalledWith('veo_demographic_finish', expect.objectContaining({ p_fields: [], p_error: expect.stringContaining('not configured') })); expect(fetch).not.toHaveBeenCalled();
});
