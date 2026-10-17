// Exact one-sided Fisher test for an increase in the current period. Tables
// contain independent patients, not repeated AST rows. No normal approximation.
const logFactorials=[0];
function logFactorial(n:number){for(let i=logFactorials.length;i<=n;i++)logFactorials[i]=logFactorials[i-1]+Math.log(i);return logFactorials[n];}
function logChoose(n:number,k:number){return k<0||k>n?-Infinity:logFactorial(n)-logFactorial(k)-logFactorial(n-k);}
export function fisherIncrease(currentPositive:number,currentTotal:number,baselinePositive:number,baselineTotal:number){
  const numbers=[currentPositive,currentTotal,baselinePositive,baselineTotal];
  if(numbers.some(n=>!Number.isSafeInteger(n)||n<0)||currentPositive>currentTotal||baselinePositive>baselineTotal)throw new Error('Invalid contingency table');
  if(!currentTotal||!baselineTotal)return 1;
  const positives=currentPositive+baselinePositive,total=currentTotal+baselineTotal,upper=Math.min(currentTotal,positives);
  const denominator=logChoose(total,currentTotal);let sum=0;
  for(let k=currentPositive;k<=upper;k++)sum+=Math.exp(logChoose(positives,k)+logChoose(total-positives,currentTotal-k)-denominator);
  return Math.min(1,Math.max(Number.MIN_VALUE,sum));
}

// Benjamini-Hochberg adjustment is applied to ALL eligible comparisons in the
// ward, before filtering on effect size. Small/non-comparable groups are excluded.
export function adjustFalseDiscovery<T extends {p_value:number}>(items:T[]):(T&{q_value:number})[]{
  const ranked=items.map((item,index)=>({item,index})).sort((a,b)=>a.item.p_value-b.item.p_value),out=Array(items.length);let previous=1;
  for(let i=ranked.length-1;i>=0;i--){previous=Math.min(previous,ranked[i].item.p_value*ranked.length/(i+1),1);out[ranked[i].index]={...ranked[i].item,q_value:previous};}
  return out;
}
export function proportionInterval(positive:number,total:number){
  if(!total)return null;const z=1.95996398454,p=positive/total,d=1+z*z/total,center=(p+z*z/(2*total))/d,half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;
  return [Math.max(0,center-half),Math.min(1,center+half)];
}
