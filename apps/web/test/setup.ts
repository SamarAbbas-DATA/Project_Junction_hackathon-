import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
Object.defineProperty(window,'matchMedia',{writable:true,value:(query:string)=>({matches:query.includes('prefers-reduced-motion'),media:query,onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true;}})});
class TestEventSource {onopen=null;onerror=null;onmessage=null;close(){}}
Object.defineProperty(globalThis,'EventSource',{value:TestEventSource,writable:true});
Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{value(){},writable:true});
afterEach(()=>cleanup());
