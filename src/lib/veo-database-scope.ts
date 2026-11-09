export const VEO_DATABASE_PROJECT='vhtbmdizugnxkgocmruq';
const approvedProjects=[VEO_DATABASE_PROJECT,'mjuluaqrvbnycisnarzi'];
export function assertVeoDatabaseUrl(url:string):void {
    const hostname=new URL(url).hostname;
    if(hostname==='pnhzpeyzpwsmwcuafgpw.supabase.co')throw new Error('The former shared database is disabled for VeoBot.');
    if(process.env.VEO_PAGE_SCOPE_ENFORCED==='true') {
        const expected=process.env.VEO_DATABASE_PROJECT_REF||VEO_DATABASE_PROJECT;
        if(!approvedProjects.includes(expected)||hostname!==expected+'.supabase.co')throw new Error('VeoBot must use its configured Supabase project.');
    }
}
