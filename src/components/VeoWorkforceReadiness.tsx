import Link from 'next/link';
export default function VeoWorkforceReadiness({ readiness }: { readiness?: { workers: number; enabled: number; disabled: number; unknown: number } }) {
    if (!readiness || (!readiness.disabled && !readiness.unknown)) return null;
    return <aside className="rounded border border-amber-200 bg-amber-50 p-3 text-sm space-y-1" aria-label="Workforce setup coverage">
        <p className="font-semibold">Staff setup needs attention</p>
        <p>{readiness.enabled} of {readiness.workers} roster accounts have enabled sign-in. {readiness.disabled} have disabled logins{readiness.unknown ? `; ${readiness.unknown} login states are unavailable` : ''}.</p>
        <p>Full capacity includes retained roster estimates. Confirm staff access and attendance before using it as available production capacity. A target of one can be the default for insufficient history.</p>
        <Link className="underline" href="/dashboard/workspace?view=accounts">Review staff accounts and login setup</Link>
    </aside>;
}
