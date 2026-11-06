import pages from '@/config/veo-pages.json';
const normalize=(name:string)=>name.trim().replace(/\s+/g,' ').toLowerCase();
/** Names only resolve Pages whose Facebook ID has not been discovered yet. */
export function isApprovedVeoPage(id:string,name:string):boolean {
    return pages.some(page=>page.facebook_page_id ? page.facebook_page_id===id : normalize(page.name)===normalize(name));
}
export function filterVeoPages<T extends {id:string;name:string}>(pages:T[]):T[] {
    return process.env.VEO_WORKSPACE_ENABLED==='true'||process.env.VEO_PAGE_SCOPE_ENFORCED==='true' ? pages.filter(page=>isApprovedVeoPage(page.id,page.name)) : pages;
}
