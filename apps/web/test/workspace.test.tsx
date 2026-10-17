import { beforeEach,describe,expect,it,vi } from 'vitest';
import { render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App';
import { api,type Row } from '../src/api';

vi.mock('../src/api',async()=>{const actual=await vi.importActual<typeof import('../src/api')>('../src/api');return {...actual,api:vi.fn()};});
// jsdom has no visual animation pipeline; exercise state changes without
// waiting on an exit animation's browser completion callback.
vi.mock('motion/react',async()=>{const actual=await vi.importActual<typeof import('motion/react')>('motion/react');return {...actual,AnimatePresence:({children}:{children:React.ReactNode})=>children};});
const mockedApi=vi.mocked(api);
const patients=[{patient_id:'P000001',sex:'F',birth_year:1990,home_area:'North',sample_count:1,isolate_count:1,latest_sample:'2026-09-27',pending_count:0,record_version:1},{patient_id:'P000002',sex:'M',birth_year:1980,home_area:'South',sample_count:0,isolate_count:0,latest_sample:null,pending_count:0,record_version:1}];
const tables=[{source:'adt',name:'patients',label:'Patients',keys:['patient_id'],fields:[{name:'patient_id',required:true},{name:'sex',required:true,values:['F','M']},{name:'birth_year',required:true,type:'integer'},{name:'home_area',required:true}],description:'Registered patients.'},{source:'lis',name:'cultures',label:'Cultures & samples',keys:['culture_id'],fields:[],description:'Cultures.'},{source:'formulary',name:'antibiotics',label:'Antibiotic catalogue',keys:['antibiotic_code'],fields:[],description:'Antibiotics.'}];
const overview={totals:{patients:2,wards:1,cultures:1,isolates:1,tests:1,pending:0,earliest_sample:'2026-09-27',latest_sample:'2026-09-27'},sources:['adt','lis','formulary'].map(source=>({source,status:'connected'})),weekly:[{week:'2026-09-21',patients:1,cultures:1,tests:1,positive:1}],wards:[{ward_code:'ED',ward_en:'Emergency department',ward_type:'out',cultures:1,positive:1}],specimens:[{specimen:'urine',count:1}],organisms:[{organism:'Escherichia coli',count:1}]};
beforeEach(()=>{
  mockedApi.mockReset();
  mockedApi.mockImplementation(async(path,options)=>{
    if(options?.method==='POST')return JSON.parse(String(options.body||'{}'));
    if(path==='/catalog')return {tables};
    if(path==='/overview')return overview;
    if(path==='/patients/P000001/history')return {patient:patients[0],summary:{samples:1,isolates:1,tests:1,pending:0},stays:[],cultures:[{culture_id:'C001',sample_date:'2026-09-27',ward_code:'ED',ward_en:'Emergency department',specimen:'urine',result:'positive',status:'final',isolates:[{isolate_id:'I001',organism:'Escherichia coli',esbl:0,mrsa:0,vre:0,cpe:0,ast_results:[{antibiotic_code:'AMP',antibiotic:'ampicillin',result:'S'}]}]}]};
    if(path.startsWith('/patients?'))return {rows:path.includes('has_samples=no')?[patients[1]]:patients,total:path.includes('has_samples=no')?1:2,summary:{total:2,with_samples:1,with_pending:0}};
    if(path.startsWith('/source/adt/patients'))return {rows:patients,total:2};
    if(path.startsWith('/source/'))return {rows:[],total:0};
    if(path==='/chat/models')return {models:[],available:true};
    if(path==='/assistant/status')return {models:['qwen3.5:4b'],available:true,ready:true,selected:'qwen3.5:4b'};
    if(path==='/predictor/meta')return {specimens:['urine'],settings:['emergency'],organisms:[],antibiotics:{},drugs:[],training:{n_isolates:130051,trained_on:'2007–2024'}};
    if(path.startsWith('/antibiogram?'))return {rows:[],from:'2026-09-01',to:'2026-09-27'};
    throw new Error('Unexpected test request: '+path);
  });
});
function workspace(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App/></QueryClientProvider>);}

