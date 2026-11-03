type ScopeDb={from?:unknown;rpc?:(name:string,args:Record<string,unknown>)=>any};
/** Only enabled on the separated database. An unavailable ownership read must
 * never release historical automation belonging to another Facebook app. */
export async function getAutomationPageScope(db:ScopeDb):Promise<string[]|null>{
 if(process.env.VEO_ENFORCE_PAGE_RUNTIME_SCOPE!=='true')return null;
 if(!db.rpc)throw new Error('Page automation ownership cannot be checked');
 const {data,error}=await db.rpc('get_automation_page_scope',{});
 if(error)throw new Error('Page automation ownership is temporarily unavailable');
 if(!Array.isArray(data)||data.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)))throw new Error('Page automation ownership is not configured');
 return data;
}
export function scopeAutomationQuery(query:any,scope:string[]|null,column='page_id'):any{
 return scope===null?query:query.in(column,scope.length?scope:['00000000-0000-0000-0000-000000000000']);
}
