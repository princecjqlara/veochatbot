'use client';
import{useEffect,useState}from'react';
type Ad={ad_id:string|null;ad_name?:string|null;ad_title?:string|null;photo_url?:string|null;video_url?:string|null;post_id?:string|null;post_permalink_url?:string|null};
const https=(s?:string|null)=>{try{const u=new URL(s||'');return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
export default function AdCreativePreview({ad}:{ad:Ad}){
 const [open,setOpen]=useState(false),[imageFailed,setImageFailed]=useState(false),[videoFailed,setVideoFailed]=useState(false);const photo=https(ad.photo_url),video=https(ad.video_url),post=https(ad.post_permalink_url)||(ad.post_id&&/^\d+(?:_\d+)?$/.test(ad.post_id)?'https://www.facebook.com/'+ad.post_id:null),title=ad.ad_name||ad.ad_title||'Ad '+ad.ad_id;
 useEffect(()=>{setImageFailed(false);setVideoFailed(false);},[photo,video]);
 useEffect(()=>{if(!open)return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[open]);
 if(!ad.ad_id)return null;
 return <div className="mt-2 space-y-1"><button type="button" aria-label={`Preview ad ${ad.ad_id}`} onClick={()=>setOpen(true)} className="block border border-black bg-gray-50 w-44 max-w-full text-left">{photo&&!imageFailed?<img src={photo} alt={title} loading="lazy" referrerPolicy="no-referrer" onError={()=>setImageFailed(true)} className="w-full h-24 object-contain bg-gray-100"/>:<span className="block p-4 text-sm">{video?'▶ Video creative':'Open ad preview'}</span>}<span className="block px-2 py-1 text-xs underline">{video?'Preview video':'Preview creative'}</span></button>
 {post&&<a href={post} target="_blank" rel="noopener noreferrer" className="underline text-xs">Open original Facebook post</a>}
 {open&&<div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-3" onClick={()=>setOpen(false)}><div role="dialog" aria-modal="true" aria-label="Ad creative preview" className="bg-white border-2 border-black p-4 w-full max-w-3xl max-h-[92vh] overflow-auto" onClick={e=>e.stopPropagation()}><div className="flex justify-between gap-3 mb-3"><h2 className="font-bold">{title}</h2><button type="button" aria-label="Close ad preview" className="border border-black px-3 py-1" onClick={()=>setOpen(false)}>Close</button></div>
 {video&&!videoFailed?<video controls preload="none" poster={photo||undefined} src={video} onError={()=>setVideoFailed(true)} className="max-h-[65vh] w-full bg-black"/>:photo&&!imageFailed?<img src={photo} alt={title} onError={()=>setImageFailed(true)} className="max-h-[65vh] w-full object-contain"/>:<p>Facebook has not supplied a usable preview. Open the original post or refresh ad previews.</p>}
 {videoFailed&&<p className="mt-2 text-sm">This video link is unavailable or expired. Refresh ad previews or open the original Facebook post.</p>}
 <p className="text-xs mt-3">Ad ID {ad.ad_id}. This is the recorded Facebook creative. Lead counts use verified source evidence.</p>{post&&<a href={post} target="_blank" rel="noopener noreferrer" className="underline text-sm">Open original Facebook post</a>}</div></div>}
 </div>;
}
