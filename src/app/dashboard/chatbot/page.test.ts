import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetch: vi.fn(), session: { user: { id: 'owner' } } }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: m.session }) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseClient: vi.fn() }));
import Page from './page';
let view: ReactTestRenderer;
const config = { page_id: 'page', knowledge_source_page_id: 'library', enabled: false, instructions: '', fallback_reply: '', model: '', rag_enabled: true, follow_up_prompt: '', details_to_collect: [], details_completion_percent: 100, bot_dos: '', bot_donts: '', follow_up_enabled: false, follow_up_quick_delays_minutes: [], follow_up_best_time_days: [], follow_up_messages: [], follow_up_ai_instructions: '', follow_up_utility_template_name: '', follow_up_utility_template_language: '', follow_up_utility_text: '', follow_up_media_asset_id: null };
beforeEach(() => {
    vi.clearAllMocks();vi.useFakeTimers();vi.stubGlobal('fetch', m.fetch);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    m.fetch.mockImplementation(async (url: string) => {
        if (url === '/api/pages') return Response.json({ pages: [{ id: 'page', name: 'Page' }, { id: 'library', name: 'Library' }] });
        if (url.endsWith('/chatbot')) return Response.json({ config, provider: { configured: false } });
        if (url.endsWith('/knowledge')) return Response.json({ documents: [{ id: 'doc', title: 'Complete saved knowledge', content: 'Knowledge content' }] });
        if (url.endsWith('/media')) return Response.json({ assets: [] });
        if (url.endsWith('/folders')) return Response.json({ folders: [], files: [] });
        return Response.json({ analytics: null, interruptions: [], trial: null, items: [] });
    });
});
afterEach(async () => { if (view) await act(async () => view.unmount());vi.unstubAllGlobals();vi.useRealTimers(); });
const button = (label: string) => view.root.findAllByType('button').find(b => b.findAllByType('span').some(s => s.children.includes(label)))!;
it('opens Overview without fetching the full library or trial and loads those sections when requested', async () => {
    await act(async () => { view = create(createElement(Page)); });
    const urls = () => m.fetch.mock.calls.map(([url]) => url as string);
    expect(urls().filter(u => /\/(knowledge|media|folders|trial)$/.test(u))).toEqual([]);
    expect(urls()).toHaveLength(4);
    expect(urls()).toContain('/api/pages/page/chatbot');
    await act(async () => button('Knowledge & media').props.onClick());
    expect(urls().filter(u => /\/(knowledge|media|folders)$/.test(u))).toEqual(['/api/pages/library/chatbot/knowledge', '/api/pages/library/chatbot/media', '/api/pages/library/chatbot/folders']);
    expect(JSON.stringify(view.toJSON())).toContain('Complete saved knowledge');
    await act(async () => button('Behavior').props.onClick());await act(async () => button('Knowledge & media').props.onClick());
    expect(urls().filter(u => u.endsWith('/knowledge'))).toHaveLength(1);
    await act(async () => button('Test chatbot').props.onClick());expect(urls()).toContain('/api/pages/page/chatbot/trial');
});
it('ignores an older Page response after another Page has been selected', async () => {
    const normal = m.fetch.getMockImplementation()!;let finish!: (response: Response) => void;
    m.fetch.mockImplementation((url, init) => url === '/api/pages/page/chatbot' ? new Promise<Response>(resolve => { finish = resolve; }) : url === '/api/pages/library/chatbot' ? Promise.resolve(Response.json({ config: { ...config, page_id: 'library', instructions: 'Current Page settings' } })) : normal(url, init));
    await act(async () => { view = create(createElement(Page)); });
    const select = view.root.findAllByType('select').find(s => s.props.value === 'page')!;
    await act(async () => select.props.onChange({ target: { value: 'library' } }));
    await act(async () => finish(Response.json({ config: { ...config, instructions: 'Obsolete Page settings' } })));
    expect(view.root.findAllByType('textarea').some(t => t.props.value === 'Current Page settings')).toBe(true);
    expect(view.root.findAllByType('textarea').some(t => t.props.value === 'Obsolete Page settings')).toBe(false);
});
it('marks a failed library as unavailable and retries all sources without presenting an empty success', async () => {
    const normal = m.fetch.getMockImplementation()!;let failed = true;
    m.fetch.mockImplementation((url, init) => url.endsWith('/folders') && failed ? Promise.resolve(Response.json({ error: 'offline' }, { status: 503 })) : normal(url, init));
    await act(async () => { view = create(createElement(Page)); });await act(async () => button('Knowledge & media').props.onClick());
    expect(JSON.stringify(view.toJSON())).toContain('complete library could not be loaded');expect(view.root.findAllByProps({ id: 'knowledge' })).toHaveLength(0);
    failed = false;const retry = view.root.findAllByType('button').find(b => b.children.includes('Retry library'))!;await act(async () => retry.props.onClick());
    expect(view.root.findAllByProps({ id: 'knowledge' })).toHaveLength(1);
});
