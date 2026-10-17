import { t,useLocale,locale } from '../i18n';
import { Children,createContext,isValidElement,useContext,useEffect,useMemo,useRef,useState,type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence,motion } from 'motion/react';
import { ArrowUp,ArrowUpRight,Bot,BrainCircuit,Building2,Check,ChevronDown,ClipboardList,Database,FlaskConical,Loader2,Maximize2,MessageCircle,Microscope,Minus,Plus,RefreshCw,Search,ShieldCheck,Sparkles,Square,Users,X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api,num,streamAssistant,type Row } from '../api';
import CopyId from './ui/CopyId';
import { useChatScroll } from './ui/useChatScroll';

type Mode='patient'|'culture'|'ward'|'general';
type Message={id:string;role:'user'|'assistant';content:string;context?:Row;error?:string;stopped?:boolean;model?:string};
const choices=[
  {mode:'patient' as const,label:'Patient ID',hint:'Sample history & resistance profile',icon:Users,placeholder:'e.g. 1018112'},
  {mode:'culture' as const,label:'Culture ID',hint:'Organisms, S/R & pending tests',icon:FlaskConical,placeholder:'e.g. MB26101811501'},
  {mode:'ward' as const,label:'Ward code',hint:'Local isolates & susceptibility',icon:Building2,placeholder:'e.g. MED-02 or ICU'},
  {mode:'general' as const,label:'General question',hint:'Hospital & laboratory questions',icon:ClipboardList,placeholder:''}
];
const starterQuestions:Record<Mode,string[]>={patient:['Summarize this patient’s microbiology history.','Which results are still pending?'],culture:['Review organisms and reported S/R results.','Explain the AMR estimates for this culture.'],ward:['Which samples are awaiting results?','Summarize local resistance patterns.'],general:['How many cultures await final results?','Summarize the latest susceptibility data.']};
type State={messages:Message[];mode:Mode|null;identifier:string;setIdentifier:(s:string)=>void;input:string;setInput:(s:string)=>void;choose:(m:Mode)=>void;newChat:()=>void;send:(question?:string)=>Promise<void>;stop:()=>void;busy:boolean;phase:string;error:string;status?:Row;statusLoading:boolean;refresh:()=>void;model:string;setModel:(s:string)=>void};
const AssistantContext=createContext<State|null>(null);
function useAssistant(){const value=useContext(AssistantContext);if(!value)throw new Error('AssistantProvider is required');return value;}

export function AssistantProvider({children}:{children:ReactNode}) {
  const {language}=useLocale();
  const [messages,setMessages]=useState<Message[]>([]),[mode,setMode]=useState<Mode|null>(null),[identifier,setIdentifier]=useState(''),[input,setInput]=useState(''),[model,setModel]=useState('');
  const [busy,setBusy]=useState(false),[phase,setPhase]=useState(''),[error,setError]=useState('');
  const focus=useRef<Row>({}),controller=useRef<AbortController|null>(null);
  const status=useQuery({queryKey:['assistant-status'],queryFn:()=>api('/assistant/status'),staleTime:30000,refetchInterval:30000,retry:false});
  useEffect(()=>()=>controller.current?.abort(),[]);
  function stop(){controller.current?.abort();}
  function newChat(){stop();controller.current=null;setBusy(false);setPhase('');focus.current={};setMessages([]);setInput('');setIdentifier('');setMode(null);setError('');}
  function choose(value:Mode){if(busy)return;focus.current={};setMessages([]);setMode(value);setIdentifier('');setInput('');setError('');}
  async function send(question?:string){
    const text=(question??input).trim();if(!text||busy||controller.current)return;
    if(mode&&mode!=='general'&&!identifier.trim()){setError(t("Enter a {kind} first.",{kind:t(choices.find(c=>c.mode===mode)!.label).toLocaleLowerCase(locale())}));return;}
    const abort=new AbortController();controller.current=abort;
    const id=crypto.randomUUID(),user:Message={id:crypto.randomUUID(),role:'user',content:text};
    const previous=messages.filter(m=>!m.error&&!m.stopped&&m.content).slice(-8).map(({role,content})=>({role,content:content.slice(0,6000)}));
    setMessages(old=>[...old,user,{id,role:'assistant',content:''}]);setInput('');setError('');setBusy(true);setPhase('searching');
    const update=(body:Partial<Message>)=>setMessages(old=>old.map(m=>m.id===id?{...m,...body}:m));
    let content='';
    try {
      await streamAssistant({message:text,mode:mode||'general',identifier:identifier.trim()||undefined,focus:focus.current,history:previous,model:model||undefined,language},event=>{
        if(abort.signal.aborted||controller.current!==abort)return;
        if(event.type==='phase')setPhase(event.phase);
        if(event.type==='context'){
          focus.current=event.context.focus;update({context:event.context});
          const key=mode==='patient'?'patient_ids':mode==='culture'?'culture_ids':mode==='ward'?'ward_codes':null;
          if(key){const ids=event.context.focus[key]||[];if(ids.length===1)setIdentifier(ids[0]);else if(event.context.entities.length||event.context.missing.length){setMode('general');setIdentifier('');}}
        }
        if(event.type==='token'){content+=event.content;update({content});}
        if(event.type==='done')update({model:event.model});
        if(event.type==='error')update({error:event.error});
      },abort.signal);
    }catch(e){if(abort.signal.aborted)update({stopped:true});else update({error:(e as Error).message});}
    finally{if(controller.current===abort){controller.current=null;setBusy(false);setPhase('');}}
  }
  return <AssistantContext.Provider value={{messages,mode,identifier,setIdentifier,input,setInput,choose,newChat,send,stop,busy,phase,error,status:status.data,statusLoading:status.isLoading,refresh:()=>void status.refetch(),model,setModel}}>{children}</AssistantContext.Provider>;
}

