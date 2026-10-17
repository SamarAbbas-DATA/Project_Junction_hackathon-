import { readFileSync,createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Row } from './source-store.js';

type Section={id:string;title:string;pages:number[];core?:boolean;keywords:string[];specimens?:string[];organisms?:string[];facts:string[]};
type Guide={source:Row;scope:Row;sections:Section[]};
export const tyksSourcePath=fileURLToPath(new URL('../resources/guidelines/tyks-antimicrobial-2026-04-13.fi.pdf',import.meta.url));
export const tyksGuide=JSON.parse(readFileSync(new URL('../resources/guidelines/tyks-2026-04-13.en.json',import.meta.url),'utf8')) as Guide;
const actualHash=createHash('sha256').update(readFileSync(tyksSourcePath)).digest('hex');
if(actualHash!==tyksGuide.source.sha256)throw new Error('TYKS guideline PDF changed: review its English reference and edition metadata before using it');
export const maxGuidelineContextChars=7600;

const normalized=(text:string)=>text.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[._-]+/g,' ').replace(/\s+/g,' ').trim();
const contains=(text:string,phrase:string)=>{
  const escaped=normalized(phrase).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:s)?(?:$|[^a-z0-9])`).test(text);
};
const publicSection=(s:Section)=>({id:s.id,title:s.title,pages:[...s.pages],facts:[...s.facts],citation_url:`${tyksGuide.source.source_url}#page=${s.pages[0]}`});

// Finnish question terms select the same reviewed reference sections. The
// underlying English context and exact Finnish PDF remain attributed separately.
const finnishTopics:Record<string,string[]>={
  'historical-susceptibility':['vuosiraport','vuositt','historialli','2021','antibiogrammi'],
  'gram-stain':['gramvarj','gram varj','gramposit','gramnegat','veriviljely'],
  'staphylococcus-blood':['stafylokok','aureus'],
  'contamination':['kontamina','kontaminant','ihofloora','katetri'],
  'enterobacterales-ampc':['ampc','enterobakteeri'],
  'multidrug-resistance':['moniresisten','esbl','mrsa','vre','cpe','karbapenemaasi'],
  'pseudomonas':['pseudomonas'],'enterococci':['enterokok'],
  'sepsis':['sepsis','septinen','septis','verenmyrkytys'],
  'neutropenic-fever':['neutropen','kuumeinen neutropenia'],
  'urinary-infection':['virtsa','kystiitti','pyelonefriitti','eturauhas','prostat','bakteriuria'],
  'chronic-wounds':['krooninen haava','krooniset haavat','haavaviljely'],
  'postoperative-wounds':['leikkaushaava','leikkausalue','postoperatii'],
  'necrotizing-infection':['nekrotisoi','faskiitti'],
  'respiratory-infection':['keuhkokuume','pneumonia','hengitystie','ysko','empyeema'],
  'enteric-infection':['ripuli','suolistoinfekt','salmonella','shigella','kampylo'],
  'sexually-transmitted-infections':['seksitauti','sukupuolitauti','tippuri','klamydia'],
  'endocarditis':['endokardiit','sydanlappa'],
  'joint-infection':['niveltulehdus','nivelinfektio','nivelneste'],
  'diabetic-foot':['diabeettinen jalka','diabeetikon jalka'],
  'bone-infection':['osteomyeliitti','luutulehdus','luubiopsia','spondylodiskiitti'],
  'central-nervous-system':['aivokalv','meningiitti','aivoabsessi'],
  'abdominal-infection':['vatsansisai','vatsaontelo','peritoniitti','pankreatiitti'],
  'treatment-duration':['hoidon kesto','hoitoaika','kuurin pituus'],
  'drug-monitoring':['laakepitoisuu','vankomysiini','munuaistoiminta'],
  'penicillin-allergy':['penisilliiniallerg','laakeallerg','allergia'],
  'yeast-in-blood':['kandidemia','hiiva veressa']
};

// Small, reviewed-in-code topic map. No embeddings, vector index, generated
// SQL, network retrieval, or LLM-selected documents are involved at runtime.
export function selectTyksGuidance(message:string,packet:Row={}){
  const question=normalized(message),cultures:Row[]=packet.records?.cultures||[];
  const specimens=new Set(cultures.map(c=>c.specimen)),isolates=cultures.flatMap(c=>c.isolates||[]);
  const organisms=normalized(isolates.map(i=>i.organism||'').join(' | '));
  const resistantFlag=isolates.some(i=>['esbl','mrsa','vre','cpe'].some(flag=>Number(i[flag])===1));
  const candidates=tyksGuide.sections.filter(s=>!s.core).map(section=>{
    const explicit=section.keywords.filter(k=>contains(question,k)).length+(finnishTopics[section.id]||[]).filter(k=>question.includes(k)).length;
    const organism=section.organisms?.some(o=>contains(organisms,o));
    const specimen=section.specimens?.some(s=>specimens.has(s));
    const flagged=section.id==='multidrug-resistance'&&resistantFlag;
    return {section,score:explicit*20+(organism?12:0)+(flagged?10:0)+(specimen?4:0),reason:explicit?'question topic':organism?'reported organism':flagged?'reported resistance flag':'recorded specimen type'};
  }).filter(s=>s.score>0).sort((a,b)=>b.score-a.score||a.section.id.localeCompare(b.section.id));
  const context={
    source:{...tyksGuide.source},scope:{...tyksGuide.scope},
    sections:tyksGuide.sections.filter(s=>s.core).map(publicSection),
    application_notes:[
      'Guideline recommendations, measured patient results and AMR model estimates are separate kinds of information. A specimen or organism match selects a reference topic; it does not establish a diagnosis.',
      'The current database accepts S/R results. The guide explains I, but no unreported I result or increased-exposure dose may be assigned to a patient.',
      ...(cultures.some(c=>Number.isFinite(c.age_years)&&c.age_years<18)?['A selected sample is from a patient under 18. Do not apply adult treatment recommendations to that pediatric sample.']:[]),
      'Allergies, current renal/hepatic function, pregnancy, symptoms, vital signs, actual medication use, MICs and drug levels are not supplied by these microbiology records. Ask for needed clinical details.'
    ],
    selection:{method:'Fixed English/Finnish topic matching plus known specimen/organism context; no embeddings or vector search',included_topics:[] as string[],omitted_matching_topics:0,available_topics:tyksGuide.sections.length}
  };
  for(const {section}of candidates){
    if(context.selection.included_topics.length>=3)break;
    const selected=publicSection(section);context.sections.push(selected);context.selection.included_topics.push(section.id);
    if(JSON.stringify(context).length>maxGuidelineContextChars){context.sections.pop();context.selection.included_topics.pop();}
  }
  context.selection.omitted_matching_topics=candidates.length-context.selection.included_topics.length;
  return context;
}

export function registerTyksGuidelines(app:FastifyInstance){
  app.get('/api/assistant/guidelines/tyks',async()=>tyksGuide);
  app.get('/api/assistant/guidelines/tyks/source.pdf',async(_request,reply)=>reply
    .header('content-type','application/pdf')
    .header('content-disposition','inline; filename="tyks-antimicrobial-2026-04-13.fi.pdf"')
    .header('etag',`"${actualHash}"`)
    .send(createReadStream(tyksSourcePath)));
}
