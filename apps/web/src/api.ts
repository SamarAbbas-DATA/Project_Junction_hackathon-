export type Row=Record<string,any>;
export type Field={name:string;type?:'integer'|'number';required?:boolean;nullable?:boolean;values?:(string|number)[];date?:boolean};
export type Table={source:string;name:string;label:string;keys:string[];fields:Field[];description:string};
export async function api<T=Row>(path:string,options:RequestInit={}):Promise<T>{
  const response=await fetch('/api'+path,{...options,headers:{...(options.body?{'content-type':'application/json'}:{}),...options.headers}});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data;
}
export async function streamAssistant(body:Row,onEvent:(event:Row)=>void,signal:AbortSignal){
  const response=await fetch('/api/assistant/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||`Assistant request failed (${response.status})`);}
  if(!response.body)throw new Error('Streaming is unavailable in this browser.');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',finished=false;
  const deliver=(line:string)=>{if(!line.trim())return;const event=JSON.parse(line);if(event.type==='done'||event.type==='error')finished=true;onEvent(event);};
  try{while(true){const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});let index:number;while((index=buffer.indexOf('\n'))>=0){deliver(buffer.slice(0,index));buffer=buffer.slice(index+1);}if(done){deliver(buffer);break;}}
    if(!finished&&!signal.aborted)throw new Error('The connection ended before the answer finished. Please retry.');
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export const num=(n:number|string|undefined)=>Number(n||0).toLocaleString();
export const label=(value:string)=>value.replaceAll('_',' ').replace(/^\w/,c=>c.toUpperCase());
export const keyOf=(table:Table,row:Row)=>table.keys.map(k=>row[k]).join('~');
export const sourceInfo:Record<string,{label:string;short:string;description:string;color:string;port:number}>={
  adt:{label:'Patient administration',short:'ADT',description:'Patient identity, wards & stays',color:'blue',port:8001},
  lis:{label:'Microbiology laboratory',short:'LIS',description:'Cultures, isolates & test results',color:'green',port:8002},
  formulary:{label:'Pharmacy & reference',short:'REF',description:'Antibiotics & interpretation guidelines',color:'purple',port:8003}
};
