import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { selectTyksGuidance,tyksGuide,maxGuidelineContextChars,registerTyksGuidelines } from '../src/tyks-guidelines.js';

test('English TYKS reference keeps source edition, scope, interpretation and page provenance',()=>{
  assert.equal(tyksGuide.source.edition_date,'2026-04-13');assert.equal(tyksGuide.source.page_count,69);assert.equal(tyksGuide.source.context_language,'English');
  assert.match(tyksGuide.source.translation_status,/not an official/);assert.match(tyksGuide.scope.historical_tables,/2021/);assert.match(tyksGuide.scope.historical_tables,/11\.0/);
  const ids=new Set<string>();for(const section of tyksGuide.sections){assert.ok(!ids.has(section.id));ids.add(section.id);assert.ok(section.pages.length&&section.pages.every(p=>Number.isInteger(p)&&p>=6&&p<=69));assert.ok(section.facts.every(f=>f.length>0));}
  const core=selectTyksGuidance('What do S, I and R mean?').sections.find(s=>s.id==='susceptibility');assert.ok(core);assert.ok(core.facts.some(f=>/I means susceptible with increased exposure/.test(f)));assert.ok(core.facts.some(f=>/must not be translated as resistant/.test(f)));
});

test('known sample and organism select relevant guidance without inventing a diagnosis or searching free-text patient fields',()=>{
  const urine=selectTyksGuidance('Summarize patient 1018112',{records:{patients:[{record:{home_area:'meningitis penicillin allergy'}}],cultures:[{specimen:'urine',age_years:35,isolates:[{organism:'Escherichia coli',esbl:1}]}]}});
  assert.ok(urine.sections.some(s=>s.id==='urinary-infection'));assert.ok(urine.sections.some(s=>s.id==='multidrug-resistance'));assert.ok(!urine.sections.some(s=>s.id==='central-nervous-system'||s.id==='penicillin-allergy'));
  assert.ok(urine.application_notes.some(n=>/does not establish a diagnosis/.test(n)));
  const blood=selectTyksGuidance('Explain this culture',{records:{cultures:[{specimen:'blood',age_years:40,isolates:[{organism:'Staphylococcus aureus'}]}]}});
  assert.ok(blood.sections.some(s=>s.id==='staphylococcus-blood'));assert.ok(blood.sections.some(s=>s.id==='gram-stain'));
  const child=selectTyksGuidance('Suggest treatment',{records:{cultures:[{specimen:'urine',age_years:4,isolates:[]}]}});assert.ok(child.application_notes.some(n=>/under 18/.test(n)));
  const explicit=selectTyksGuidance('Which tests are needed for endocarditis?');assert.ok(explicit.sections.some(s=>s.id==='endocarditis'));assert.ok(explicit.sections.find(s=>s.id==='endocarditis')?.citation_url.endsWith('#page=40'));
  const finnish=selectTyksGuidance('Mitä tutkimuksia tarvitaan endokardiitissa?');assert.ok(finnish.sections.some(s=>s.id==='endocarditis'));
  const urineFinnish=selectTyksGuidance('Miten virtsatieinfektio todetaan?');assert.ok(urineFinnish.sections.some(s=>s.id==='urinary-infection'));
});

test('topic selection stays bounded while keeping complete clinical facts and all core caveats',()=>{
  const text=tyksGuide.sections.flatMap(s=>s.keywords).join(' '),context=selectTyksGuidance(text,{records:{cultures:[{specimen:'blood',isolates:[{organism:'Staphylococcus aureus',mrsa:1}]}]}});
  assert.ok(JSON.stringify(context).length<=maxGuidelineContextChars);assert.ok(context.selection.included_topics.length<=3);assert.ok(context.selection.omitted_matching_topics>0);
  for(const id of ['before-antibiotics','reassessment','susceptibility'])assert.ok(context.sections.some(s=>s.id===id));
  for(const section of context.sections)assert.deepEqual(section.facts,tyksGuide.sections.find(s=>s.id===section.id)!.facts);
});

test('source routes serve the exact original Finnish PDF and the English reference independently of patient records',async()=>{
  const app=Fastify();registerTyksGuidelines(app);
  try{
    const english=await app.inject({method:'GET',url:'/api/assistant/guidelines/tyks'});assert.equal(english.statusCode,200);assert.equal(english.json().source.context_language,'English');
    const pdf=await app.inject({method:'GET',url:'/api/assistant/guidelines/tyks/source.pdf'});assert.equal(pdf.statusCode,200);assert.match(pdf.headers['content-type'] as string,/application\/pdf/);assert.equal(pdf.rawPayload.subarray(0,4).toString(),'%PDF');assert.equal(createHash('sha256').update(pdf.rawPayload).digest('hex'),tyksGuide.source.sha256);
    assert.equal((await app.inject({method:'POST',url:'/api/assistant/guidelines/tyks',payload:{source:'change'}})).statusCode,404);
  }finally{await app.close();}
});
