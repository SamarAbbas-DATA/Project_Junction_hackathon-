import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { Predictor,registerPredictor,patientInputs,mappedDrug } from '../src/predictor.js';
import { root } from '../src/config.js';
import type { Row } from '../src/source-store.js';

const runFile=promisify(execFile),python=process.env.PYTHON_BIN||(process.platform==='win32'?'python':'python3');
const ECOLI='Escherichia coli';
const base={specimen:'urine',setting:'emergency',age:78};
const history={patient:{patient_id:'PMODEL',birth_year:1948,sex:'F',home_area:'North'},cultures:[
  {culture_id:'CURRENT',sample_date:'2026-10-17',specimen:'urine',age_years:78,ward_code:'ED',ward_type:'out',status:'preliminary',isolates:[{isolate_id:'ICURRENT',organism:ECOLI,mrsa:0,esbl:1,vre:0,cpe:1,ast_results:[{antibiotic_code:'CIP',antibiotic:'ciprofloxacin',result:'R'},{antibiotic_code:'TMP',antibiotic:'trimethoprim',result:'R'}]}]},
  {culture_id:'EARLIER',sample_date:'2026-09-17',specimen:'urine',status:'final',isolates:[{organism:ECOLI,ast_results:[{antibiotic_code:'CIP',antibiotic:'ciprofloxacin',result:'R'},{antibiotic_code:'AMP',antibiotic:'ampicillin',result:'S'},{antibiotic_code:'FOX',antibiotic:'cefoxitin (screen)',result:'R'}]}]},
  {culture_id:'RECENT',sample_date:'2026-10-16',specimen:'urine',status:'final',isolates:[{organism:ECOLI,ast_results:[{antibiotic_code:'CRO',antibiotic:'ceftriaxone',result:'S'}]}]},
  {culture_id:'FUTURE',sample_date:'2026-10-20',specimen:'urine',status:'final',isolates:[{organism:ECOLI,ast_results:[{antibiotic_code:'CRO',antibiotic:'ceftriaxone',result:'R'}]}]}
]};

test('dashboard predictor uses the supplied trained Python code',async t=>{
  const model=new Predictor(),app=Fastify();
  registerPredictor(app,{patientHistory:async(id:string)=>id==='PMODEL'?history:null} as any,model);
  try{
    const metaResponse=await app.inject({method:'GET',url:'/api/predictor/meta'});assert.equal(metaResponse.statusCode,200);
    const meta=metaResponse.json();
    await t.test('model files match the archive manifest and no training is needed',()=>{
      const manifest=JSON.parse(fs.readFileSync(path.join(root,'AMR/model/source-manifest.json'),'utf8'));
      for(const [name,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'AMR/model',name))).digest('hex'),hash);
      assert.equal(meta.model_id,manifest.files['amr_model.json']);assert.equal(meta.training.n_isolates,130051);
      assert.equal(fs.existsSync(path.join(root,'AMR/model/prepare_data.py')),false);assert.equal(fs.existsSync(path.join(root,'AMR/model/train.ipynb')),false);
    });
    await t.test('empiric and partial-result API outputs exactly match the original model CLI',async()=>{
      const basic=await app.inject({method:'POST',url:'/api/predictor/predict',payload:base});assert.equal(basic.statusCode,200);assert.equal(basic.json().resistance,null);
      const {stdout:empiric}=await runFile(python,['-S',path.join(root,'AMR/model/amr_predict.py'),'--specimen','urine','--setting','emergency','--age','78','--json'],{windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
      assert.deepEqual(basic.json().empiric,JSON.parse(empiric));
      const partial={...base,organism:ECOLI,known_results:{Cefazolin:'R',Ceftriaxone:'R'}};
      const response=await app.inject({method:'POST',url:'/api/predictor/predict',payload:partial});assert.equal(response.statusCode,200);
      const {stdout}=await runFile(python,['-S',path.join(root,'AMR/model/amr_predict.py'),'--organism',ECOLI,'--specimen','urine','--setting','emergency','--age','78','--known','Cefazolin=R','Ceftriaxone=R','--json'],{windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
      assert.deepEqual(response.json().resistance,JSON.parse(stdout));
    });
    await t.test('patient history preserves S/R, excludes future/recent results and never invents prescriptions',async()=>{
      const response=await app.inject({method:'GET',url:'/api/predictor/patients/PMODEL?culture_id=CURRENT'});assert.equal(response.statusCode,200);
      const context=response.json();assert.equal(context.inputs.setting,'emergency');assert.equal(context.inputs.age,78);
      assert.deepEqual(context.inputs.history.prior_results.map((r:Row)=>r.result),['R','S']);
      assert.deepEqual(context.inputs.history.prior_antibiotics,[]);assert.equal(context.inputs.history.nursing_home,undefined);
      assert.deepEqual(context.inputs.flags,{esbl:true});assert.deepEqual(context.inputs.known_results,{Ciprofloxacin:'R'});
      assert.equal(mappedDrug({antibiotic_code:'TMP',antibiotic:'trimethoprim'},meta),undefined);
      assert.equal(mappedDrug({antibiotic_code:'FOX',antibiotic:'cefoxitin (screen)'},meta),undefined);
      assert.equal(mappedDrug({antibiotic_code:'DEMO-AB',antibiotic:'Synthetic demo antibiotic'},meta),undefined);
      assert.throws(()=>patientInputs(history,meta,'NOT-THIS-PATIENT'),/does not belong/);
      assert.equal((await app.inject({method:'GET',url:'/api/predictor/patients/MISSING'})).statusCode,404);
    });
    await t.test('history changes predictions and the supplied explanation agrees with the prediction',async()=>{
      const inputs={...base,organism:ECOLI,history:{prior_results:[{antibiotic:'Ciprofloxacin',organism:ECOLI,result:'R',days_ago:30}],prior_antibiotics:[{drug:'ciprofloxacin',days_ago:25}]}};
      const before=(await app.inject({method:'POST',url:'/api/predictor/predict',payload:{...base,organism:ECOLI}})).json().resistance.ranked.find((r:Row)=>r.antibiotic==='Ciprofloxacin');
      const after=(await app.inject({method:'POST',url:'/api/predictor/predict',payload:inputs})).json().resistance.ranked.find((r:Row)=>r.antibiotic==='Ciprofloxacin');
      assert.ok(after.percent_works<before.percent_works);
      const why=(await app.inject({method:'POST',url:'/api/predictor/explain',payload:{...inputs,antibiotic:'Ciprofloxacin'}})).json();
      assert.equal(why.kind,'logistic');assert.equal(why.percent_works,after.percent_works);assert.ok(why.contributions.length>0);
      const lab=(await app.inject({method:'POST',url:'/api/predictor/explain',payload:{...inputs,antibiotic:'Ciprofloxacin',known_results:{Ciprofloxacin:'S'}}})).json();assert.equal(lab.kind,'lab');
    });
    await t.test('unsupported ages, specimens, organisms and non-modelled combinations are rejected',async()=>{
      for(const payload of [{...base,age:17},{...base,specimen:'wound'},{...base,organism:'Unknown organism'},{...base,organism:ECOLI,known_results:{trimethoprim:'R'}},{...base,specimen:'blood',organism:ECOLI,known_results:{Nitrofurantoin:'S'}}])assert.ok((await app.inject({method:'POST',url:'/api/predictor/predict',payload})).statusCode>=400);
      const unavailable=new Predictor('missing-amr-python-executable');await assert.rejects(()=>unavailable.metadata(),/Python predictor could not run/);
    });
  }finally{await app.close();}
});