function ContextDetails({data}:{data:Row}) {useLocale();
  const sources=data.sources||[],predictions=data.amr||[];
  return <details className="assistant-context"><summary><Database size={14}/><span>{sources.length?t("{count} linked clinical records",{count:sources.length}):t("Hospital sample summary")}{predictions.some((p:Row)=>p.status==='available')?t(" · AMR context included"):''}{data.clinical_guidance?t(" · TYKS reference"):''}</span><ChevronDown size={14}/></summary>
    <div className="assistant-context-body">
      <div className="assistant-source-tags">{sources.map((s:Row)=><span className={s.kind} key={`${s.kind}:${s.id}`}>{t(s.kind)} <b><CopyId value={s.id} label={s.kind==='ward'?t("ward code"):`${s.kind} ID`}/></b></span>)}</div>
      {data.missing?.map((s:Row)=><p className="assistant-context-warning" key={s.id}>{t("No matching record: ")}<b>{s.id}</b></p>)}
      {data.records?.patients?.map((p:Row)=><p key={p.record.patient_id}><b><CopyId value={p.record.patient_id} label={t("patient ID")}/></b> · {num(p.summary.samples)} {t(" samples · ")}{num(p.summary.tests)} {t(" reported antibiotic tests")}</p>)}
      {predictions.map((p:Row)=>{const row=p.resistance?.top?.[0]||p.empiric?.top?.[0];return <div className="assistant-model-context" key={`${p.culture_id}:${p.isolate_id||''}`}><span><BrainCircuit size={14}/><b>{t("AMR model · ")}<CopyId value={p.culture_id} label={t("culture ID")}/></b></span>{p.status==='available'?<><p>{p.inputs.organism||t("Organism not identified")} · {t(p.inputs.specimen)} {t(" · sample ")}{p.as_of_date}</p>{p.isolate_id&&<p>{t("Isolate: ")}<CopyId value={p.isolate_id} label={t("isolate ID")}/></p>}{row&&<p>{row.antibiotic}: {row.source==='lab'?t("reported laboratory result"):t("estimated {kind}",{kind:t(row.percent_works!==undefined?'susceptibility':'coverage')})} {row.source==='lab'?(row.percent_works===0?'R':'S'):`${row.percent_works??row.percent_covers}%`}</p>}<small>{t("Research estimate; requires clinical interpretation.")}</small></>:<p>{t(p.reason)}</p>}</div>})}
      {data.clinical_guidance&&<GuidelineDetails guidance={data.clinical_guidance}/>}
      {data.anomalies&&<details className="assistant-anomaly-context"><summary><ShieldCheck size={14}/>{t('Saved anomaly signals')} · {data.anomalies.alerts.length}</summary>{data.anomalies.alerts.length?data.anomalies.alerts.map((alert:Row)=><section key={alert.id}><strong>{t(alert.type==='resistance'?'Resistance increase':alert.type==='cluster'?'Resistant-organism cluster':'Data & integration')}</strong><p>{alert.organism||alert.source}{alert.ward_code&&<> · <CopyId value={alert.ward_code} label={t('ward code')}/></>}</p>{alert.evidence.current&&<p>{alert.evidence.current.positive}/{alert.evidence.current.total} · {alert.evidence.current.from} — {alert.evidence.current.to}</p>}<small>{t('Last evaluated')}: {new Date(alert.last_evaluated_at).toLocaleString(locale())} · {t(alert.status)}</small></section>):<p>{t('No relevant saved signals')}</p>}<small>{t('Surveillance signal, not a confirmed outbreak.')}</small></details>}
      <p className="assistant-context-time">{t("Retrieved ")}{new Date(data.retrieval.queried_at).toLocaleTimeString(locale(), {hour:'2-digit',minute:'2-digit',second:'2-digit'})} · {data.retrieval.duration_ms} {t(" ms")}</p>
      {data.synchronization?.map((s:Row)=><small className="assistant-sync" key={s.source}><span className={'status-dot '+(s.status==='connected'?'green-dot':'amber-dot')}/>{s.source.toUpperCase()} · {t(s.status)}{s.last_sync_at?t(" · synced {time}",{time:new Date(s.last_sync_at).toLocaleTimeString(locale())}):''}</small>)}
      {data.retrieval.context_truncated&&<p className="assistant-context-warning">{t("Context was shortened. Ask about one ID for more detail.")}</p>}
      <details className="assistant-json"><summary>{t("View retrieved data")}</summary><pre>{JSON.stringify(data,null,2)}</pre></details>
    </div>
  </details>;
}
function GuidelineDetails({guidance}:{guidance:Row}){useLocale();
  return <div className="assistant-guideline-context"><div className="assistant-guideline-heading"><ClipboardList size={16}/><strong>{t("TYKS clinical guidance")}</strong><time dateTime={guidance.source.edition_date}>{guidance.source.edition_date}</time></div><p>{t("English summary · adult scope")}</p><details><summary>{t("Read the English guidance")}</summary>{guidance.sections.map((section:Row)=><section key={section.id}><h4>{section.title}</h4><ul>{section.facts.map((fact:string,index:number)=><li key={index}>{fact}</li>)}</ul><a href={section.citation_url} target="_blank" rel="noreferrer">{t("Finnish source · ")}{section.pages.length===1?'page':'pages'} {section.pages.join(', ')}<ArrowUpRight size={12}/></a></section>)}</details><a className="assistant-guideline-source" href={guidance.source.source_url} target="_blank" rel="noreferrer">{t("Open Finnish guideline")}<ArrowUpRight size={13}/></a><small>{t("Selected English summary; verify against the Finnish source. Full dosing tables are not included.")}</small></div>;
}
function IdentifiedAnswer({text,context}:{text:string;context?:Row}){useLocale();
  const components=useMemo(()=>{
    const identifiers=new Map<string,{value:string;label:string}>();
    function add(value:string,label:string){if(value)identifiers.set(value.toLowerCase(),{value,label});}
    function walk(value:unknown){
      if(Array.isArray(value)){value.forEach(walk);return;}
      if(!value||typeof value!=='object')return;
      for(const [key,item]of Object.entries(value)){
        const labels:Record<string,string>={patient_id:t("patient ID"),culture_id:t("culture ID"),isolate_id:t("isolate ID"),ward_code:t("ward code")};
        if(labels[key]&&typeof item==='string')add(item,labels[key]);else if(typeof item==='object')walk(item);
      }
    }
    walk(context);for(const source of context?.sources||[])add(source.id,source.kind==='ward'?t("ward code"):`${source.kind} ID`);
    const keys=[...identifiers.keys()].sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    const pattern=keys.length?new RegExp('(?<![A-Za-z0-9_-])('+keys.join('|')+')(?![A-Za-z0-9_-])','gi'):null;
    const inline=(children:ReactNode)=>Children.map(children,child=>typeof child==='string'&&pattern?child.split(pattern).map((part,index)=>{const id=identifiers.get(part.toLowerCase());return id?<CopyId key={index} value={id.value} label={id.label}>{part}</CopyId>:part;}):child);
    const plain=(children:ReactNode):string=>Children.toArray(children).map(child=>typeof child==='string'||typeof child==='number'?String(child):isValidElement<{children?:ReactNode}>(child)?plain(child.props.children):'').join('');
    return {p:({children}:{children?:ReactNode})=><p>{inline(children)}</p>,strong:({children}:{children?:ReactNode})=><strong>{inline(children)}</strong>,li:({children}:{children?:ReactNode})=><li>{inline(children)}</li>,td:({children}:{children?:ReactNode})=><td>{inline(children)}</td>,code:({children}:{children?:ReactNode})=><code>{plain(children).includes('\n')?children:inline(children)}</code>,a:({children,href}:{children?:ReactNode;href?:string})=><a href={href} target={href?.startsWith('/api/assistant/guidelines/')?'_blank':undefined} rel="noreferrer">{plain(children)}</a>};
  },[context]);
  return <Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown>;
}
function Connection(){useLocale();
  const {status,statusLoading,refresh,model}=useAssistant(),ready=status?.models?.includes(model||status?.selected);
  return <div className="assistant-connection"><span className={'status-dot '+(ready?'green-dot':'amber-dot')}/><span>{t(statusLoading?'Connecting…':ready?'Ready':'Assistant unavailable')}</span><button type="button" className="icon-button" aria-label={t("Refresh assistant connection")} onClick={refresh}><RefreshCw size={14}/></button></div>;
}
function Conversation({compact=false}:{compact?:boolean}) {useLocale();
  const chat=useAssistant(),textarea=useRef<HTMLTextAreaElement>(null);
  const selected=choices.find(c=>c.mode===chat.mode),last=chat.messages.at(-1),connected=chat.status?.models?.includes(chat.model||chat.status?.selected);
  const scrolling=useChatScroll(last?.id,last?.content,last?.context,last?.error,chat.busy);
  useEffect(()=>{if(compact)textarea.current?.focus({preventScroll:true});},[compact]);
  const phase=chat.phase==='predicting'?t("Checking source-based AMR estimates"):chat.phase==='generating'?t("Preparing the clinical summary"):t("Reading patient and laboratory records");
  return <div className={'assistant-conversation '+(compact?'compact':'')}>
    <div className="assistant-scroll" role="region" aria-label={t("Chat messages")} tabIndex={0} ref={scrolling.ref} {...scrolling.handlers}>
      {!chat.messages.length&&<div className="assistant-welcome"><h2 className="assistant-simple-welcome">{t("Ask me anything about the ARM")}</h2>
        <div className="assistant-choices" role="group" aria-label={t("Choose question context")}>{choices.map((c,index)=><button type="button" key={c.mode} data-context={c.mode} className={chat.mode===c.mode?'selected':''} aria-pressed={chat.mode===c.mode} onClick={()=>chat.choose(c.mode)}><span className="assistant-choice-icon"><c.icon size={20}/></span><span><b>{t(c.label)}</b><small>{t(c.hint)}</small></span>{chat.mode===c.mode?<Check size={16}/>:<span className="assistant-choice-number" aria-hidden="true">0{index+1}</span>}</button>)}</div>
        {chat.mode&&<div className="assistant-suggestions">{starterQuestions[chat.mode].map(q=><button key={q} onClick={()=>{if(chat.mode==='general'||chat.identifier.trim())void chat.send(t(q));else chat.setInput(t(q));}}><ArrowUpRight size={13}/>{t(q)}</button>)}</div>}
      </div>}
      {chat.messages.length>0&&<div className="assistant-messages" role="log" aria-label={t("Assistant conversation")}>{chat.messages.map((m,i)=><article className={'assistant-message '+m.role} key={m.id}><div className="assistant-message-label">{m.role==='assistant'?<><Microscope size={15}/>{t("AMR clinical assistant")}</>:<>{t("You")}</>}</div><div className="assistant-message-content">{m.role==='user'?<p>{m.content}</p>:<>{m.context&&<ContextDetails data={m.context}/>}<div className="assistant-markdown"><IdentifiedAnswer text={m.content} context={m.context}/></div>{chat.busy&&i===chat.messages.length-1&&<div className="assistant-working" role="status"><Loader2 size={14} className="spin"/>{t(phase)}</div>}{m.stopped&&<small className="assistant-stopped">{t("Response stopped")}{m.content?t(" · answer may be incomplete"):''}.</small>}{m.error&&<div className="assistant-response-error" role="alert"><p>{m.error}</p><button className="button small" onClick={()=>{chat.refresh();void chat.send(chat.messages[i-1]?.content);}} disabled={chat.busy}><RefreshCw size={13}/>{t("Retry question")}</button></div>}</>}</div></article>)}</div>}
    </div>
    {scrolling.showLatest&&last&&<div className="assistant-scroll-controls"><button className="button small" type="button" aria-label={t("Jump to latest response")} onClick={scrolling.latest}><ChevronDown size={15}/>{t("Latest response")}</button></div>}
    <div className="assistant-compose-area">
      {!connected&&!chat.statusLoading&&<div className="assistant-offline-note"><Bot size={16}/><span>{t('The assistant is unavailable. Check the connection and try again.')}</span></div>}
      {selected&&chat.mode!=='general'&&<div className="assistant-scope"><label htmlFor={compact?'dock-context-id':'page-context-id'}><selected.icon size={15}/>{t(selected.label)}</label><input id={compact?'dock-context-id':'page-context-id'} aria-label={t(selected.label)} placeholder={t(selected.placeholder)} value={chat.identifier} maxLength={150} disabled={chat.busy} onChange={e=>chat.setIdentifier(e.target.value)}/>{chat.messages.length>0&&<button title={t("Start with another context")} aria-label={t("Clear conversation context")} disabled={chat.busy} onClick={chat.newChat}><X size={14}/></button>}</div>}
      {chat.error&&<p className="assistant-field-error" role="alert">{chat.error}</p>}
      <form className="assistant-composer" onSubmit={e=>{e.preventDefault();void chat.send();}}><textarea ref={textarea} aria-label={t("Message the assistant")} placeholder={chat.mode==='ward'?t("Check pending cultures or local resistance…"):chat.mode==='culture'?t("Ask about organisms, S/R or AMR estimates…"):chat.mode==='patient'?t("Ask about this patient’s microbiology results…"):t("Enter a record ID or a clinical data question…")} rows={2} value={chat.input} maxLength={4000} onChange={e=>chat.setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void chat.send();}}}/><div className="assistant-composer-actions"><span><Database size={13}/>{t("Patients · Microbiology · Formulary")}</span>{chat.busy?<button type="button" className="assistant-send stop" aria-label={t("Stop response")} onClick={chat.stop}><Square size={15}/></button>:<button type="submit" className="assistant-send" aria-label={t("Send message")} disabled={!chat.input.trim()}><ArrowUp size={19}/></button>}</div></form>
      <p className="assistant-footnote"><ShieldCheck size={12}/>{t("Source facts and model estimates. Clinical review required.")}</p>
    </div>
  </div>;
}

