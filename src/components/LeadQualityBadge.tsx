import{leadQualityForStage}from'@/lib/lead-quality';
export default function LeadQualityBadge({stage}:{stage:unknown}){
 const quality=leadQualityForStage(stage),color=quality.status==='poor'?'border-red-600 bg-red-50 text-red-900':quality.status==='good'?'border-green-700 bg-green-50 text-green-900':'border-gray-400 bg-gray-50 text-gray-700';
 return <span data-lead-quality={quality.status} title={quality.reason} className={`inline-block border px-2 py-1 text-xs normal-case ${color}`}>{quality.label}</span>;
}