describe('redesigned clinical workspace',()=>{
  it('separates source systems from the patient directory and removes Activity & health',async()=>{
    const user=userEvent.setup();workspace();await screen.findByText('Registered patients');
    expect(screen.queryByText('Activity & health')).toBeNull();
    await user.click(screen.getByRole('button',{name:'Source explorer'}));
    expect(screen.queryByRole('button',{name:'New record'})).toBeNull();
    await screen.findByRole('heading',{name:'People & places'});
    expect(screen.getByRole('heading',{name:'People & places'})).toBeTruthy();
    await user.click(screen.getByText('Patients',{selector:'.source-system-tables strong'}));
    await screen.findByRole('button',{name:'Add record'});
    await user.click(screen.getByRole('button',{name:'Patients',exact:true}));
    await screen.findByRole('textbox',{name:'Search patient directory'});
    expect(screen.queryByRole('button',{name:'Add record'})).toBeNull();
    expect(screen.queryByRole('button',{name:'New record'})).toBeNull();
    for(const name of ['Laboratory','Reference library','Antibiogram','AMR predictor','AI assistant']){
      await user.click(screen.getByRole('button',{name:name==='AI assistant'?/^AI assistant/:name,exact:true}));
      expect(screen.queryByRole('button',{name:'New record'})).toBeNull();
      if(name==='Laboratory'||name==='Reference library')expect(screen.getByRole('button',{name:'Add record'})).toBeTruthy();
    }
    await user.click(screen.getByRole('button',{name:'Overview',exact:true}));
    expect(screen.getByRole('button',{name:'New record'})).toBeTruthy();
  });
  it('opens a patient journey with samples, organisms and antibiotic results',async()=>{
    const user=userEvent.setup();workspace();await user.click(screen.getByRole('button',{name:'Patients',exact:true}));
    await user.click(await screen.findByRole('button',{name:/Open patient P000001/}));
    await screen.findByRole('heading',{name:'P000001'});
    expect(await screen.findByText('Escherichia coli',{selector:'em'})).toBeTruthy();
    expect(screen.getByText('ampicillin')).toBeTruthy();expect(screen.getByText('Susceptible')).toBeTruthy();
    expect(screen.getByRole('heading',{name:'Sample timeline'})).toBeTruthy();
  });
  it('filters unsampled patients without querying the raw source table',async()=>{
    const user=userEvent.setup();workspace();await user.click(screen.getByRole('button',{name:'Patients',exact:true}));
    await user.click(await screen.findByRole('tab',{name:'No samples'}));
    await waitFor(()=>expect(mockedApi.mock.calls.some(([path])=>path.startsWith('/patients?')&&path.includes('has_samples=no'))).toBe(true));
    expect(screen.queryByRole('button',{name:/Open patient P000001/})).toBeNull();
    expect(screen.getByRole('button',{name:/Open patient P000002/})).toBeTruthy();
  });
  it('copies patient, culture and ward identifiers without navigating or toggling samples',async()=>{
    const user=userEvent.setup(),write=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue();workspace();await user.click(screen.getByRole('button',{name:'Patients',exact:true}));
    await user.click(await screen.findByRole('button',{name:'Copy patient ID P000001'}));expect(write).toHaveBeenLastCalledWith('P000001');expect(screen.queryByRole('heading',{name:'P000001'})).toBeNull();
    await user.click(screen.getByRole('button',{name:'Open patient P000001'}));await screen.findByRole('heading',{name:'P000001'});
    const toggle=screen.getByRole('button',{name:'Toggle culture C001'});expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.click(screen.getByRole('button',{name:'Copy culture ID C001'}));expect(write).toHaveBeenLastCalledWith('C001');expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.click(screen.getByRole('button',{name:'Copy ward code ED'}));expect(write).toHaveBeenLastCalledWith('ED');expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('button button')).toBeNull();write.mockRestore();
  });
  it('registers a new patient through the existing validated source API',async()=>{
    const user=userEvent.setup();workspace();await screen.findByText('Registered patients');
    await user.click(screen.getByRole('button',{name:'Patients',exact:true}));
    await user.click(await screen.findByRole('button',{name:'Register patient'}));
    await user.type(screen.getByLabelText(/Patient id/),'P100001');
    await user.selectOptions(screen.getByLabelText(/Sex/),'F');
    await user.type(screen.getByLabelText(/Birth year/),'1990');
    await user.type(screen.getByLabelText(/Home area/),'North');
    await user.click(screen.getByRole('button',{name:'Create record'}));
    await screen.findByRole('status');
    const call=mockedApi.mock.calls.find(([path,options])=>path==='/source/adt/patients'&&options?.method==='POST');
    expect(call).toBeTruthy();expect(JSON.parse(String(call?.[1]?.body))).toEqual({patient_id:'P100001',sex:'F',birth_year:1990,home_area:'North'});
  });
});
