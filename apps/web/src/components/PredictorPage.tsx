import { useEffect,useRef,useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion,useReducedMotion } from 'motion/react';
import { BrainCircuit,Check,ChevronRight,FlaskConical,Info,Loader2,Plus,RefreshCw,Search,ShieldCheck,UserRound,X } from 'lucide-react';
import { api,num,type Row } from '../api';
import { useDebounced } from './ui/motion';
import CopyId from './ui/CopyId';
import './predictor.css';

type Inputs={specimen:string;setting:string;age:number|string;organism:string;history:{prior_results:Row[];prior_antibiotics:Row[];prior_organisms?:Row[];nursing_home?:boolean};known_results:Record<string,string>;flags:Record<string,boolean>};
const fresh=():Inputs=>({specimen:'urine',setting:'emergency',age:78,organism:'',history:{prior_results:[],prior_antibiotics:[]},known_results:{},flags:{}});
const evidence:Record<string,string>={model:'Model',lab:'Lab',intrinsic:'Intrinsic',rule:'Flag rule'};
const flags=['mrsa','vre','cre','esbl'];
const percent=(r:Row)=>Number(r.percent_works??r.percent_covers??0);
const tone=(p:number)=>p>=80?'good':p>=50?'mid':'low';

export default function PredictorPage(){
  const reducedMotion=useReducedMotion(),explanationAnchor=useRef<HTMLDivElement>(null);
  const [inputs,setInputs]=useState<Inputs>(fresh),[result,setResult]=useState<Row|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [search,setSearch]=useState(''),[loaded,setLoaded]=useState<Row|null>(null),[loadingPatient,setLoadingPatient]=useState(false),[patientError,setPatientError]=useState(''),[edited,setEdited]=useState(false),[selectedIsolate,setSelectedIsolate]=useState('');
  const [explanation,setExplanation]=useState<Row|null>(null),[explainBusy,setExplainBusy]=useState(false),[deltas,setDeltas]=useState<Row>({});
  const predictVersion=useRef(0),explainVersion=useRef(0),patientVersion=useRef(0),previous=useRef<{key:string;rows:Row}>({key:'',rows:{}});
  const meta=useQuery({queryKey:['predictor-meta'],queryFn:()=>api('/predictor/meta'),retry:false,staleTime:Infinity});
  const query=useDebounced(search);
  const matches=useQuery({queryKey:['predictor-patient-search',query],queryFn:()=>api('/patients?'+new URLSearchParams({q:query.trim(),limit:'6'})),enabled:query.trim().length>0});
  const model=meta.data;
  const validAge=inputs.age!==''&&Number.isFinite(Number(inputs.age))&&Number(inputs.age)>=18&&Number(inputs.age)<=120;
  const supported=!!model?.specimens.includes(inputs.specimen);
  const valid=validAge&&supported&&!!model&&!loadingPatient;
  const status=!validAge?'The model supports adults aged 18–120.':model&&!supported?'Wound samples are unsupported by the supplied model. Choose a supported specimen for a manual scenario.':'';
  function update(patch:Partial<Inputs>){setInputs(current=>({...current,...patch}));if(loaded)setEdited(true);}
  function updateHistory(history:Inputs['history']){update({history});}
  useEffect(()=>{
    if(!explanation)return;
    explanationAnchor.current?.scrollIntoView({behavior:reducedMotion?'auto':'smooth',block:'start'});
    explanationAnchor.current?.focus({preventScroll:true});
  },[explanation,reducedMotion]);
  useEffect(()=>{
    const version=++predictVersion.current;
    explainVersion.current++;setExplanation(null);setExplainBusy(false);setError('');
    if(!valid){setBusy(false);setResult(null);return;}
    const controller=new AbortController();setBusy(true);
    const timer=setTimeout(async()=>{
      try {
        const body={...inputs,age:Number(inputs.age)};
        const output=await api('/predictor/predict',{method:'POST',body:JSON.stringify(body),signal:controller.signal});
        if(version!==predictVersion.current)return;
        const key=inputs.specimen+'|'+inputs.organism,rows=Object.fromEntries((output.resistance?.ranked||[]).map((r:Row)=>[r.antibiotic,r.percent_works]));
        setDeltas(previous.current.key===key?previous.current.rows:{});previous.current={key,rows};
        setResult({...output,inputs:body});
      } catch(e){if(version===predictVersion.current&&!controller.signal.aborted){setError((e as Error).message);setResult(null);}}
      finally{if(version===predictVersion.current)setBusy(false);}
    },250);
    return()=>{clearTimeout(timer);controller.abort();};
  },[inputs,model,loadingPatient,valid]);
  useEffect(()=>()=>{patientVersion.current++;explainVersion.current++;predictVersion.current++;},[]);
  async function loadPatient(id:string,cultureId?:string){
    const version=++patientVersion.current;setLoadingPatient(true);setPatientError('');setSearch('');
    try{const value=await api(`/predictor/patients/${encodeURIComponent(id)}${cultureId?'?'+new URLSearchParams({culture_id:cultureId}):''}`);if(version!==patientVersion.current)return;setLoaded(value);setInputs(value.inputs);setSelectedIsolate(value.isolates[0]?.isolate_id||'');setEdited(false);previous.current={key:'',rows:{}};}
    catch(e){if(version===patientVersion.current)setPatientError((e as Error).message);}
    finally{if(version===patientVersion.current)setLoadingPatient(false);}
  }
  function example(stage:number){
    patientVersion.current++;setLoadingPatient(false);setLoaded(null);setPatientError('');setSearch('');setEdited(false);setExplanation(null);previous.current={key:'',rows:{}};
    const next=fresh();next.organism='Escherichia coli';
    if(stage>=2)next.history={prior_results:[{antibiotic:'Ciprofloxacin',organism:'Escherichia coli',result:'R',days_ago:30}],prior_antibiotics:[{drug:'ciprofloxacin',days_ago:25}],nursing_home:false};
    if(stage>=3)next.known_results={Cefazolin:'R',Ceftriaxone:'R'};
    setInputs(next);
  }
  function reset(){patientVersion.current++;setLoadingPatient(false);setPatientError('');setLoaded(null);setSearch('');setEdited(false);previous.current={key:'',rows:{}};setInputs(fresh());}
  async function why(antibiotic:string){
    if(!result||busy)return;
    const version=++explainVersion.current;setExplainBusy(true);setExplanation(null);
    try{const out=await api('/predictor/explain',{method:'POST',body:JSON.stringify({...result.inputs,antibiotic})});if(version===explainVersion.current)setExplanation({...out,antibiotic});}
    catch(e){if(version===explainVersion.current)setExplanation({antibiotic,error:(e as Error).message});}
    finally{if(version===explainVersion.current)setExplainBusy(false);}
  }
  return <div className="predictor-page">
    <div className="predictor-heading"><h1><BrainCircuit size={23}/>AMR predictor</h1><span className="badge blue">Research model</span><div className="predictor-examples"><button className="button secondary" onClick={()=>example(1)} disabled={!model}>1 · Example patient</button><button className="button secondary" onClick={()=>example(2)} disabled={!model}>2 · Add history</button><button className="button secondary" onClick={()=>example(3)} disabled={!model}>3 · Lab results</button><button className="icon-button border" aria-label="Reset predictor" onClick={reset}><RefreshCw size={16}/></button></div></div>
    <div className="predictor-notice"><ShieldCheck size={17}/><p>Decision support for demonstration. Estimates are not prescriptions; this model is not locally validated and does not check allergies, renal function, dosing or treatment route.</p></div>
    {meta.error?<div className="error-box" role="alert">{meta.error.message}<button className="text-button" onClick={()=>meta.refetch()}>Retry model connection</button></div>:meta.isLoading?<div className="loading"><Loader2 className="spin" size={20}/>Loading trained model…</div>:null}
    <div className="predictor-layout"><div className="predictor-sidebar">
      <section className="panel predictor-card"><h2><UserRound size={17}/>Patient & sample</h2><div className="predictor-search"><Search size={15}/><input aria-label="Find patient for predictor" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Load patient ID or home area…"/>{search&&<button aria-label="Clear predictor search" onClick={()=>setSearch('')}><X size={13}/></button>}</div>
        {query.trim()&&<div className="predictor-search-results">{matches.isLoading?<p>Searching…</p>:matches.error?<p role="alert">{matches.error.message}</p>:!matches.data?.rows.length?<p>No matching patients.</p>:matches.data.rows.map((p:Row)=><button key={p.patient_id} aria-label={`Load patient ${p.patient_id}`} onClick={()=>loadPatient(p.patient_id)} disabled={loadingPatient}><strong>{p.patient_id}</strong><small>Born {p.birth_year} · {p.home_area}</small><ChevronRight size={14}/></button>)}</div>}
        {loadingPatient&&<p className="predictor-loading"><Loader2 className="spin" size={14}/>Loading source records…</p>}{patientError&&<div className="error-box" role="alert">{patientError}</div>}
        {loaded?<div className="predictor-loaded"><span><Check size={14}/><strong><CopyId value={loaded.patient.patient_id} label="patient ID"/></strong><small>{edited?'Source snapshot · edited inputs':'Loaded source snapshot'}</small></span><button className="icon-button" aria-label="Reload predictor patient records" disabled={loadingPatient} onClick={()=>loadPatient(loaded.patient.patient_id,loaded.sample_id||undefined)}><RefreshCw size={14}/></button></div>:<p className="predictor-hint">Manual scenario. Load a patient to use source records.</p>}
        {loaded&&<><Field label="Source sample"><select aria-label="Predictor source sample" value={loaded.sample_id||''} disabled={loadingPatient} onChange={e=>loadPatient(loaded.patient.patient_id,e.target.value)}>{loaded.cases.length?loaded.cases.map((c:Row)=><option key={c.culture_id} value={c.culture_id}>{c.sample_date} · {c.specimen} · {c.culture_id}</option>):<option value="">No recorded samples</option>}</select>{loaded.sample_id&&<CopyId value={loaded.sample_id} label="culture ID"/>}</Field>{loaded.isolates.length>1&&<Field label="Source isolate"><select aria-label="Predictor source isolate" value={selectedIsolate} onChange={e=>{const i=loaded.isolates.find((i:Row)=>i.isolate_id===e.target.value);setSelectedIsolate(i.isolate_id);update({organism:i.organism,known_results:i.known_results,flags:i.flags});}}>{loaded.isolates.map((i:Row)=><option key={i.isolate_id} value={i.isolate_id}>{i.source_organism}</option>)}</select></Field>}
          {loaded.isolates.some((i:Row)=>!i.organism)&&<p className="predictor-hint">A source organism is unsupported. Stage 1 remains available; selecting a different organism creates an edited scenario.</p>}</>}
        <div className="predictor-form-grid"><Field label="Specimen"><select aria-label="Predictor specimen" value={inputs.specimen} disabled={!model||loadingPatient} onChange={e=>update({specimen:e.target.value,known_results:{}})}>{[...model?.specimens||[],...(inputs.specimen==='wound'?['wound']:[])].map(s=><option key={s} value={s}>{s==='wound'?'Wound · unsupported':s[0].toUpperCase()+s.slice(1)}</option>)}</select></Field><Field label="Age"><input aria-label="Predictor age" type="number" min="18" max="120" value={inputs.age} onChange={e=>update({age:e.target.value===''?'':Number(e.target.value)})}/></Field></div>
        <Field label="Care setting"><select aria-label="Predictor setting" value={inputs.setting} disabled={!model} onChange={e=>update({setting:e.target.value})}>{model?.settings.map((s:string)=><option key={s} value={s}>{s==='icu'?'ICU':s[0].toUpperCase()+s.slice(1)}</option>)}</select></Field>
        {status&&<p className="predictor-invalid" role="alert"><Info size={15}/>{status}</p>}
      </section>
      {model&&<HistoryEditor history={inputs.history} model={model} onChange={updateHistory}/>}
      {loaded&&<details className="panel predictor-card predictor-source-notes"><summary>Source data coverage</summary><p>As of {loaded.as_of_date}.{loaded.age_is_approximate?' Age is approximate, calculated from birth year.':''}</p>{loaded.notes.map((note:string)=><p key={note}>{note}</p>)}{loaded.unmapped.length>0&&<p>Not mapped: {loaded.unmapped.join(', ')}.</p>}<p>Changes here are model inputs and do not modify source records.</p></details>}
    </div><div className="predictor-results" aria-busy={busy}>
      <div className="predictor-live-state" role="status">{busy?<><Loader2 size={14} className="spin"/>Updating model estimates…</>:result?<><span className="status-dot green-dot"/>Model estimates updated</>:<><FlaskConical size={15}/>Set patient inputs to run the model</>}</div>
      {error&&<div className="error-box" role="alert">{error}</div>}
      <section className={`panel predictor-card ${busy?'predictor-updating':''}`}><div className="predictor-stage-heading"><span>1</span><div><h2>Sample taken</h2><p>Likely organisms and estimated antibiotic coverage before identification.</p></div></div>
        {result?<div className="predictor-empiric"><div><h3>Likely organism</h3><div className="predictor-organisms">{result.empiric.likely_organisms.slice(0,5).map((o:Row)=><div key={o.organism}><em>{o.organism}</em><Meter value={o.percent}/><strong>{o.percent.toFixed(1)}%</strong></div>)}</div></div><div><Shortlist title="Top 3 by coverage" rows={result.empiric.top}/><Shortlist title="Model recommended" rows={result.empiric.recommended}/></div><p className="predictor-hint predictor-other">Other organisms: {result.empiric.percent_other_organism.toFixed(1)}%. Coverage is conditional on modelled organisms; the “Other” group is excluded.</p></div>:<p className="predictor-placeholder">{busy?'Running the supplied Python model…':'Estimates will appear when valid inputs are available.'}</p>}
      </section>
      <section className="panel predictor-card"><div className="predictor-stage-heading"><span>2–3</span><div><h2>Organism identified · results arriving</h2><p>Choose the organism, then mark lab results to update the pending estimates.</p></div></div>
        <Field label="Identified organism"><select aria-label="Predictor organism" value={inputs.organism} disabled={!model} onChange={e=>{previous.current={key:'',rows:{}};update({organism:e.target.value,known_results:{},flags:{}});}}><option value="">Not identified yet</option>{model?.organisms.map((o:string)=><option value={o} key={o}>{o}</option>)}</select></Field>
        <div className="predictor-flags">{flags.map(f=><label key={f}><input type="checkbox" checked={!!inputs.flags[f]} disabled={!inputs.organism} onChange={e=>update({flags:{...inputs.flags,[f]:e.target.checked}})}/>{f.toUpperCase()}</label>)}</div>
        {result?.resistance&&inputs.organism?<div className={busy?'predictor-updating':''}><div className="predictor-two-shortlists"><Shortlist title="Top 3 by estimate" rows={result.resistance.top}/><Shortlist title="Model recommended" rows={result.resistance.recommended}/></div>
          <p className="predictor-hint">The supplied recommendation rule prioritizes AWaRe groups at ≥80%, with a highest-ranked fallback when none qualify.</p>
          <div className="table-scroll"><table className="predictor-table"><thead><tr><th>Antibiotic</th><th>Estimated susceptibility</th><th>Lab input</th><th>Source</th><th></th></tr></thead><tbody>{result.resistance.ranked.map((r:Row)=>{
            const delta=deltas[r.antibiotic]===undefined?0:r.percent_works-deltas[r.antibiotic];
            return <tr key={r.antibiotic}><td><strong>{r.antibiotic}</strong><Aware value={r.aware}/></td><td>{r.source==='lab'?<span className={`badge ${r.p_resistant===1?'rose':'green'}`}>{r.p_resistant===1?'R · Resistant':'S · Susceptible'}</span>:<div className="predictor-probability"><Meter value={r.percent_works}/><strong>{r.percent_works.toFixed(1)}%</strong></div>}{Math.abs(delta)>=1&&<small className={`predictor-delta ${delta<0?'fall':'rise'}`}>{delta>0?'+':''}{delta.toFixed(1)} percentage points</small>}</td><td><div className="predictor-lab-segment" role="group" aria-label={`Lab input for ${r.antibiotic}`}>{['P','S','R'].map(v=><button type="button" key={v} aria-pressed={(inputs.known_results[r.antibiotic]||'P')===v} className={(inputs.known_results[r.antibiotic]||'P')===v?`selected ${v}`:''} disabled={busy} onClick={()=>{const known={...inputs.known_results};if(v==='P')delete known[r.antibiotic];else known[r.antibiotic]=v;update({known_results:known});}}>{v==='P'?'Pending':v}</button>)}</div></td><td><span className={`predictor-evidence ${r.source}`}>{evidence[r.source]||r.source}</span></td><td><button className="text-button" aria-label={`Explain ${r.antibiotic}`} aria-controls="predictor-explanation" disabled={busy} onClick={()=>why(r.antibiotic)}>Why?</button></td></tr>;
          })}</tbody></table></div><p className="predictor-hint predictor-table-note">Lab = an entered or imported result. Model, intrinsic resistance and flag rules come from the supplied predictor. Edits here do not save laboratory records.</p>
        </div>:<p className="predictor-placeholder">{inputs.organism&&busy?'Updating organism-specific predictions…':'Select an organism to see antibiotic predictions.'}</p>}
      </section>
      <div id="predictor-explanation" className="predictor-explanation-anchor" ref={explanationAnchor} tabIndex={-1} role="region" aria-label="Model explanation" hidden={!explainBusy&&!explanation}>
      {explainBusy&&<div className="panel predictor-card predictor-loading"><Loader2 size={16} className="spin"/>Loading model explanation…</div>}
      {explanation&&<Explanation value={explanation} onClose={()=>{explainVersion.current++;setExplanation(null);}}/>}
      </div>
      {result&&<details className="panel predictor-card predictor-raw"><summary>Exact model inputs & output</summary><p>Model SHA-256: <code>{result.model_id}</code></p><pre>{JSON.stringify({inputs:result.inputs,empiric:result.empiric,resistance:result.resistance},null,2)}</pre></details>}
    </div></div>
    {model&&<div className="predictor-model-caption"><BrainCircuit size={14}/><span>Supplied model · {num(model.training.n_isolates)} training isolates · {model.training.trained_on} · Stanford ARMD</span></div>}
  </div>;
}

