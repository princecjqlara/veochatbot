'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { LayoutDashboard, Users, Tag, BarChart3, Settings, User, History, Bot, MessageSquare, FileText, Download, GitBranch, Search, ChevronRight, X } from 'lucide-react';
import { activeDashboardItem, dashboardNavigation } from '@/lib/veo-navigation';
const icons = { home: LayoutDashboard, people: Users, tag: Tag, chart: BarChart3, settings: Settings, user: User, history: History, bot: Bot, message: MessageSquare, file: FileText, download: Download, pipeline: GitBranch };
export default function VeoDashboardNavigation({ role, onNavigate }: { role?: string; onNavigate?: () => void }) {
    const pathname = usePathname(), search = useSearchParams();
    const [query, setQuery] = useState('');
    const groups = useMemo(() => dashboardNavigation(role).map(group => ({ ...group, items: group.items.filter(item => `${group.name} ${item.label}`.toLowerCase().includes(query.trim().toLowerCase())) })).filter(group => group.items.length), [role, query]);
    return <nav aria-label="Main navigation" className="space-y-2 px-3 py-4">
        <div className="relative mb-4">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <input type="search" aria-label="Find a page" placeholder="Find a page…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }} className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-9 text-sm text-slate-900 placeholder:text-slate-400" />
            {query && <button type="button" aria-label="Clear page search" onClick={() => setQuery('')} className="absolute right-1 top-1 rounded-md p-2 text-slate-500 hover:bg-slate-200"><X className="h-4 w-4" /></button>}
        </div>
        {query.trim() && <p role="status" className="px-3 pb-1 text-xs text-slate-500">{groups.reduce((count, group) => count + group.items.length, 0)} pages found</p>}
        {groups.map(group => <details key={group.name + ':' + pathname + ':' + search.get('view') + ':' + query.trim()} open={!!query.trim() || group.items.some(item => activeDashboardItem(item.href, pathname, search))} className="pb-1">
            <summary className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-slate-500 hover:bg-slate-100"><span>{group.name}</span><ChevronRight aria-hidden="true" className="nav-chevron h-3.5 w-3.5 transition-transform" /></summary>
            <div className="space-y-0.5 pb-2">{group.items.map(item => {
                const active = activeDashboardItem(item.href, pathname, search), Icon = icons[item.icon];
                return <Link key={item.href} href={item.href} prefetch={false} aria-current={active ? 'page' : undefined} onClick={() => { setQuery(''); onNavigate?.(); }} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${active ? 'bg-indigo-50 font-semibold text-indigo-800 ring-1 ring-inset ring-indigo-100' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}><Icon aria-hidden="true" className="h-4 w-4 shrink-0" /><span>{item.label}</span>{active && <span aria-hidden="true" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-600" />}</Link>;
            })}</div>
        </details>)}
    </nav>;
}