export function AssistantPage(){useLocale();
  const chat=useAssistant();
  return <section className="assistant-workspace" aria-label={t("AI assistant")}><header className="assistant-page-header"><div><span className="assistant-title-icon"><Microscope size={21}/></span><div className="assistant-page-heading"><h1>{t("Clinical assistant")}</h1><p>{t("Microbiology & antimicrobial resistance")}</p></div></div><div><Connection/><button className="button" onClick={chat.newChat}><Plus size={16}/>{t("New review")}</button></div></header><Conversation/></section>;
}
export function AssistantDock({isAssistantPage,onExpand}:{isAssistantPage:boolean;onExpand:()=>void}) {useLocale();
  const [open,setOpen]=useState(false),chat=useAssistant(),launcher=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(isAssistantPage)setOpen(false);},[isAssistantPage]);
  const close=()=>{setOpen(false);launcher.current?.focus();};
  if(isAssistantPage)return null;
  return <div className="assistant-dock"><AnimatePresence>{open&&<motion.section className="assistant-popup" role="dialog" aria-label={t("Quick AI assistant")} initial={{opacity:0,y:16,scale:.97}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:10,scale:.97}} transition={{duration:.18}} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}}}><header className="assistant-popup-header"><span><Microscope size={19}/><span><b>{t("AMR clinical assistant")}</b><small>{t("Patient · Culture · Ward")}</small></span></span><div><button className="icon-button" aria-label={t("New assistant chat")} onClick={chat.newChat}><Plus size={17}/></button><button className="icon-button" aria-label={t("Open assistant full page")} onClick={()=>{setOpen(false);onExpand();}}><Maximize2 size={15}/></button><button className="icon-button" aria-label={t("Minimize assistant")} onClick={close}><Minus size={18}/></button></div></header><div className="assistant-popup-connection"><Connection/><span>{t("Microbiology")}</span></div><Conversation compact/></motion.section>}</AnimatePresence><motion.button ref={launcher} className={'assistant-launcher '+(open?'is-open':'')} aria-label={open?t("Close quick assistant"):t("Open quick assistant")} aria-expanded={open} whileTap={{scale:.94}} onClick={()=>open?close():setOpen(true)}>{open?<ChevronDown size={23}/>:<><Microscope size={23}/><span>{t("AMR assistant")}</span>{chat.busy&&<i/>}</>}</motion.button></div>;
}
