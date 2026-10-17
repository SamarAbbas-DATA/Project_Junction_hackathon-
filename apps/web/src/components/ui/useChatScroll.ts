import { useCallback,useEffect,useRef,useState,type UIEvent,type WheelEvent,type TouchEvent,type KeyboardEvent } from 'react';

export function useChatScroll(messageId:string|undefined,content:unknown,context:unknown,error:unknown,busy:boolean){
  const ref=useRef<HTMLDivElement>(null),following=useRef(true),frame=useRef<number|undefined>(undefined),lastTop=useRef(0),touchY=useRef(0);
  const [showLatest,setShowLatest]=useState(false);
  const pause=useCallback(()=>{following.current=false;setShowLatest(true);if(frame.current!==undefined){cancelAnimationFrame(frame.current);frame.current=undefined;}},[]);
  const scroll=useCallback(()=>{
    if(!following.current||frame.current!==undefined)return;
    frame.current=requestAnimationFrame(()=>{frame.current=undefined;const el=ref.current;if(el&&following.current){el.scrollTop=Math.max(0,el.scrollHeight-el.clientHeight);lastTop.current=el.scrollTop;}});
  },[]);
  const latest=useCallback(()=>{following.current=true;setShowLatest(false);scroll();},[scroll]);
  useEffect(()=>{if(frame.current!==undefined){cancelAnimationFrame(frame.current);frame.current=undefined;}following.current=true;setShowLatest(false);if(messageId)scroll();else if(ref.current){ref.current.scrollTop=0;lastTop.current=0;}},[messageId,scroll]);
  useEffect(()=>{if(messageId)scroll();},[messageId,content,context,error,busy,scroll]);
  useEffect(()=>()=>{if(frame.current!==undefined)cancelAnimationFrame(frame.current);},[]);
  return {ref,showLatest,latest,handlers:{
    onScroll:(e:UIEvent<HTMLDivElement>)=>{const el=e.currentTarget,down=el.scrollTop>=lastTop.current,atBottom=el.scrollHeight-el.clientHeight-el.scrollTop<=8;if(el.scrollTop<lastTop.current&&!(atBottom&&following.current))pause();else if(down&&atBottom){following.current=true;setShowLatest(false);}lastTop.current=el.scrollTop;},
    onWheel:(e:WheelEvent)=>{if(e.deltaY<0)pause();},
    onTouchStart:(e:TouchEvent)=>{touchY.current=e.touches[0]?.clientY??0;},
    onTouchMove:(e:TouchEvent)=>{const y=e.touches[0]?.clientY??0;if(y>touchY.current)pause();touchY.current=y;},
    onKeyDown:(e:KeyboardEvent)=>{if(['ArrowUp','PageUp','Home'].includes(e.key)||(e.key===' '&&e.shiftKey))pause();}
  }};
}
