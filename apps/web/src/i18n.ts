import { useSyncExternalStore } from 'react';
import { fi } from './locales/fi';

export type Language='en'|'fi';
const storageKey='tyks-mylab-language';
function savedLanguage():Language{try{return localStorage.getItem(storageKey)==='fi'?'fi':'en';}catch{return 'en';}}
let language:Language=savedLanguage();
const listeners=new Set<()=>void>();
export const getLanguage=()=>language;
export const locale=()=>language==='fi'?'fi-FI':'en-GB';
function applyLanguage(){if(typeof document!=='undefined'){document.documentElement.lang=language;document.title=language==='fi'?'TYKS × MYLAB · Kliininen työtila':'TYKS × MYLAB · Clinical workspace';}}
applyLanguage();
export function setLanguage(value:Language){
  if(value!=='fi'&&value!=='en')return;
  language=value;try{localStorage.setItem(storageKey,value);}catch{/* Storage can be disabled; the in-memory selection still works. */}
  applyLanguage();listeners.forEach(listener=>listener());
}
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export function useLocale(){return {language:useSyncExternalStore(subscribe,getLanguage,()=> 'en' as Language),setLanguage,t,locale};}

// Named interpolation keeps identifiers untouched and allows Finnish word order.
export function t(text:string,values?:Record<string,string|number>):string{
  let translated=language==='fi'?(fi[text]??text.replace(/^(\s*)(.*?)(\s*)$/s,(_match,before,content,after)=>before+(fi[content]??content)+after)):text;
  if(values)translated=translated.replace(/\{(\w+)\}/g,(token,key)=>String(values[key]??token));
  return translated;
}
export const wardName=(row:{ward_fi?:string;ward_en?:string;ward_code?:string})=>language==='fi'?(row.ward_fi||t(row.ward_en||'')||row.ward_code||''):(row.ward_en||row.ward_code||'');
