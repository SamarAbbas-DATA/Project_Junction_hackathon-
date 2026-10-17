import { beforeEach,describe,expect,it,vi } from 'vitest';
import { render,screen,waitFor,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import PredictorPage from '../src/components/PredictorPage';
import { api,type Row } from '../src/api';

vi.mock('../src/api',async()=>{const actual=await vi.importActual<typeof import('../src/api')>('../src/api');return {...actual,api:vi.fn()};});
const mocked=vi.mocked(api),organism='Escherichia coli';
const meta={organisms:[organism],specimens:['urine','blood','respiratory'],settings:['emergency','icu','inpatient','outpatient'],antibiotics:{Ciprofloxacin:{},Cefazolin:{},Ceftriaxone:{}},drugs:['ciprofloxacin'],training:{n_isolates:130051,trained_on:'2007–2024'}};
function row(antibiotic:string,body:Row){const result=body.known_results?.[antibiotic];return {antibiotic,aware:'Watch',percent_works:result==='R'?0:result==='S'?100:body.history?.prior_results.length?50:80,p_resistant:result==='R'?1:0,source:result?'lab':'model'};}
function mount(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PredictorPage/></QueryClientProvider>);}
beforeEach(()=>{mocked.mockReset();mocked.mockImplementation(async(path,options)=>{
  if(path==='/predictor/meta')return meta;
  if(path==='/predictor/predict'){
    const body=JSON.parse(String(options?.body));const rows=['Ciprofloxacin','Cefazolin','Ceftriaxone'].map(a=>row(a,body));
    return {model_id:'model-hash',empiric:{likely_organisms:[{organism,percent:57.3}],percent_other_organism:1.5,top:[{antibiotic:'Ciprofloxacin',percent_covers:73.8,aware:'Watch'}],recommended:[{antibiotic:'Ciprofloxacin',percent_covers:73.8,aware:'Watch'}]},resistance:body.organism?{ranked:rows,top:rows,recommended:rows}:null};
  }
  if(path==='/predictor/explain')return {kind:'lab',text:'The lab already reported this result.'};
  if(path.startsWith('/patients?'))return {rows:[{patient_id:'PTEST',birth_year:1980,home_area:'North'}]};
  if(path.startsWith('/predictor/patients/PTEST'))return {patient:{patient_id:'PTEST'},sample_id:'C1',as_of_date:'2026-10-17',cases:[{culture_id:'C1',sample_date:'2026-10-17',specimen:'urine'}],isolates:[{isolate_id:'I1',source_organism:organism,organism}],inputs:{age:46,specimen:'urine',setting:'emergency',organism,known_results:{Ciprofloxacin:'S'},flags:{},history:{prior_results:[],prior_organisms:[],prior_antibiotics:[]}},notes:['Medication exposure is unavailable.'],unmapped:['TMP']};
  throw new Error('Unexpected predictor request: '+path);
});});
describe('AMR predictor page',()=>{
  it('runs all demo scenarios with the archive input structure',async()=>{
    const user=userEvent.setup();mount();await screen.findByText('57.3%');
    await user.click(screen.getByRole('button',{name:'2 · Add history'}));
    await screen.findByRole('group',{name:'Lab input for Ciprofloxacin'});
    await waitFor(()=>expect(mocked.mock.calls.some(([p,o])=>p==='/predictor/predict'&&JSON.parse(String(o?.body)).history.prior_antibiotics.length===1)).toBe(true));
    await user.click(screen.getByRole('button',{name:'3 · Lab results'}));
    await waitFor(()=>expect(screen.getAllByText('R · Resistant').length).toBe(2));
    const calls=mocked.mock.calls.filter(([p])=>p==='/predictor/predict');const inputs=JSON.parse(String(calls.at(-1)?.[1]?.body));
    expect(inputs.known_results).toEqual({Cefazolin:'R',Ceftriaxone:'R'});expect(inputs.age).toBe(78);
    await user.click(screen.getByRole('button',{name:'Reset predictor'}));await screen.findByText('Select an organism to see antibiotic predictions.');
  });
  it('updates pending/S/R inputs and shows the supplied explanation',async()=>{
    const scroll=vi.spyOn(HTMLElement.prototype,'scrollIntoView');
    const user=userEvent.setup();mount();await screen.findByText('57.3%');
    await user.selectOptions(screen.getByRole('combobox',{name:'Predictor organism'}),organism);
    const group=await screen.findByRole('group',{name:'Lab input for Ciprofloxacin'});
    await user.click(within(group).getByRole('button',{name:'R',exact:true}));
    await screen.findByText('R · Resistant');
    await user.click(screen.getByRole('button',{name:'Explain Ciprofloxacin'}));
    await screen.findByText('The lab already reported this result.');
    await waitFor(()=>expect(scroll).toHaveBeenCalledWith({behavior:'auto',block:'start'}));
    expect(document.activeElement).toBe(screen.getByRole('region',{name:'Model explanation'}));
    await user.click(within(screen.getByRole('group',{name:'Lab input for Ciprofloxacin'})).getByRole('button',{name:'Pending'}));
    await waitFor(()=>expect(screen.queryByText('R · Resistant')).toBeNull());
    scroll.mockRestore();
  });
  it('loads source patient data and keeps missing prescription history unknown',async()=>{
    const user=userEvent.setup();mount();await screen.findByText('57.3%');
    await user.type(screen.getByRole('textbox',{name:'Find patient for predictor'}),'PTEST');
    await user.click(await screen.findByRole('button',{name:'Load patient PTEST'}));
    await screen.findByText('Loaded source snapshot');expect((screen.getByRole('spinbutton',{name:'Predictor age'}) as HTMLInputElement).value).toBe('46');
    expect((screen.getByRole('combobox',{name:'Nursing-home history'}) as HTMLSelectElement).value).toBe('unknown');
    expect(screen.getByText('Medication exposure not supplied')).toBeTruthy();await screen.findByText('S · Susceptible');
    expect(mocked.mock.calls.some(([path])=>path.startsWith('/source/'))).toBe(false);
  });
});
