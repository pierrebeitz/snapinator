import { Badge } from './Badge';

export default { title: 'Badge', component: Badge };

export const Neutral = { args: { children: 'Draft' } };
export const Success = { args: { tone: 'success', children: 'Approved' } };
export const Warning = { args: { tone: 'warning', children: 'Needs review' } };
