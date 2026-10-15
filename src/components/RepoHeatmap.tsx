import { Treemap, ResponsiveContainer } from 'recharts';
import type { ReactElement } from 'react';
export default function RepoHeatmap({ data, content }: { data: any[]; content: ReactElement }) {
  return <ResponsiveContainer width="100%" height="100%"><Treemap data={data} dataKey="size" aspectRatio={4 / 3} stroke="#FAF8F5" content={content} /></ResponsiveContainer>;
}
