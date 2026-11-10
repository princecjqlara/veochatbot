'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { LayoutDashboard, Users, Tag, BarChart3, Settings, User, History, Bot, MessageSquare, FileText, Download, GitBranch } from 'lucide-react';
import { activeDashboardItem, dashboardNavigation } from '@/lib/veo-navigation';
const icons = { home: LayoutDashboard, people: Users, tag: Tag, chart: BarChart3, settings: Settings, user: User, history: History, bot: Bot, message: MessageSquare, file: FileText, download: Download, pipeline: GitBranch };
export default function VeoDashboardNavigation({ role, onNavigate }: { role?: string; onNavigate?: () => void }) {
    const pathname = usePathname(), search = useSearchParams();
    return <nav aria-label="Main navigation" className="space-y-1 px-3 py-3">
        {dashboardNavigation(role).map(group => <details key={group.name + ':' + pathname + ':' + search.get('view')} open={group.items.some(item => activeDashboardItem(item.href, pathname, search))} className="border-b border-slate-200 pb-1">
            <summary className="cursor-pointer rounded px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-100">{group.name}</summary>
            <div className="space-y-0.5 pb-2">{group.items.map(item => {
                const active = activeDashboardItem(item.href, pathname, search), Icon = icons[item.icon];
                return <Link key={item.href} href={item.href} prefetch={false} aria-current={active ? 'page' : undefined} onClick={onNavigate} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${active ? 'bg-slate-900 font-semibold text-white' : 'text-slate-700 hover:bg-slate-100'}`}><Icon className="h-4 w-4 shrink-0" /><span>{item.label}</span></Link>;
            })}</div>
        </details>)}
    </nav>;
}
