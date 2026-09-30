import { Pie, PieChart, Cell } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
const colors = ['#8EA7C2','#6F8E86','#B5A181','#A38B9B'];
export function PhysicalFormatChart({data}:{data:{format:string;count:number}[]}) {
  const rows = data.map((d,i)=>({...d,key:`format${i}`,fill:colors[i%colors.length]}));
  const config = Object.fromEntries(rows.map(d=>[d.key,{label:d.format,color:d.fill}])) satisfies ChartConfig;
  return <div className="format-chart-layout"><ChartContainer config={config} className="mx-auto aspect-square w-full max-w-[220px]" aria-label="Physical format copy memberships"><PieChart accessibilityLayer><ChartTooltip content={<ChartTooltipContent nameKey="format" hideLabel/>}/><Pie data={rows} dataKey="count" nameKey="format" innerRadius={45} outerRadius={78} paddingAngle={2} isAnimationActive={false}>{rows.map(d=><Cell key={d.key} fill={d.fill}/>)}</Pie></PieChart></ChartContainer><ul className="format-list">{rows.map(d=><li key={d.key}><i style={{background:d.fill}}/>{d.format}<strong>{d.count}</strong></li>)}</ul></div>;
}
