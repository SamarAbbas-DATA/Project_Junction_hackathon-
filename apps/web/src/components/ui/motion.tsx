import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { animate, LayoutGroup, motion, useReducedMotion } from 'motion/react';

export const spring={type:'spring' as const,stiffness:340,damping:32};
export function AnimatedNumber({value,className=''}:{value:number;className?:string}){
  const node=useRef<HTMLSpanElement>(null),previous=useRef(0),reduce=useReducedMotion();
  useEffect(()=>{
    if(reduce){if(node.current)node.current.textContent=value.toLocaleString();previous.current=value;return;}
    const animation=animate(previous.current,value,{duration:.9,ease:[.22,1,.36,1],onUpdate:n=>{previous.current=n;if(node.current)node.current.textContent=Math.round(n).toLocaleString();}});
    return()=>animation.stop();
  },[value,reduce]);
  return <span ref={node} className={className} aria-label={value.toLocaleString()}>{value.toLocaleString()}</span>;
}

// Controlled, keyboard-accessible adaptation of the shared highlight interaction
// in Watermelon UI Tabs. Source/attribution: THIRD_PARTY_NOTICES.md.
export function SlidingTabs({value,onChange,items,label,className=''}:{value:string;onChange:(value:string)=>void;items:{value:string;label:ReactNode;count?:number}[];label:string;className?:string}){
  const id=useId(),reduce=useReducedMotion();
  return <LayoutGroup id={id}><div className={`sliding-tabs ${className}`} role="tablist" aria-label={label}>{items.map((item,index)=><button key={item.value} role="tab" type="button" aria-selected={value===item.value} tabIndex={value===item.value?0:-1} className={value===item.value?'selected':''} onClick={()=>onChange(item.value)} onKeyDown={event=>{
    let next=index;if(event.key==='ArrowRight')next=(index+1)%items.length;else if(event.key==='ArrowLeft')next=(index-1+items.length)%items.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;else return;
    event.preventDefault();onChange(items[next].value);(event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
  }}>{value===item.value&&<motion.span className="tab-highlight" layoutId="active-tab" transition={reduce?{duration:0}:spring}/>}<span className="tab-label">{item.label}{item.count!==undefined&&<small>{item.count.toLocaleString()}</small>}</span></button>)}</div></LayoutGroup>;
}

export function DotChart({values,color,label}:{values:number[];color:string;label:string}){
  const reduce=useReducedMotion(),max=Math.max(...values,1);
  const columns=values.length?values:Array(16).fill(0);
  return <svg className="dot-chart" viewBox={`0 0 ${columns.length*14} 66`} role="img" aria-label={label}><title>{label}. Relative weekly counts; exact totals shown above.</title>{columns.map((value,column)=>Array.from({length:6},(_,row)=>{
    const filled=row>=6-Math.round(value/max*6);
    return <motion.circle key={`${column}-${row}`} cx={column*14+5} cy={row*10+5} r={2.55} initial={false} animate={{fill:filled?color:'#eaecee',opacity:filled?1:.75}} transition={{duration:reduce?0:.4,delay:reduce?0:column*.018+row*.008}}/>;
  }))}</svg>;
}

export function ConnectionGlobe(){
  const reduce=useReducedMotion();
  const points=Array.from({length:150},(_,i)=>{
    const z=1-2*(i+.5)/150,r=Math.sqrt(1-z*z),angle=i*2.39996323;
    return {x:Math.cos(angle)*r*113,y:z*113,z:Math.sin(angle)*r};
  });
  return <div className="connection-globe" aria-hidden="true"><motion.svg viewBox="0 0 280 245" animate={reduce?{}:{rotate:[-7,7,-7]}} transition={{duration:28,repeat:Infinity,ease:'easeInOut'}}>
    <defs><radialGradient id="globe-shade"><stop offset="0" stopColor="#fff" stopOpacity="0"/><stop offset="1" stopColor="#bfc4c8" stopOpacity=".12"/></radialGradient></defs>
    <circle cx="140" cy="126" r="114" fill="url(#globe-shade)" stroke="#dadde0" strokeWidth=".5"/>
    {[.32,.62,.86].map((scale,i)=><ellipse key={scale} cx="140" cy="126" rx={114*scale} ry="114" fill="none" stroke="#c2c7cd" strokeOpacity=".3" strokeWidth=".5" transform={`rotate(${i*37} 140 126)`}/>)}
    {points.filter((_,i)=>i%2===0).map((point,i)=><path key={i} d={`M 82 214 Q ${92+point.x*.3} ${158+point.y*.2} ${140+point.x} ${126+point.y}`} stroke="#667580" strokeOpacity={.04+(point.z+1)*.07} strokeWidth=".55" fill="none"/>)}
    {points.map((point,i)=><motion.circle key={i} cx={140+point.x} cy={126+point.y} r={point.z>0?1.35:.85} fill="#475159" initial={false} animate={reduce?{opacity:.5}:{opacity:[.2,.65,.2]}} transition={{duration:4+(i%5),delay:i*.027,repeat:Infinity,ease:'easeInOut'}}/>)}
    <motion.circle cx="82" cy="214" r="4" fill="#2861ec" animate={reduce?{}:{opacity:[.6,1,.6],r:[3,4.5,3]}} transition={{duration:3,repeat:Infinity}}/>
  </motion.svg></div>;
}

export function CountBars({values}:{values:number[]}){const max=Math.max(...values,1),reduce=useReducedMotion();return <div className="count-bars" aria-hidden="true">{values.map((value,i)=><motion.i key={i} initial={false} animate={{scaleY:.15+.85*value/max}} transition={{duration:reduce?0:.55,delay:reduce?0:i*.035}}/>)}</div>}

export function useDebounced<T>(value:T,delay=250){const [debounced,setDebounced]=useState(value);useEffect(()=>{const timer=setTimeout(()=>setDebounced(value),delay);return()=>clearTimeout(timer);},[value,delay]);return debounced;}
