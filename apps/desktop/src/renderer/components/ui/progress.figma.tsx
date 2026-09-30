import figma from '@figma/code-connect';
import { Progress } from './progress';

const FILE = 'https://www.figma.com/design/idOJ0ISbJdYW9gzw1w4tr0/Coredoc-UI-Library';

figma.connect(Progress, `${FILE}?node-id=14-19`, {
  variant: { Mode: 'Determinate' },
  example: () => <Progress value={60} />,
});

figma.connect(Progress, `${FILE}?node-id=14-19`, {
  variant: { Mode: 'Indeterminate' },
  example: () => <Progress indeterminate />,
});
