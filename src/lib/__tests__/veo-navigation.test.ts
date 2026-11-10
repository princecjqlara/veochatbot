import { expect, it } from 'vitest';
import { activeDashboardItem, dashboardLocation, dashboardNavigation } from '../veo-navigation';

it('keeps contact navigation active while reading a full contact profile', () => {
    const params = new URLSearchParams();
    expect(activeDashboardItem('/dashboard/contacts', '/dashboard/contacts/client-id', params)).toBe(true);
    expect(activeDashboardItem('/dashboard/contacts', '/dashboard/contacts-other', params)).toBe(false);
    expect(dashboardLocation('member', '/dashboard/contacts/client-id', params)).toEqual({ group: 'Work', label: 'Contact profile' });
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
