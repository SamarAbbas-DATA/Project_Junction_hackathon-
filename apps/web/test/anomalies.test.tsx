import { beforeEach,describe,it,expect,vi } from 'vitest';
import { render,screen,waitFor,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import Anomalies from '../src/components/Anomalies';
import LanguageSwitch from '../src/components/LanguageSwitch';
import { api,type Row } from '../src/api';

vi.mock('../src/api',async()=>{const actual=await vi.importActual<typeof import('../src/api')>('../src/api');return {...actual,api:vi.fn()};});
const mocked=vi.mocked(api),id='11111111-1111-4111-8111-111111111111';
const initial={id,type:'resistance',code:'resistance_increase',source:'lis',ward_code:'ANOM-R',ward_en:'Anomaly test: resistance',ward_fi:'Poikkeamatesti: resistenssi',organism:'Escherichia coli',antibiotic_code:'TEST-AMP',specimen:'urine',status:'open',active:true,version:1,rule_version:'2026-10-17.v1',last_evaluated_at:'2026-10-17T12:00:00Z',
  evidence:{current:{positive:30,total:40,rate:.75,from:'2026-09-20',to:'2026-10-17',interval_95:[.6,.85]},baseline:{positive:6,total:60,rate:.1,from:'2026-06-28',to:'2026-09-19',interval_95:[.05,.2]},increase_points:65,q_value:.00001,comparisons_in_family:5,guideline:'ANOMALY-TEST-1'},
  records:[{patient_id:'8123456',culture_id:'AT-001',isolate_id:'AT-001-1',result:'R',sample_date:'2026-10-17'}],records_total:1,history:[{action:'detected',episode:1,actor:'detector',note:'',at:'2026-10-17T12:00:00Z'}]};
let alert:Row,scenario:string,failReview:boolean;
beforeEach(()=>{
  alert=structuredClone(initial);scenario='';failReview=false;mocked.mockReset();
  mocked.mockImplementation(async(path,options)=>{
    if(path==='/anomalies/summary')return {counts:{active:alert.active?1:0,resistance:alert.active?1:0,cluster:0,data_quality:0},sources:[{source:'lis',status:'connected'}],jobs:[],last_evaluated_at:'2026-10-17T12:00:00Z',wards:[{ward_code:'ANOM-R',ward_en:'Anomaly test: resistance',ward_fi:'Poikkeamatesti: resistenssi'}],rules:{current_days:28,baseline_days:84,minimum_tested:30,minimum_increase:.15,false_discovery_rate:.05,cluster_days:7,cluster_minimum_patients:3,quality_grace_seconds:120,version:'v1'},evaluations:[],demo_enabled:true};
    if(path==='/anomalies/demo/status')return {runs:scenario?[{kind:'resistance',state:scenario,ward_code:'ANOM-R'}]:[]};
    if(path==='/anomalies/'+id)return {...alert};
    if(path.startsWith('/anomalies?'))return {rows:alert.active?[alert]:[],total:alert.active?1:0};
    if(path===`/anomalies/${id}/review`){if(failReview){alert.version++;throw new Error('Alert changed. Refresh and review it again.');}const body=JSON.parse(String(options?.body));alert={...alert,status:body.status,version:alert.version+1};return {id,status:body.status};}
    if(path==='/anomalies/demo/resistance'){scenario='ready';return {state:'ready',ward_code:'ANOM-R'};}
    if(path==='/anomalies/demo/resistance/correct'){scenario='corrected';alert={...alert,status:'resolved',active:false,version:alert.version+1};return {state:'corrected'};}
    if(path==='/anomalies/demo/resistance/replay')return {status:200,body:{duplicate:true,applied:0}};
    throw new Error('Unexpected anomaly test request '+path);
  });
});
function mount(){const onRecord=vi.fn();render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LanguageSwitch/><Anomalies onRecord={onRecord}/></QueryClientProvider>);return onRecord;}

