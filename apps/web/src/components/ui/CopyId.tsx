import { useEffect,useRef,useState,type ReactNode } from 'react';
import { Check,Copy,TriangleAlert } from 'lucide-react';
import './copy-id.css';

export const identifierLabel=(name:string)=>({patient_id:'patient ID',culture_id:'culture ID',ward_code:'ward code',isolate_id:'isolate ID'}[name]||name.replaceAll('_',' '));
export default function CopyId({value,label='ID',children,className=''}:{value:string;label?:string;children?:ReactNode;className?:string}){
  const [state,setState]=useState<'idle'|'copied'|'error'>('idle'),timer=useRef<ReturnType<typeof setTimeout>|null>(null),version=useRef(0);
  useEffect(()=>()=>{version.current++;if(timer.current)clearTimeout(timer.current);},[]);
  useEffect(()=>{version.current++;setState('idle');if(timer.current)clearTimeout(timer.current);},[value]);
  async function copy(){
    const request=++version.current;
    try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(value);if(request!==version.current)return;setState('copied');}
    catch{if(request!==version.current)return;setState('error');}
    if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>setState('idle'),2000);
  }
  return <span className={'copy-id '+className}><span className="copy-id-value">{children??value}</span><button type="button" className={'copy-id-control '+state} aria-label={`Copy ${label} ${value}`} title={state==='copied'?'Copied':state==='error'?'Could not copy. Select the ID to copy it manually.':`Copy ${label}`} onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()} onClick={e=>{e.preventDefault();e.stopPropagation();void copy();}}>{state==='copied'?<Check size={13}/>:state==='error'?<TriangleAlert size={13}/>:<Copy size={13}/>}<span className="copy-id-feedback" aria-live="polite">{state==='copied'?'Copied':state==='error'?'Select the ID to copy':''}</span></button></span>;
}
