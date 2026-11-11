import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const files=vi.hoisted(()=>({mkdirSync:vi.fn(),writeFileSync:vi.fn()}));
vi.mock('node:fs',()=>({default:files}));
const originalArgv=process.argv,originalExit=process.exitCode;
const target='https://veochatbot.vercel.app/api/cron/meta-ads-sync';
let fetcher;
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();vi.stubEnv('CRONJOB_API_KEY','test-only-key');vi.stubEnv('CRON_SECRET','test-only-secret');vi.stubEnv('META_ADS_CRON_JOB_ID','');process.argv=['node','script','--apply'];vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{process.argv=originalArgv;process.exitCode=originalExit;vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
it('changes only the existing matching ads job to hourly and sends exactly one Authorization header',async()=>{
 const before={jobId:42,url:target,title:'Existing ads',enabled:true,extendedData:{headers:{authorization:'old','X-Existing':'retained'}}};let after;
 fetcher.mockImplementation(async(url,options)=>{
  if(options.method==='PATCH'){expect(url).toBe('https://api.cron-job.org/jobs/42');after={...before,...JSON.parse(options.body).job};return Response.json({});}
  return Response.json(url.endsWith('/jobs')?{jobs:[before]}:{jobDetails:after||before});
 });await import('./configure-meta-ads-cron.mjs');
 expect(fetcher.mock.calls.filter(([,o])=>o.method==='PATCH')).toHaveLength(1);expect(fetcher.mock.calls.some(([,o])=>['PUT','DELETE'].includes(o.method))).toBe(false);
 expect(after.schedule).toEqual({timezone:'Asia/Manila',expiresAt:0,hours:[-1],mdays:[-1],minutes:[0],months:[-1],wdays:[-1]});expect(after.extendedData.headers).toEqual({'X-Existing':'retained',Authorization:'Bearer test-only-secret'});
 expect(files.writeFileSync).toHaveBeenCalled();
});
it('refuses to create or repurpose another job when no matching existing endpoint is found',async()=>{
 fetcher.mockResolvedValue(Response.json({jobs:[{jobId:99,url:'https://other.test/api/cron/meta-ads-sync'}]}));await import('./configure-meta-ads-cron.mjs');
 expect(process.exitCode).toBe(1);expect(fetcher).toHaveBeenCalledOnce();expect(files.writeFileSync).not.toHaveBeenCalled();
});
it('refuses ambiguous duplicates before changing schedules',async()=>{
 fetcher.mockResolvedValue(Response.json({jobs:[{jobId:1,url:target},{jobId:2,url:target}]}));await import('./configure-meta-ads-cron.mjs');expect(process.exitCode).toBe(1);expect(fetcher).toHaveBeenCalledOnce();
});
