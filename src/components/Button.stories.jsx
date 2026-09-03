import { Button } from './Button';

export default { title: 'Button', component: Button };

export const Primary = { args: { children: 'Save changes' } };
export const Secondary = { args: { variant: 'secondary', children: 'Cancel' } };
export const Danger = { args: { variant: 'danger', children: 'Delete forever' } };
