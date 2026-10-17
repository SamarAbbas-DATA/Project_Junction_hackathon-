import { hubPort } from './config.js';

const args=process.argv.slice(2),value=(flag:string)=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined;};
const patient=value('--patient'),culture=value('--culture'),ward=value('--ward');
const message=value('--query')||'Summarize the available records and AMR model estimates.';
const mode=patient?'patient':culture?'culture':ward?'ward':'general',identifier=patient||culture||ward;
try {
  const response=await fetch(`http://127.0.0.1:${hubPort}/api/assistant/search`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode,identifier,message}),signal:AbortSignal.timeout(30000)});
  const body=await response.json();if(!response.ok)throw new Error((body as {error?:string}).error||`HTTP ${response.status}`);
  console.log(JSON.stringify(body,null,2));
}catch(error){console.error('Search failed. Start the API with npm run dev. '+(error as Error).message);process.exitCode=1;}
