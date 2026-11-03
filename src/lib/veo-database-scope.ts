export const VEO_DATABASE_PROJECT='vhtbmdizugnxkgocmruq';
export function assertVeoDatabaseUrl(url:string):void {
    const hostname=new URL(url).hostname;
    if(hostname==='pnhzpeyzpwsmwcuafgpw.supabase.co')throw new Error('The former shared database is disabled for VeoBot.');
    if(process.env.VEO_PAGE_SCOPE_ENFORCED==='true'&&hostname!==VEO_DATABASE_PROJECT+'.supabase.co')throw new Error('VeoBot must use its configured Supabase project.');
}
