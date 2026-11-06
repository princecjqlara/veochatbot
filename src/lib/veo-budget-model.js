// Canonical VEO planner from veo ad budget/budget-model.js.
(function(root){
  'use strict';
  const timeZone='Asia/Manila';
  function addCalendarDays(dateString,days){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dateString)||!Number.isSafeInteger(days))return null;
    const date=new Date(dateString+'T00:00:00Z');
    if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==dateString)return null;
    date.setUTCDate(date.getUTCDate()+days);
    if(!Number.isFinite(date.getTime())||date.getUTCFullYear()<1||date.getUTCFullYear()>9999)return null;
    return date.toISOString().slice(0,10);
  }
  function getCalendarDates(now=new Date()){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(part=>[part.type,part.value]));
    const today=parts.year+'-'+parts.month+'-'+parts.day;
    return {today,tomorrow:addCalendarDays(today,1)};
  }
  function formatCalendarDate(dateString,full=false){
    if(addCalendarDays(dateString,0)===null)return '';
    return new Date(dateString+'T00:00:00+08:00').toLocaleDateString('en-PH',{timeZone,month:full?'long':'short',day:'numeric',year:'numeric',...(full?{weekday:'long'}:{})});
  }
  const calendar={timeZone,getDates:getCalendarDates,addDays:addCalendarDays,format:formatCalendarDate};
  const profile=root.document?.documentElement?.dataset?.plannerProfile==='conservative'?'conservative':'aggressive';
  const profiles={
    aggressive:{baseStepPct:100,minStepPct:10,maxStepPct:80,taperBudget:2000,peopleBoostPct:2,maxPeopleBoostPct:25,profitLiftPct:10,dayBoostPct:5,maxDayBoostPct:100,capacityFillPct:15,reservePct:10,headroomPct:10,rampPerPerson:0.8,rampDays:3},
    conservative:{maxPerPerson:1.6,baseStepPct:40,minStepPct:5,maxStepPct:25,taperBudget:1500,peopleBoostPct:1,maxPeopleBoostPct:10,profitLiftPct:0,dayBoostPct:1,maxDayBoostPct:20,capacityFillPct:3,reservePct:20,headroomPct:20,rampPerPerson:0.6,rampDays:7}
  };
  const defaults={day:1,startingBudget:2000,currentBudget:2800,yesterdayResult:'PROFIT',yesterdayCPA:400,activePeople:5,maxPerPerson:3.5,...profiles[profile],rounding:10};
  const storageKeys=root.document?.documentElement?.dataset?.plannerId==='suno'?['tomorrow-ad-budget-suno-v1']:profile==='conservative'?['tomorrow-ad-budget-conservative-v1']:['tomorrow-ad-budget-v3','tomorrow-ad-budget-v2','tomorrow-ad-budget-v1'];
  const textFields=['yesterdayResult'];
  const labels={day:'Campaign day',startingBudget:'Starting budget',currentBudget:"Today's budget",yesterdayCPA:"Yesterday's CPA",activePeople:'Active people',maxPerPerson:'Maximum projects per person',baseStepPct:'Base budget step',minStepPct:'Smallest step',maxStepPct:'Largest step',taperBudget:'Taper scale',peopleBoostPct:'Boost per extra person',maxPeopleBoostPct:'Maximum team boost',profitLiftPct:'Extra profit step',dayBoostPct:'Boost per campaign day',maxDayBoostPct:'Maximum campaign day boost',capacityFillPct:'Unused capacity growth',reservePct:'Capacity reserve',headroomPct:'Workload buffer',rampPerPerson:'Starting projects per person',rampDays:'Starting period',rounding:'Rounding unit'};
  const clamp=(value,low,high)=>Math.min(high,Math.max(low,value));
  function validate(p){
    const errors=[];
    for(const key of Object.keys(defaults)){
      if(textFields.includes(key))continue;
      if(!Number.isFinite(p[key])||p[key]<0)errors.push(labels[key]+' must be a nonnegative number.');
    }
    for(const key of ['startingBudget','yesterdayCPA','maxPerPerson','taperBudget','rampPerPerson','rounding'])if(p[key]===0)errors.push(labels[key]+' must be greater than zero.');
    for(const key of ['day','activePeople','rampDays'])if(Number.isFinite(p[key])&&!Number.isInteger(p[key]))errors.push(labels[key]+' must be a whole number.');
    if(p.day<1)errors.push('Campaign day must be at least 1.');
    if(!['PROFIT','BREAK-EVEN','LOSS'].includes(p.yesterdayResult))errors.push('Choose Profit, Break-even or Loss.');
    if(p.minStepPct>p.maxStepPct||p.maxStepPct>=100)errors.push('Budget steps need 0 ≤ minimum ≤ maximum < 100%.');
    if(p.baseStepPct>200)errors.push('Base budget step cannot exceed 200%.');
    if(p.reservePct<1||p.reservePct>99)errors.push('Keep a reserve between 1% and 99% below your maximum.');
    if(p.headroomPct>100)errors.push('Workload buffer cannot exceed 100%.');
    if(p.peopleBoostPct>10||p.maxPeopleBoostPct>50)errors.push('Keep the per-person boost at most 10% and the maximum team boost at most 50%.');
    if(p.profitLiftPct>50)errors.push('Extra profit step cannot exceed 50%.');
    if(p.dayBoostPct>20||p.maxDayBoostPct>200)errors.push('Keep the daily boost at most 20% and its maximum at most 200%.');
    if(p.capacityFillPct>50)errors.push('Unused capacity growth cannot exceed 50%.');
    return [...new Set(errors)];
  }
  function calculate(p){
    const errors=validate(p);if(errors.length)return {errors};
    const referenceBudget=p.currentBudget>0?p.currentBudget:p.startingBudget;
    const baseStep=clamp((p.baseStepPct/100)/(1+referenceBudget/p.taperBudget),p.minStepPct/100,p.maxStepPct/100);
    const outcome=p.yesterdayResult;
    const teamBoost=outcome==='PROFIT'?Math.min(p.maxPeopleBoostPct/100,Math.max(0,p.activePeople-1)*p.peopleBoostPct/100):0;
    const profitLift=outcome==='PROFIT'?1+p.profitLiftPct/100:1;
    const dayBoost=outcome==='PROFIT'?Math.min(p.maxDayBoostPct/100,(p.day-1)*p.dayBoostPct/100):0;
    const performanceStep=baseStep*(1+teamBoost)*profitLift*(1+dayBoost);
    const safeMax=p.maxPerPerson*(1-p.reservePct/100);
    const maximumTeamProjects=Math.max(0,Math.floor(p.activePeople*safeMax+1e-9));
    const maximumDailyBudget=Math.floor((maximumTeamProjects*p.yesterdayCPA+1e-9)/p.rounding)*p.rounding;
    const baselinePerPerson=Math.min(p.rampPerPerson,safeMax);
    const inRamp=p.day<=p.rampDays;
    // A profitable result can expand starting capacity to support growth.
    // The user's maximum minus the reserve remains the spending ceiling.
    const rampHeld=inRamp&&outcome!=='PROFIT';
    const allowedPerPerson=rampHeld?baselinePerPerson:safeMax;
    const wholeProjectCapacity=Math.max(0,Math.floor(p.activePeople*allowedPerPerson+1e-9));
    const budgetLimit=wholeProjectCapacity*p.yesterdayCPA;
    const currentBudgetCeiling=Math.floor((budgetLimit+1e-9)/p.rounding)*p.rounding;
    const unusedCapacityBudget=Math.max(0,budgetLimit-referenceBudget);
    const capacityAddition=outcome==='PROFIT'?unusedCapacityBudget*p.capacityFillPct/100:0;
    const step=performanceStep+capacityAddition/referenceBudget;
    const multiplier=outcome==='PROFIT'?1+step:outcome==='BREAK-EVEN'?1-step:(1-step)**2;
    const candidate=referenceBudget*multiplier;
    const rawBudget=Math.max(0,Math.min(candidate,budgetLimit));
    const budget=Math.floor((rawBudget+1e-9)/p.rounding)*p.rounding;
    const changeRate=budget/referenceBudget-1;
    const acquisitions=budget/p.yesterdayCPA;
    const teamQuota=Math.ceil(Math.round(acquisitions*1e8)/1e8);
    const quotaPerPerson=p.activePeople>0?teamQuota/p.activePeople:0;
    const workloadPerPerson=p.activePeople>0?acquisitions/p.activePeople:0;
    const plannedPerPerson=p.activePeople===0?0:rampHeld?baselinePerPerson:Math.min(safeMax,Math.max(baselinePerPerson,quotaPerPerson*(1+p.headroomPct/100)));
    const capacity=p.activePeople*plannedPerPerson;
    const limited=budgetLimit<candidate-1e-7;
    const growthQuota=Math.ceil(Math.round(candidate/p.yesterdayCPA*1e8)/1e8);
    const neededPeople=Math.ceil(growthQuota/allowedPerPerson-1e-9);
    const result={outcome,referenceBudget,baseStep,teamBoost,dayBoost,performanceStep,unusedCapacityBudget,capacityAddition,step,multiplier,candidate,safeMax,maximumTeamProjects,maximumDailyBudget,currentBudgetCeiling,baselinePerPerson,inRamp,rampHeld,allowedPerPerson,wholeProjectCapacity,budgetLimit,budget,changeRate,acquisitions,teamQuota,quotaPerPerson,workloadPerPerson,plannedPerPerson,capacity,limited,neededPeople};
    if(Object.values(result).some(value=>typeof value==='number'&&!Number.isFinite(value)))return {errors:['These inputs exceed the calculator numeric range. Use smaller amounts or team values.']};
    return {errors:[],...result};
  }
  function estimateProfitPlateau(p,iterationLimit=10000){
    const errors=validate(p);if(errors.length)return {errors,complete:false};
    const lastBoostDay=p.dayBoostPct>0&&p.maxDayBoostPct>0?Math.max(p.day,1+Math.ceil(p.maxDayBoostPct/p.dayBoostPct)):p.day;
    if(!Number.isSafeInteger(lastBoostDay))return {errors:['The campaign-day boost horizon is too large to project reliably.'],complete:false};
    let projected={...p,yesterdayResult:'PROFIT'};
    for(let iteration=0;iteration<iterationLimit;iteration++){
      const result=calculate(projected);
      if(result.errors.length)return {errors:result.errors,complete:false};
      const nextDay=projected.day+1;
      if(!Number.isSafeInteger(nextDay))return {errors:['The projected campaign day exceeds the supported range.'],complete:false};
      const nextInputs={...projected,currentBudget:result.budget,day:nextDay};
      const nextResult=calculate(nextInputs);
      if(nextResult.errors.length)return {errors:nextResult.errors,complete:false};
      if(nextResult.budget===result.budget){
        const finalDay=Math.max(nextDay,lastBoostDay);
        const finalResult=calculate({...nextInputs,day:finalDay});
        if(finalResult.errors.length)return {errors:finalResult.errors,complete:false};
        if(finalResult.budget===result.budget){
          const reason=result.budget===result.maximumDailyBudget?'capacity':finalResult.candidate<=result.budget?'growth-disabled':'rounding';
          const daysToPlateau=p.currentBudget>=result.budget?0:projected.day-p.day+1;
          return {errors:[],complete:true,budget:result.budget,nextBudget:nextResult.budget,maximumBoostBudget:finalResult.budget,capacityCeiling:result.maximumDailyBudget,teamQuota:result.teamQuota,day:projected.day,daysToPlateau,reason};
        }
        let firstDay=nextDay,lastDay=finalDay;
        while(firstDay<lastDay){
          const middleDay=firstDay+Math.floor((lastDay-firstDay)/2);
          const middleResult=calculate({...nextInputs,day:middleDay});
          if(middleResult.errors.length)return {errors:middleResult.errors,complete:false};
          if(middleResult.budget>result.budget)lastDay=middleDay;else firstDay=middleDay+1;
        }
        projected={...nextInputs,day:firstDay};
      }else projected=nextInputs;
    }
    return {errors:[],complete:false,reason:'projection-limit'};
  }
  function migrateInputs(saved){
    const p={...defaults};if(!saved||typeof saved!=='object')return p;
    const isCurrent=Object.hasOwn(saved,'maxPerPerson')&&Object.hasOwn(saved,'yesterdayCPA');
    const keys=isCurrent?Object.keys(defaults):['day','startingBudget','currentBudget','yesterdayResult','activePeople'];
    for(const key of keys)if(Object.hasOwn(saved,key))p[key]=saved[key];
    if(!isCurrent){
      if(Number.isFinite(saved.perPerson)&&saved.perPerson>0)p.maxPerPerson=saved.perPerson;
      if(Number.isFinite(saved.baselineCPA)&&saved.baselineCPA>0)p.yesterdayCPA=saved.baselineCPA;
    }
    return p;
  }
  const scenarios=[
    {name:profile==='conservative'?'Profit · grow steadily':'Profit · grow aggressively',patch:{}},
    {name:'Break-even · down 1 step',patch:{yesterdayResult:'BREAK-EVEN'}},
    {name:'Loss · down 2 steps',patch:{yesterdayResult:'LOSS'}},
    {name:'₱1,000 · low workload',patch:{currentBudget:1000}},
    {name:'₱5,000 · capacity rises',patch:{currentBudget:5000}},
    {name:'₱10,000 · below maximum',patch:{currentBudget:10000}},
    {name:'Day 2 · profit grows capacity',patch:{day:2}},
    {name:'5 people · day 1 profit',patch:{currentBudget:2800,startingBudget:2000,day:1,activePeople:5,maxPerPerson:defaults.maxPerPerson,yesterdayCPA:400}},
    {name:profile==='conservative'?'10 people · measured growth':'10 people · extra growth',patch:{currentBudget:2800,startingBudget:2000,day:1,activePeople:10,maxPerPerson:defaults.maxPerPerson,yesterdayCPA:400}},
    {name:'5 people · campaign day 5',patch:{currentBudget:2800,startingBudget:2000,day:5,activePeople:5,maxPerPerson:defaults.maxPerPerson,yesterdayCPA:400}},
    {name:'5 people · campaign day 10',patch:{currentBudget:2800,startingBudget:2000,day:10,activePeople:5,maxPerPerson:defaults.maxPerPerson,yesterdayCPA:400}}
  ];
  const formulas=`INPUTS (default values)
TodayBudget = 2800         StartingBudget = 2000
YesterdayResult = "PROFIT"  (or "BREAK-EVEN" / "LOSS")
YesterdayCPA = 400         ActivePeople = 5
MaxPerPerson = ${defaults.maxPerPerson}         TomorrowDay = 1

SETTINGS
BaseStep = ${defaults.baseStepPct}%            MinStep = ${defaults.minStepPct}%       MaxStep = ${defaults.maxStepPct}%
TaperScale = ${defaults.taperBudget}          Reserve = ${defaults.reservePct}%       Headroom = ${defaults.headroomPct}%
BoostPerPerson = ${defaults.peopleBoostPct}%        MaxTeamBoost = ${defaults.maxPeopleBoostPct}%
ExtraProfitStep = ${defaults.profitLiftPct}%
DayBoostRate = ${defaults.dayBoostPct}%          MaxDayBoost = ${defaults.maxDayBoostPct}%   CapacityFill = ${defaults.capacityFillPct}%
StartPerPerson = ${defaults.rampPerPerson}       RampDays = ${defaults.rampDays}        RoundUnit = ${defaults.rounding}

BUDGET FORMULA
ReferenceBudget = IF(TodayBudget>0,TodayBudget,StartingBudget)
BaseStepRate = MAX(MinStep,MIN(MaxStep,BaseStep/(1+ReferenceBudget/TaperScale)))
TeamBoost = IF(YesterdayResult="PROFIT",MIN(MaxTeamBoost,MAX(0,ActivePeople-1)*BoostPerPerson),0)
ProfitLift = IF(YesterdayResult="PROFIT",1+ExtraProfitStep,1)
DayBoost = IF(YesterdayResult="PROFIT",MIN(MaxDayBoost,MAX(0,TomorrowDay-1)*DayBoostRate),0)
PerformanceStep = BaseStepRate*(1+TeamBoost)*ProfitLift*(1+DayBoost)
SafeMax = MaxPerPerson*(1-Reserve)
MaximumTeamProjects = MAX(0,ROUNDDOWN(ActivePeople*SafeMax+1E-9,0))
MaximumDailyBudget = FLOOR(MaximumTeamProjects*YesterdayCPA+1E-9,RoundUnit)
Baseline = MIN(StartPerPerson,SafeMax)
HoldStartingCapacity = AND(TomorrowDay<=RampDays,YesterdayResult<>"PROFIT")
AllowedPerPerson = IF(HoldStartingCapacity,Baseline,SafeMax)
WholeProjectCapacity = MAX(0,ROUNDDOWN(ActivePeople*AllowedPerPerson+1E-9,0))
TeamBudgetLimit = WholeProjectCapacity*YesterdayCPA
CurrentBudgetCeiling = FLOOR(TeamBudgetLimit+1E-9,RoundUnit)
UnusedCapacityBudget = MAX(0,TeamBudgetLimit-ReferenceBudget)
CapacityAddition = IF(YesterdayResult="PROFIT",UnusedCapacityBudget*CapacityFill,0)
Step = PerformanceStep+CapacityAddition/ReferenceBudget
Multiplier = IF(YesterdayResult="PROFIT",1+Step,IF(YesterdayResult="BREAK-EVEN",1-Step,(1-Step)^2))
GrowthBudget = ReferenceBudget*Multiplier
TomorrowBudget = FLOOR(MAX(0,MIN(GrowthBudget,TeamBudgetLimit))+1E-9,RoundUnit)
FinalChange = TomorrowBudget/ReferenceBudget-1

AUTOMATIC CAPACITY FORMULA
ExpectedProjects = TomorrowBudget/YesterdayCPA
WorkloadPerPerson = IF(ActivePeople>0,ExpectedProjects/ActivePeople,0)
TeamSalesQuota = ROUNDUP(ROUND(ExpectedProjects,8),0)
AverageQuotaPerPerson = IF(ActivePeople>0,TeamSalesQuota/ActivePeople,0)
PlannedPerPerson = IF(ActivePeople=0,0,IF(HoldStartingCapacity,Baseline,MIN(SafeMax,MAX(Baseline,AverageQuotaPerPerson*(1+Headroom)))))
TeamCapacity = ActivePeople*PlannedPerPerson
PeopleForFullGrowth = MAX(0,ROUNDUP(ROUNDUP(ROUND(GrowthBudget/YesterdayCPA,8),0)/AllowedPerPerson-1E-9,0))

Capacity is calculated from the recommended budget and your CPA.
Profit can increase capacity from the starting level on any campaign day.
Campaign day means age: it boosts one profit step from today's budget.
The unused capacity allowance expands with team size and falls as capacity fills.
The full maximum is never used: Reserve must stay between 1% and 99%.
Zero active people gives a zero ad budget. CPA and maximum capacity must be positive.
Capacity and estimated projects may be fractional averages across the team.`;
  root.BudgetModel={calendar,profile,profiles,storageKeys,defaults,textFields,calculate,validate,estimateProfitPlateau,migrateInputs,scenarios,formulas};
})(globalThis);

export default globalThis.BudgetModel;
