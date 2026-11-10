'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, Home, RefreshCw } from 'lucide-react';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => { console.error('Dashboard error:', error); }, [error]);
    return <section className="mx-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <AlertCircle aria-hidden="true" className="mb-4 h-8 w-8 text-red-500" />
        <h1 className="text-2xl font-semibold tracking-tight">This page could not load</h1>
        <p role="alert" className="mt-3 text-sm leading-6 text-slate-600">{error.message || 'An unexpected error occurred in the dashboard.'}</p>
        {error.digest && <p className="mt-2 text-xs text-slate-500">Error ID: {error.digest}</p>}
        <div className="mt-6 flex flex-col gap-3">
            <button type="button" onClick={reset} className="btn-wireframe-dark"><RefreshCw className="h-4 w-4" />Try again</button>
            <Link href="/dashboard" className="btn"><ArrowLeft className="h-4 w-4" />Back to Dashboard</Link>
            <Link href="/" className="btn"><Home className="h-4 w-4" />Go home</Link>
        </div>
    </section>;
}