function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="predictor-field"><span>{label}</span>{children}</label>;}
function Meter({value}:{value:number}){const reduce=useReducedMotion();return <span className={`predictor-meter ${tone(value)}`}><motion.i initial={false} animate={{width:`${Math.max(0,Math.min(value,100))}%`}} transition={{duration:reduce?0:.35}}/></span>;}
function Aware({value}:{value:string}){return <span className={`predictor-aware ${String(value).toLowerCase()}`}>{value||'Unclassified'}</span>;}
function Shortlist({title,rows}:{title:string;rows:Row[]}){return <div className="predictor-shortlist"><h3>{title}</h3><div>{rows.map(r=><span className="predictor-chip" key={r.antibiotic}><span>{r.antibiotic}</span><strong>{r.source==='lab'?(r.p_resistant===1?'Lab R':'Lab S'):`${percent(r).toFixed(1)}%`}</strong><Aware value={r.aware}/></span>)}</div></div>;}

function HistoryEditor({history,model,onChange}:{history:Inputs['history'];model:Row;onChange:(history:Inputs['history'])=>void}){
  const [antibiotic,setAntibiotic]=useState('Ciprofloxacin'),[organism,setOrganism]=useState('Escherichia coli'),[result,setResult]=useState('R'),[days,setDays]=useState(30),[drug,setDrug]=useState('ciprofloxacin'),[drugDays,setDrugDays]=useState(25);
  function remove(key:'prior_results'|'prior_antibiotics',index:number){onChange({...history,[key]:history[key].filter((_,i)=>i!==index)});}
  return <section className="panel predictor-card"><h2>Patient history</h2><p className="predictor-hint">Earlier S and R results, plus medication exposure when known.</p>
    <h3>Earlier lab results</h3><ul className="predictor-history-list">{history.prior_results.map((r,i)=><li key={i}><span>{r.antibiotic} <b className={r.result==='R'?'resistant':'susceptible'}>{r.result}</b><small>{r.organism} · {r.days_ago} days ago</small></span><button aria-label={`Remove earlier result ${i+1}`} onClick={()=>remove('prior_results',i)}><X size={13}/></button></li>)}{!history.prior_results.length&&<li className="predictor-hint">No earlier results supplied</li>}</ul>
    <form className="predictor-history-form" onSubmit={e=>{e.preventDefault();onChange({...history,prior_results:[...history.prior_results,{antibiotic,organism,result,days_ago:days}]});}}><div className="predictor-form-grid"><select aria-label="Earlier result antibiotic" value={antibiotic} onChange={e=>setAntibiotic(e.target.value)}>{Object.keys(model.antibiotics).sort().map(a=><option key={a}>{a}</option>)}</select><select aria-label="Earlier result susceptibility" value={result} onChange={e=>setResult(e.target.value)}><option>R</option><option>S</option></select></div><select aria-label="Earlier result organism" value={organism} onChange={e=>setOrganism(e.target.value)}>{model.organisms.map((o:string)=><option key={o}>{o}</option>)}</select><div className="predictor-history-add"><label>Days ago<input aria-label="Earlier result days ago" type="number" min="1" max="100000" required value={days} onChange={e=>setDays(Number(e.target.value))}/></label><button className="button secondary"><Plus size={14}/>Add result</button></div></form>
    <h3>Antibiotics taken</h3><ul className="predictor-history-list">{history.prior_antibiotics.map((r,i)=><li key={i}><span>{r.drug}<small>{r.days_ago} days ago</small></span><button aria-label={`Remove prior medication ${i+1}`} onClick={()=>remove('prior_antibiotics',i)}><X size={13}/></button></li>)}{!history.prior_antibiotics.length&&<li className="predictor-hint">Medication exposure not supplied</li>}</ul>
    <form className="predictor-history-form" onSubmit={e=>{e.preventDefault();onChange({...history,prior_antibiotics:[...history.prior_antibiotics,{drug,days_ago:drugDays}]});}}><select aria-label="Prior medication" value={drug} onChange={e=>setDrug(e.target.value)}>{model.drugs.map((d:string)=><option key={d}>{d}</option>)}</select><div className="predictor-history-add"><label>Days ago<input aria-label="Prior medication days ago" type="number" min="1" max="100000" required value={drugDays} onChange={e=>setDrugDays(Number(e.target.value))}/></label><button className="button secondary"><Plus size={14}/>Add medication</button></div></form>
    <Field label="Nursing-home visit"><select aria-label="Nursing-home history" value={history.nursing_home===undefined?'unknown':history.nursing_home?'yes':'no'} onChange={e=>{const next={...history};if(e.target.value==='unknown')delete next.nursing_home;else next.nursing_home=e.target.value==='yes';onChange(next);}}><option value="unknown">Not supplied</option><option value="no">No</option><option value="yes">Yes</option></select></Field>
  </section>;
}

