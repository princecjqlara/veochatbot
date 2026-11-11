'use client';
import { useState } from 'react';
export default function VeoAccountLoginSetup({ account, onSaved }: { account: { id: string; name: string; email?: string | null }; onSaved: () => void }) {
    const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
    return <form className="rounded border bg-white p-5 space-y-3" onSubmit={async event=>{
        event.preventDefault();if(busy)return;const form=event.currentTarget,values=new FormData(form);setBusy(true);setMessage('');
        try{const response=await fetch('/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'recover_account_login',user_id:account.id,email:values.get('email'),password:values.get('password')})});
            const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save sign-in');form.reset();setMessage('Sign-in saved. Account permissions stay unchanged.');onSaved();
        }catch(error){setMessage(error instanceof Error?error.message:'Could not save sign-in');}finally{setBusy(false);}
    }}><h3 className="font-bold">Set up sign-in: {account.name}</h3>
        <label className="block">Email<input className="block rounded border p-2 w-full" name="email" type="email" autoComplete="off" defaultValue={account.email||''} required /></label>
        <label className="block">Password to use<input className="block rounded border p-2 w-full" name="password" type="password" autoComplete="new-password" required /></label>
        <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40">{busy?'Saving…':'Save sign-in'}</button>{message&&<p role="status" className="text-sm">{message}</p>}
    </form>;
}
