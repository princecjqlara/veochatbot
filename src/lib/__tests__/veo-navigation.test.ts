import { expect, it } from 'vitest';
import { activeDashboardItem, dashboardLocation, dashboardNavigation } from '../veo-navigation';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

it('keeps contact navigation active while reading a full contact profile', () => {
    const params = new URLSearchParams();
    expect(activeDashboardItem('/dashboard/contacts', '/dashboard/contacts/client-id', params)).toBe(true);
    expect(activeDashboardItem('/dashboard/contacts', '/dashboard/contacts-other', params)).toBe(false);
    expect(dashboardLocation('member', '/dashboard/contacts/client-id', params)).toEqual({ group: 'Work', label: 'Contact profile' });
});
it('keeps every implemented top-level dashboard tool reachable for the Owner', () => {
    const links = dashboardNavigation('owner').flatMap(group => group.items.map(item => item.href));
    const root = 'src/app/dashboard';
    const pages = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'page.tsx')));
    for (const page of pages) expect(links, 'Missing Owner tool: ' + page.name).toContain('/dashboard/' + page.name);
});
it.each(['owner', 'team_leader', 'manager', 'member'])('keeps all existing shared tools reachable for %s', role => {
    const links = dashboardNavigation(role).flatMap(group => group.items.map(item => item.href));
    for (const tool of ['contacts', 'tags', 'pipeline', 'campaigns', 'exports', 'history', 'templates', '7-day-contacts']) expect(links).toContain('/dashboard/' + tool);
    if (role !== 'owner') for (const tool of ['connect', 'settings', 'chatbot', 'pricing', 'automations', 'welcome']) expect(links).not.toContain('/dashboard/' + tool);
});
it.each(['owner', 'team_leader', 'manager', 'member'])('maps every %s menu destination to exactly one active page', role => {
    const items = dashboardNavigation(role).flatMap(group => group.items);
    for (const item of items) {
        const url = new URL(item.href, 'https://veo.test');
        expect(items.filter(candidate => activeDashboardItem(candidate.href, url.pathname, url.searchParams))).toHaveLength(1);
        expect(dashboardLocation(role, url.pathname, url.searchParams).label).toBe(item.label);
    }
});
it.each(['closed', 'done'])('preserves the old %s deal links', view => {
    expect(dashboardLocation('member', '/dashboard/workspace', new URLSearchParams({ view }))).toEqual({ group: 'Sales', label: 'Deals' });
});
