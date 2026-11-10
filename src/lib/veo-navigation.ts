export type NavigationItem = { href: string; label: string; icon: 'home' | 'people' | 'tag' | 'chart' | 'settings' | 'user' | 'history' | 'bot' | 'message' | 'file' | 'download' | 'pipeline' };
export function dashboardNavigation(role?: string) {
    const head = role === 'owner' || role === 'team_leader';
    const item = (href: string, label: string, icon: NavigationItem['icon'] = 'people'): NavigationItem => ({ href, label, icon });
    const area = (view: string, label: string, icon: NavigationItem['icon'] = 'people') => item('/dashboard/workspace?view=' + view, label, icon);
    const groups = [
        { name: 'Work', items: [item('/dashboard/workspace', head ? 'Teams dashboard' : 'Dashboard', 'home'), area('new_clients', 'New clients'), ...(!head ? [area('clients', 'Clients')] : []), item('/dashboard/contacts', 'Contacts & bulk tools'), item('/dashboard/tags', 'Contact tags', 'tag')] },
        { name: 'Sales', items: [...(!head ? [area('deals', 'Deals', 'chart')] : []), area('receipts', 'Receipts & payments', 'file'), area('salary', 'Salary', 'chart'), ...(!head ? [item('/dashboard/pipeline', 'Pipeline', 'pipeline')] : [])] },
        { name: 'Team', items: [area('telegram', 'Telegram groups & Pages'), area('capacity', 'Capacity & quotas', 'chart'), area('warnings', 'Staff alerts', 'history'), ...(role !== 'member' ? [area('accounts', 'Accounts & teams')] : [])] },
        { name: 'Reports', items: [...(head ? [item('/dashboard/ad-calendar', 'Calendar & analytics', 'chart'), item('/dashboard/ad-quality', 'Ads performance', 'chart'), area('calendar', 'Work calendar & earnings', 'chart'), area('budget', 'Page ad budget', 'chart')] : []), ...(role !== 'member' ? [area('performance', 'Employee performance', 'chart'), area('rankings', 'Rankings', 'chart')] : [])] },
        { name: 'Tools & settings', items: [area('sync', 'Collection health', 'history'), ...(head || !role ? [item('/dashboard/chatbot', 'AI chatbot', 'bot'), item('/dashboard/pricing', 'Pricing packages', 'chart'), item('/dashboard/automations', 'Follow-ups', 'message'), item('/dashboard/settings', 'Settings', 'settings')] : [item('/dashboard/campaigns', 'Campaigns', 'message'), item('/dashboard/exports', 'Exports', 'download')]), item('/dashboard/templates', 'Templates', 'file'), ...(!role ? [item('/dashboard/7-day-contacts', '7-day contacts', 'history'), item('/dashboard/history', 'History', 'history'), item('/dashboard/welcome', 'Welcome', 'message')] : []), area('profile', 'My profile', 'user')] }
    ];
    return groups.filter(group => group.items.length);
}

export function activeDashboardItem(href: string, pathname: string, search: Pick<URLSearchParams, 'get'>) {
    const target = new URL(href, 'https://veo.invalid');
    if (target.pathname !== pathname) return target.pathname === '/dashboard/contacts' && pathname.startsWith('/dashboard/contacts/');
    if (pathname !== '/dashboard/workspace') return true;
    let view = search.get('view') || 'dashboard';
    if (view === 'closed' || view === 'done') view = 'deals';
    return view === (target.searchParams.get('view') || 'dashboard');
}

export function dashboardLocation(role: string | undefined, pathname: string, search: Pick<URLSearchParams, 'get'>) {
    for (const group of dashboardNavigation(role)) {
        const current = group.items.find(item => activeDashboardItem(item.href, pathname, search));
        if (current) return { group: group.name, label: pathname.startsWith('/dashboard/contacts/') ? 'Contact profile' : current.label };
    }
    return { group: 'Workspace', label: pathname.split('/').filter(Boolean).pop()?.replaceAll('-', ' ') || 'Dashboard' };
}
