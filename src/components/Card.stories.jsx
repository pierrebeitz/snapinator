import { Card } from './Card';

export default { title: 'Card', component: Card };

export const Default = {
  args: {
    title: 'Nightly baseline',
    body: 'A build on main carries the baseline every other build inherits.',
  },
};

export const WithTone = {
  args: {
    title: 'Pull request #42',
    body: 'Three stories moved. Review the diff before this merges.',
    tone: 'warning',
  },
};
