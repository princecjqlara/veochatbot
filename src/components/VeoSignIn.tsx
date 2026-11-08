'use client';
import { useSession, signIn, signOut } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
export default function VeoSignIn() {
    const { status, data: session } = useSession(), router = useRouter(), params = useSearchParams();
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => {
        if (status !== 'authenticated') return;
        if (!session?.user.id) { void signOut({ callbackUrl: '/' }); return; }
        router.replace('/dashboard/workspace');
    }, [status, router, session?.user.id]);
    return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-slate-900"><section className="max-w-lg w-full rounded-xl border bg-white p-8 shadow-sm"><p className="text-xs tracking-widest uppercase">CJ Lara’s workspace</p><h1 className="mt-2 text-4xl font-bold">VEO</h1><p className="my-5 text-slate-600">Sign in with your administrator-created account, then confirm your Telegram username.</p><form className="space-y-4" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError('');
        const f = new FormData(e.currentTarget);
        try { const r = await signIn('credentials', { email: f.get('email'), password: f.get('password'), redirect: false });
            if (r?.ok) router.push('/dashboard/workspace'); else setError('Sign-in failed. Check the account, password and selected role, or wait before retrying.');
        } finally { setBusy(false); }
    }}><label className="block text-sm">Email<input className="border rounded p-3 w-full mt-1" name="email" type="email" autoComplete="username" required /></label><label className="block text-sm">Password<input className="border rounded p-3 w-full mt-1" name="password" type="password" autoComplete="current-password" required /></label><button disabled={busy} className="bg-slate-900 text-white rounded p-3 w-full disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button></form>{(error || params.get('error')) && <p role="alert" className="text-sm text-red-700 mt-4">{error || 'Sign-in failed. Check the email and password or contact your administrator.'}</p>}<p className="text-xs text-slate-500 mt-5">Your account permissions are applied automatically after sign-in.</p></section></main>;
}