function friendly(feature:string){
  const windows:Record<string,string>={"30d":"in the last 30 days","90d":"in the last 90 days","365d":"in the last year",ever:'in earlier history'};
  const names:Record<string,string>={'ward=IP':'Inpatient ward','ward=OP':'Outpatient clinic','ward=ER':'Emergency encounter','ward=ICU':'ICU','nursing_home':'Nursing-home visit'};
  if(names[feature])return names[feature];let m;
  if((m=feature.match(/^spec=(.+)/)))return `${m[1]} specimen`;
  if((m=feature.match(/^age=(.+)/)))return `Age ${m[1]}`;
  if((m=feature.match(/^mode=(.+)/)))return `${m[1]} ordering context`;
  if((m=feature.match(/^([RS]):(.+)/)))return `Current ${m[2]} lab input: ${m[1]}`;
  if((m=feature.match(/^prev([RS])same_(\w+):(.+)/)))return `Same organism: ${m[3]} ${m[1]}, ${windows[m[2]]||m[2]}`;
  if((m=feature.match(/^prevR_(\w+):(.+)/)))return `${m[2]} resistance ${windows[m[1]]||m[1]}`;
  if((m=feature.match(/^(cls|drug)_(\w+):(.+)/)))return `${m[3]} exposure ${windows[m[2]]||m[2]}`;
  if((m=feature.match(/^prevOrg_(\w+):(.+)/)))return `Earlier ${m[2]} ${windows[m[1]]||m[1]}`;
  if((m=feature.match(/^flag:(.+)/)))return `${m[1].toUpperCase()} lab flag`;
  return feature;
}
function Explanation({value,onClose}:{value:Row;onClose:()=>void}){
  const maximum=Math.max(1,...(value.contributions||[]).map((c:[string,number])=>Math.abs(c[1])));
  return <section className="panel predictor-card predictor-explanation"><div className="predictor-explanation-title"><h2>Why? {value.antibiotic}</h2><button className="icon-button" aria-label="Close predictor explanation" onClick={onClose}><X size={16}/></button></div>{value.error?<p role="alert">{value.error}</p>:value.kind!=='logistic'?<p>{value.text}</p>:<><p className="predictor-hint">Learned contributions to the resistance score. Positive points increase estimated resistance; the combined score determines the percentage.</p><div className="predictor-contribution"><strong>Starting score · {value.start_percent_resistant}% resistant</strong><span/><strong>{value.intercept.toFixed(2)}</strong></div>{value.contributions.map(([feature,weight]:[string,number])=><div className="predictor-contribution" key={feature}><span>{friendly(feature)}</span><span className="predictor-contribution-track"><i/><b className={weight>=0?'positive':'negative'} style={{left:`${weight>=0?50:50-50*Math.abs(weight)/maximum}%`,width:`${50*Math.abs(weight)/maximum}%`}}/></span><strong className={weight>=0?'resistant':'susceptible'}>{weight>=0?'+':''}{weight.toFixed(2)}</strong></div>)}<div className="predictor-contribution predictor-total"><strong>Combined score</strong><span>{value.percent_works.toFixed(1)}% estimated susceptibility</span><strong>{value.total.toFixed(2)}</strong></div><p className="predictor-hint">{num(value.n_train)} training results · {num(value.n_weights)} learned weights. Overlapping features share their effects; individual signs should be read together.</p></>}</section>;
}
