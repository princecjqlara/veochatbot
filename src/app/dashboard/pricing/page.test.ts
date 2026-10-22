import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
import PricingPage from './page';
import { currentPricingCatalog, OWNER_PRICING_CATALOGS } from '@/lib/chatbot-pricing-catalogs';
import { approvedCatalogContent } from '@/lib/__tests__/fixtures/pricing-catalogs';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const run = { id: 'run-a', name: 'Approved price run', status: 'active', mode: 'fair_test_sequence', duration_seconds: 24,
    attribution_days: 7, follow_up_gap_minutes: 120, minimum_sample: 100, created_at: '2026-10-22T00:00:00Z' };
const report = { experiments: [run], experiment: run,
    packages: [{ id: 'a', name: 'Basic', price: 599, message: 'Main video' }, { id: 'b', name: 'Plus', price: 799, message: 'Video and poster' }],
    metrics: [{ package_id: 'a', assigned: 12, exposed: 10, qualified: 5, orders: 2, converted: 1, not_qualified: 0,
        shown: 10, promotional_sends: 0, last_touch_converted: 1, last_touch_orders: 2, last_touch_qualified: 5 }],
    bot: { enabled: true, follow_up_enabled: true, trial_mode_enabled: false } };
let view: ReactTestRenderer | undefined;
afterEach(() => { if (view) act(() => view!.unmount()); view = undefined; vi.unstubAllGlobals(); });

