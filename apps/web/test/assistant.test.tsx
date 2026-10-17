import { beforeEach,describe,expect,it,vi } from 'vitest';
import { act,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { AssistantDock,AssistantPage,AssistantProvider } from '../src/components/Assistant';
import { api,streamAssistant,type Row } from '../src/api';
import LanguageSwitch from '../src/components/LanguageSwitch';
vi.mock('../src/api',async()=>{const actual=await vi.importActual<typeof import('../src/api')>('../src/api');return {...actual,api:vi.fn(),streamAssistant:vi.fn()};});
vi.mock('motion/react',async()=>{const actual=await vi.importActual<typeof import('motion/react')>('motion/react');return {...actual,AnimatePresence:({children}:{children:React.ReactNode})=>children};});
const mocked=vi.mocked(streamAssistant),mockApi=vi.mocked(api);
const packet={focus:{patient_ids:['P000001'],culture_ids:[],ward_codes:[]},entities:[{kind:'patient',id:'P000001'}],missing:[],sources:[{kind:'patient',id:'P000001'}],records:{patients:[{record:{patient_id:'P000001'},summary:{samples:3,tests:8}}]},amr:[{status:'available',culture_id:'C0000001',as_of_date:'2026-10-17',inputs:{organism:'Escherichia coli',specimen:'urine'},resistance:{top:[{antibiotic:'Ciprofloxacin',source:'model',percent_works:65}]}}],retrieval:{queried_at:'2026-10-17T10:00:00Z',duration_ms:22},synchronization:[{source:'lis',status:'connected'}]};
function Harness(){const [page,setPage]=useState(false);return <AssistantProvider>{page?<AssistantPage/>:<div>Overview content</div>}<button onClick={()=>setPage(!page)}>Switch page</button><AssistantDock isAssistantPage={page} onExpand={()=>setPage(true)}/></AssistantProvider>;}
function mount(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Harness/></QueryClientProvider>);}
beforeEach(()=>{
  mocked.mockReset();mockApi.mockReset();mockApi.mockResolvedValue({available:true,ready:true,models:['qwen3.5:4b'],selected:'qwen3.5:4b'});
  mocked.mockImplementation(async(_body,onEvent)=>{onEvent({type:'context',context:packet});onEvent({type:'token',content:'This patient has **3 samples**.'});onEvent({type:'done',model:'qwen3.5:4b'});});
});
describe('shared AI assistant',()=>{
  it('shows saved detector signals separately from model estimates and guideline context',async()=>{
    mocked.mockImplementation(async(_body,onEvent)=>{onEvent({type:'context',context:{...packet,anomalies:{alerts:[{id:'signal-1',type:'resistance',status:'open',ward_code:'ANOM-R',organism:'Escherichia coli',last_evaluated_at:'2026-10-17T12:00:00Z',evidence:{current:{positive:30,total:40,from:'2026-09-20',to:'2026-10-17'}}}]}}});onEvent({type:'token',content:'A saved resistance signal is available for ANOM-R.'});onEvent({type:'done',model:'qwen3.5:4b'});});
    const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:'Open quick assistant'}));await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Explain the saved anomaly');await user.keyboard('{Enter}');
    await screen.findByText(/A saved resistance signal is available for/);await user.click(screen.getByText(/linked clinical records/));await user.click(screen.getByText(/Saved anomaly signals/));
    expect(screen.getByText('Resistance increase')).toBeTruthy();expect(screen.getByText(/30\/40/)).toBeTruthy();expect(screen.getByText('Surveillance signal, not a confirmed outbreak.')).toBeTruthy();
  });
  it('sends the selected Finnish response language and preserves the chat when switching back',async()=>{
    const user=userEvent.setup();render(<><LanguageSwitch/><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Harness/></QueryClientProvider></>);
    await user.selectOptions(screen.getByRole('combobox',{name:'Language / Kieli'}),'fi');await user.click(screen.getByRole('button',{name:'Avaa pika-avustaja'}));
    await user.click(screen.getByRole('button',{name:/Yleinen kysymys/}));expect(screen.getByText('Kuinka monta viljelyä odottaa lopullista vastausta?')).toBeTruthy();
    await user.type(screen.getByRole('textbox',{name:'Viesti avustajalle'}),'Tarkastele potilasta P000001');await user.click(screen.getByRole('button',{name:'Lähetä viesti'}));
    await screen.findByText('3 samples',{selector:'strong'});expect(mocked.mock.calls[0][0]).toMatchObject({language:'fi',message:'Tarkastele potilasta P000001'});
    await user.selectOptions(screen.getByRole('combobox',{name:'Language / Kieli'}),'en');expect(screen.getByRole('dialog',{name:'Quick AI assistant'})).toBeTruthy();expect(screen.getByText('3 samples',{selector:'strong'})).toBeTruthy();
  });
  it('shows the English TYKS reference and opens source-page citations without replacing the chat',async()=>{
    const guidance={source:{edition_date:'2026-04-13',source_url:'/api/assistant/guidelines/tyks/source.pdf'},sections:[{id:'susceptibility',title:'Interpreting S, I and R',pages:[15,16,17,18],facts:['I means susceptible with increased exposure.'],citation_url:'/api/assistant/guidelines/tyks/source.pdf#page=15'}]};
    mocked.mockImplementation(async(_body,onEvent)=>{onEvent({type:'context',context:{...packet,clinical_guidance:guidance}});onEvent({type:'token',content:'I means susceptible with increased exposure. [TYKS 2026, p. 15](/api/assistant/guidelines/tyks/source.pdf#page=15)'});onEvent({type:'done',model:'qwen3.5:4b'});});
    const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:'Open quick assistant'}));await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'What does I mean?');await user.keyboard('{Enter}');
    const citation=await screen.findByRole('link',{name:'TYKS 2026, p. 15'});expect(citation.getAttribute('href')).toBe(guidance.sections[0].citation_url);expect(citation.getAttribute('target')).toBe('_blank');
    await user.click(screen.getByText(/TYKS reference/));expect(screen.getByText('TYKS clinical guidance')).toBeTruthy();await user.click(screen.getByText('Read the English guidance'));
    expect(screen.getByRole('heading',{name:'Interpreting S, I and R'})).toBeTruthy();expect(screen.getByRole('link',{name:'Open Finnish guideline'}).getAttribute('href')).toBe(guidance.source.source_url);expect(screen.getByRole('dialog',{name:'Quick AI assistant'})).toBeTruthy();
  });
  it('lets a reader scroll up during streaming and follows again only after jumping to the latest response',async()=>{
    let emit:(event:Row)=>void=()=>{};
    mocked.mockImplementation(async(_body,onEvent,signal)=>{emit=onEvent;onEvent({type:'token',content:'Streaming answer'});await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));});
    const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:'Open quick assistant'}));await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Review microbiology');await user.keyboard('{Enter}');
    await screen.findByText('Streaming answer');
    const region=screen.getByRole('region',{name:'Chat messages'});let height=900;
    Object.defineProperties(region,{clientHeight:{configurable:true,value:300},scrollHeight:{configurable:true,get:()=>height},scrollTop:{configurable:true,writable:true,value:600}});
    fireEvent.scroll(region);fireEvent.wheel(region,{deltaY:-100});region.scrollTop=450;fireEvent.scroll(region);
    height=1100;act(()=>emit({type:'token',content:' continues as Qwen writes more text.'}));
    await new Promise(resolve=>setTimeout(resolve,35));expect(region.scrollTop).toBe(450);
    await user.click(screen.getByRole('button',{name:'Jump to latest response'}));await waitFor(()=>expect(region.scrollTop).toBe(800));
    height=1200;act(()=>emit({type:'token',content:' Another paragraph.'}));await waitFor(()=>expect(region.scrollTop).toBe(900));
    // Manual upward scrolling also pauses, including use of the scrollbar.
    region.scrollTop=500;fireEvent.scroll(region);height=1300;act(()=>emit({type:'token',content:' More text.'}));await new Promise(resolve=>setTimeout(resolve,35));expect(region.scrollTop).toBe(500);
    // Scrolling all the way down resumes the same conversation automatically.
    region.scrollTop=1000;fireEvent.scroll(region);height=1400;act(()=>emit({type:'token',content:' Final paragraph.'}));await waitFor(()=>expect(region.scrollTop).toBe(1100));
    await user.click(screen.getByRole('button',{name:'Stop response'}));
    await user.click(screen.getByRole('button',{name:'New assistant chat'}));await new Promise(resolve=>setTimeout(resolve,35));expect(region.scrollTop).toBe(0);expect(screen.queryByRole('button',{name:'Jump to latest response'})).toBeNull();
  });
  it('offers four contexts and keeps a patient conversation when expanding, minimizing and changing tabs',async()=>{
    const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:'Open quick assistant'}));
    const dialog=screen.getByRole('dialog',{name:'Quick AI assistant'});
    const options=within(dialog).getByRole('group',{name:'Choose question context'});expect(within(options).getAllByRole('button')).toHaveLength(4);
    await user.click(within(options).getByRole('button',{name:/Patient ID/}));
    await user.type(screen.getByRole('textbox',{name:'Patient ID'}),'p000001');
    await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Summarize the patient');await user.click(screen.getByRole('button',{name:'Send message'}));
    await screen.findByText('3 samples',{selector:'strong'});expect(mocked.mock.calls[0][0]).toMatchObject({mode:'patient',identifier:'p000001'});
    expect((screen.getByRole('textbox',{name:'Patient ID'}) as HTMLInputElement).value).toBe('P000001');
    await user.click(screen.getByText(/AMR context included/));expect(screen.getByText(/estimated susceptibility/)).toBeTruthy();expect(screen.getByText(/65%/)).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'Open assistant full page'}));expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByText('3 samples',{selector:'strong'})).toBeTruthy();
    await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Any pending results?');await user.keyboard('{Enter}');
    await waitFor(()=>expect(mocked).toHaveBeenCalledTimes(2));expect(mocked.mock.calls[1][0].focus).toEqual(packet.focus);expect(mocked.mock.calls[1][0].history).toHaveLength(2);
    await user.click(screen.getByRole('button',{name:'Switch page'}));await user.click(screen.getByRole('button',{name:'Open quick assistant'}));expect(screen.getByText('Any pending results?')).toBeTruthy();
    await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(screen.getByRole('button',{name:'Open quick assistant'}));
  });
  it('validates scoped identifiers and allows an unscoped question with an ID in its text',async()=>{
    const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:'Open quick assistant'}));await user.click(screen.getByRole('button',{name:/^Culture ID/}));
    await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Explain this sample');await user.click(screen.getByRole('button',{name:'Send message'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Enter a culture id first.');expect(mocked).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:/^General question/}));await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Summarize C0000001');await user.keyboard('{Enter}');
    await waitFor(()=>expect(mocked).toHaveBeenCalledTimes(1));expect(mocked.mock.calls[0][0]).toMatchObject({mode:'general',message:'Summarize C0000001'});
  });
  it('preserves source context on model failure and resets patient context for a new chat',async()=>{
    mocked.mockImplementation(async(_body,onEvent)=>{onEvent({type:'context',context:packet});onEvent({type:'error',error:'Ollama is not reachable.'});});
    const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:'Open quick assistant'}));await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Summarize P000001');await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('Ollama is not reachable.'));
    expect(screen.getByText(/1 linked clinical record/)).toBeTruthy();await user.click(screen.getByRole('button',{name:'New assistant chat'}));
    expect(screen.queryByRole('log')).toBeNull();expect(within(screen.getByRole('group',{name:'Choose question context'})).getAllByRole('button')).toHaveLength(4);
  });
  it('can stop an active answer without losing already streamed text',async()=>{
    mocked.mockImplementation(async(_body,onEvent,signal)=>{onEvent({type:'context',context:packet});onEvent({type:'token',content:'Partial answer'});await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));});
    const user=userEvent.setup();mount();await user.click(screen.getByRole('button',{name:'Open quick assistant'}));await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Summarize P000001');await user.keyboard('{Enter}');
    await screen.findByText('Partial answer');await user.click(screen.getByRole('button',{name:'Stop response'}));await screen.findByText(/Response stopped/);expect(screen.getByText('Partial answer')).toBeTruthy();expect(screen.getByRole('button',{name:'Send message'})).toBeTruthy();
  });
  it('copies IDs from both source context and formatted answers',async()=>{
    mocked.mockImplementation(async(_body,onEvent)=>{onEvent({type:'context',context:packet});onEvent({type:'token',content:'Patient **P000001** has culture `C0000001`.'});onEvent({type:'done',model:'qwen3.5:4b'});});
    const user=userEvent.setup(),write=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue();mount();await user.click(screen.getByRole('button',{name:'Open quick assistant'}));await user.type(screen.getByRole('textbox',{name:'Message the assistant'}),'Review P000001');await user.keyboard('{Enter}');
    const answer=await screen.findByText('P000001',{selector:'.assistant-markdown .copy-id-value'});
    expect(answer).toBeTruthy();const idButtons=screen.getAllByRole('button',{name:'Copy culture ID C0000001'});await user.click(idButtons.at(-1)!);expect(write).toHaveBeenLastCalledWith('C0000001');
    expect(document.querySelector('button button')).toBeNull();write.mockRestore();
  });
});
