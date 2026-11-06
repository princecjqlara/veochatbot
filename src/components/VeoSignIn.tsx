'use client';
import { useSession, signIn } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
export default function VeoSignIn() {
    const { status, data: session } = useSession(), router = useRouter(), params = useSearchParams();
    const [role, setRole] = useState('member'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => { if (status === 'authenticated') router.replace(session?.user.role ? '/dashboard/workspace' : '/dashboard'); }, [status, router, session?.user.role]);
    return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-slate-900"><section className="max-w-lg w-full rounded-xl border bg-white p-8 shadow-sm"><p className="text-xs tracking-widest uppercase">CJ Lara’s workspace</p><h1 className="mt-2 text-4xl font-bold">VEO</h1><p className="my-5 text-slate-600">Sign in with your administrator-created account, then confirm your Telegram username.</p><fieldset className="grid grid-cols-2 gap-2 mb-5"><legend className="mb-2 text-sm font-semibold">Sign-in role</legend>{[['member', 'Member'], ['manager', 'Manager'], ['team_leader', 'Team Leader'], ['owner', 'Owner']].map(([value, title]) => <label key={value} className={`border rounded px-3 py-2 cursor-pointer ${role === value ? 'border-slate-900 bg-slate-100' : ''}`}><input type="radio" name="role" value={value} checked={role === value} onChange={() => setRole(value)} className="mr-2" />{title}</label>)}</fieldset><form className="space-y-4" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError('');
        const f = new FormData(e.currentTarget);
        try { const r = await signIn('credentials', { email: f.get('email'), password: f.get('password'), role, redirect: false });
            if (r?.ok) router.push('/dashboard/workspace'); else setError('Sign-in failed. Check the account, password and selected role, or wait before retrying.');
        } finally { setBusy(false); }
    }}><label className="block text-sm">Email<input className="border rounded p-3 w-full mt-1" name="email" type="email" autoComplete="username" required /></label><label className="block text-sm">Password<input className="border rounded p-3 w-full mt-1" name="password" type="password" autoComplete="current-password" required /></label><button disabled={busy} className="bg-slate-900 text-white rounded p-3 w-full disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button></form>{role === 'owner' && <button className="border rounded p-3 w-full mt-4" onClick={() => {
        document.cookie = `veo-login-role=owner; Path=/; SameSite=Lax; Max-Age=600${location.protocol === 'https:' ? '; Secure' : ''}`;
        void signIn('facebook', { callbackUrl: '/dashboard' }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE });
    }}>Continue with Facebook (CJ Lara)</button>}{(error || params.get('error')) && <p role="alert" className="text-sm text-red-700 mt-4">{error || 'This Facebook identity or selected role is not authorized.'}</p>}<p className="text-xs text-slate-500 mt-5">Facebook sign-in is reserved for CJ Lara. Other roles use email and password. Your selected role must match your account.</p></section></main>;
}