describe('pricing dashboard workflows', () => {
    it('shows actual conversion denominators and empty samples without inventing results', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/pages'
            ? { pages: [{ id: 'page-a', name: 'Page A' }] } : report)));
        await act(async () => { view = create(createElement(PricingPage)); });
        const result = text(view!.root);
        expect(result).toContain('Approved price run');
        const tables = view!.root.findAllByType('table');
        const rows = tables[0].findByType('tbody').findAllByType('tr');
        expect(rows[0].findAllByType('td').map(text)).toEqual(['12', '10', '5', '50%', '2', '1', '10%', '20%', '0']);
        expect(rows[1].findAllByType('td').map(text)).toEqual(['0', '0', '0', '—', '0', '0', '—', '—', '0']);
        expect(result).toContain('Collecting samples');
    });
    it('starts a run with the entered packages and loads its saved results', async () => {
        const empty = { experiments: [], experiment: null, packages: [], metrics: [], bot: report.bot };
        let started = false;
        const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
            if (url === '/api/pages') return json({ pages: [{ id: 'page-a', name: 'Page A' }] });
            if (options?.method === 'POST') { started = true; return json({ experiment_id: 'run-a' }, 201); }
            return json(started ? report : empty);
        });
        vi.stubGlobal('fetch', fetcher);
        await act(async () => { view = create(createElement(PricingPage)); });
        await act(async () => { view!.root.findAllByType('button').find(button => text(button) === 'Add pricing packages')!.props.onClick(); });
        const labels = () => view!.root.findAllByType('label');
        const input = async (label: string, value: string, index = 0, type: 'input' | 'textarea' = 'input') => {
            await act(async () => { labels().filter(item => text(item).startsWith(label))[index].findByType(type).props.onChange({ target: { value } }); });
        };
        await input('Run name', 'October test');
        await input('Package name', 'A', 0); await input('Package name', 'B', 1);
        await input('Total price', '599', 0); await input('Total price', '799', 1);
        await input('Offer details', 'Main video', 0, 'textarea'); await input('Offer details', 'Video and poster', 1, 'textarea');
        await act(async () => { await view!.root.findAllByType('button').find(button => text(button) === 'Start pricing run')!.props.onClick(); });
        const post = fetcher.mock.calls.find(([, options]) => options?.method === 'POST');
        expect(post?.[0]).toBe('/api/pages/page-a/chatbot/pricing');
        expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ name: 'October test', mode: 'fair_test',
            packages: [{ name: 'A', price: 599, message: 'Main video' }, { name: 'B', price: 799, message: 'Video and poster' }] });
        expect(text(view!.root)).toContain('Pricing run started');
        expect(text(view!.root)).toContain('Approved price run');
    });
    it('discards a stale report when the Page changes during loading', async () => {
        let resolveOld!: (value: Response) => void;
        const oldReport = new Promise<Response>(resolve => { resolveOld = resolve; });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/pages'
            ? json({ pages: [{ id: 'page-a', name: 'Page A' }, { id: 'page-b', name: 'Page B' }] })
            : url.includes('page-a') ? oldReport : json({ ...report,
                experiment: { ...run, id: 'run-b', name: 'Page B pricing' }, experiments: [{ ...run, id: 'run-b', name: 'Page B pricing' }] })));
        await act(async () => { view = create(createElement(PricingPage)); });
        await act(async () => { view!.root.findByProps({ 'aria-label': 'Facebook Page' }).props.onChange({ target: { value: 'page-b' } }); });
        await act(async () => { resolveOld(json(report)); await oldReport; });
        expect(text(view!.root)).toContain('Page B pricing');
        expect(text(view!.root)).not.toContain('Approved price run');
    });
    it('pauses the selected run without changing its catalog', async () => {
        let paused = false;
        const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
            if (url === '/api/pages') return json({ pages: [{ id: 'page-a', name: 'Page A' }] });
            if (options?.method === 'PATCH') { paused = true; return json({ experiment: { id: run.id, status: 'paused' } }); }
            return json({ ...report, experiment: { ...run, status: paused ? 'paused' : 'active' } });
        });
        vi.stubGlobal('fetch', fetcher);
        await act(async () => { view = create(createElement(PricingPage)); });
        await act(async () => { await view!.root.findAllByType('button').find(button => text(button) === 'Pause offers')!.props.onClick(); });
        const patch = fetcher.mock.calls.find(([, options]) => options?.method === 'PATCH');
        expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ experiment_id: 'run-a', status: 'paused' });
        expect(text(view!.root)).toContain('Resume offers');
    });
    it('loads four catalogs as a reviewable draft, preserving each six-duration table without starting delivery', async () => {
        const control = currentPricingCatalog([{ document_id: 'current', chunk_id: 'current', title: 'Current promo', similarity: 1, content: approvedCatalogContent }]);
        const fetcher = vi.fn(async (url: string) => json(url === '/api/pages' ? { pages: [{ id: 'page-a', name: 'Page A' }] }
            : url.includes('presets=owner') ? { packages: [control, ...OWNER_PRICING_CATALOGS] } : report));
        vi.stubGlobal('fetch', fetcher);
        await act(async () => { view = create(createElement(PricingPage)); });
        await act(async () => { view!.root.findAllByType('button').find(button => text(button) === 'New pricing run')!.props.onClick(); });
        await act(async () => { await view!.root.findAllByType('button').find(button => text(button) === 'Load current + 3 approved catalogs')!.props.onClick(); });
        expect(text(view!.root)).toContain('Current bot catalog (control)');
        for (const catalog of OWNER_PRICING_CATALOGS) expect(text(view!.root)).toContain(catalog.hook);
        expect(view!.root.findByProps({ 'aria-label': 'Premium Ads 60s bonus_video_seconds' }).props.value).toBe(16);
        expect(view!.root.findByProps({ 'aria-label': 'Premium Ads 120s bonus_video_seconds' }).props.value).toBe(24);
        expect(view!.root.findByProps({ 'aria-label': 'More Ways to Promote 120s addon_videos' }).props.value).toBe(6);
        expect(fetcher.mock.calls.every(([url]) => !url.includes('experiment='))).toBe(true);
        expect(view!.root.findAllByType('button').some(button => text(button) === 'Start pricing run')).toBe(true);
    });
    it('requests a duration-specific comparison while preserving catalog choices', async () => {
        const catalogReport = { ...report, packages: OWNER_PRICING_CATALOGS.map((catalog, index) => ({ ...catalog, id: 'catalog-' + index })) };
        const fetcher = vi.fn(async (url: string) => json(url === '/api/pages' ? { pages: [{ id: 'page-a', name: 'Page A' }] } : catalogReport));
        vi.stubGlobal('fetch', fetcher);
        await act(async () => { view = create(createElement(PricingPage)); });
        await act(async () => { view!.root.findByProps({ 'aria-label': 'Starting duration' }).props.onChange({ target: { value: '24' } }); });
        expect(fetcher.mock.calls.some(([url]) => url === '/api/pages/page-a/chatbot/pricing?duration=24')).toBe(true);
        expect(view!.root.findByProps({ 'aria-label': 'Starting duration' }).props.value).toBe('24');
        expect(text(view!.root)).toContain('Premium Ads');
    });
});