describe('anomaly review workspace',()=>{
  it('shows measured comparison counts, links exact records and filters by ward and status',async()=>{
    const user=userEvent.setup(),onRecord=mount();await screen.findByRole('heading',{name:'Resistance increase',level:2});
    expect(screen.getByText('(30/40)')).toBeTruthy();expect(screen.getByText('(6/60)')).toBeTruthy();expect(screen.getByText('ANOMALY-TEST-1')).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'8123456',exact:true}));expect(onRecord).toHaveBeenLastCalledWith('adt','patients',{patient_id:'8123456'});
    await user.click(screen.getByRole('button',{name:'AT-001',exact:true}));expect(onRecord).toHaveBeenLastCalledWith('lis','cultures',{culture_id:'AT-001'});
    await user.selectOptions(screen.getByRole('combobox',{name:'Signal ward'}),'ANOM-R');await user.selectOptions(screen.getByRole('combobox',{name:'Alert status'}),'all');
    await waitFor(()=>expect(mocked.mock.calls.some(([path])=>path.startsWith('/anomalies?')&&path.includes('ward=ANOM-R')&&path.includes('status=all'))).toBe(true));
  });
  it('records review notes with optimistic versions and requires a note for dismissal',async()=>{
    const user=userEvent.setup();mount();await screen.findByRole('heading',{name:'Resistance increase',level:2});
    expect((screen.getByRole('button',{name:'Dismiss with note'}) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole('textbox',{name:'Review note'}),'Reviewed the sample cohort');await user.click(screen.getByRole('button',{name:'Acknowledge'}));
    await waitFor(()=>expect(mocked.mock.calls.some(([path,options])=>path.endsWith('/review')&&JSON.parse(String(options?.body)).expected_version===1)).toBe(true));
    await waitFor(()=>expect((screen.getByRole('button',{name:'Acknowledge'}) as HTMLButtonElement).disabled).toBe(true));
    await user.type(screen.getByRole('textbox',{name:'Review note'}),'Confirmed controlled test data');await user.click(screen.getByRole('button',{name:'Dismiss with note'}));
    const reviews=mocked.mock.calls.filter(([path])=>path.endsWith('/review'));expect(JSON.parse(String(reviews.at(-1)?.[1]?.body))).toEqual({status:'dismissed',expected_version:2,note:'Confirmed controlled test data'});
  });
  it('refreshes a stale review without losing its note or pretending it succeeded',async()=>{
    failReview=true;const user=userEvent.setup();mount();await screen.findByRole('heading',{name:'Resistance increase',level:2});
    await user.type(screen.getByRole('textbox',{name:'Review note'}),'Keep this note');await user.click(screen.getByRole('button',{name:'Acknowledge'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Alert changed. Refresh and review it again.');expect(screen.getByRole('textbox',{name:'Review note'})).toHaveProperty('value','Keep this note');
  });
  it('loads a controlled test, replays its message and resolves the signal after correction',async()=>{
    const user=userEvent.setup();mount();await screen.findByRole('heading',{name:'Resistance increase',level:2});await user.click(screen.getByText('Test with synthetic scenarios'));
    const resistance=screen.getByText('60 baseline patients: 6 resistant. 40 current patients: 30 resistant.').closest('section')!;
    await user.click(within(resistance).getByRole('button',{name:'Load scenario'}));await screen.findByText('Test scenario loaded. Watch the signal list; detection runs automatically.');
    await user.click(within(resistance).getByRole('button',{name:'Replay same message'}));expect(await screen.findByText('Duplicate replay accepted. No new records were added.')).toBeTruthy();
    await user.click(within(resistance).getByRole('button',{name:'Correct test results'}));await screen.findByText('Test results corrected. The live detector will reassess and resolve the signal.');
    expect(await screen.findByText('The detector resolved this signal because its criteria no longer hold. The evidence and review history are retained.')).toBeTruthy();expect(screen.getByText('Evidence snapshot from the last matching evaluation.')).toBeTruthy();
  });
  it('translates controls to Finnish while preserving organism names and source IDs',async()=>{
    const user=userEvent.setup();mount();await screen.findByRole('heading',{name:'Resistance increase',level:2});await user.selectOptions(screen.getByRole('combobox',{name:'Language / Kieli'}),'fi');
    expect(screen.getByRole('heading',{name:'Poikkeamat'})).toBeTruthy();expect(screen.getByRole('button',{name:'Kuittaa'})).toBeTruthy();expect(screen.getByRole('combobox',{name:'Hälytyksen tila'})).toBeTruthy();expect(screen.getByText('Escherichia coli',{selector:'em'})).toBeTruthy();expect(screen.getByRole('button',{name:'8123456',exact:true})).toBeTruthy();
  });
});
