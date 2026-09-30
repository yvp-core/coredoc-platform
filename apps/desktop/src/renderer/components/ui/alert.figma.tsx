import figma from '@figma/code-connect';
import { Alert, AlertActions, AlertDescription, AlertTitle } from './alert';

const FILE = 'https://www.figma.com/design/idOJ0ISbJdYW9gzw1w4tr0/Coredoc-UI-Library';

figma.connect(Alert, `${FILE}?node-id=10-40`, {
  props: {
    title: figma.string('Title'),
    description: figma.string('Description'),
    variant: figma.enum('Variant', { Amber: 'amber', Info: 'info' }),
  },
  example: ({ title, description, variant }) => (
    <Alert variant={variant}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  ),
});

figma.connect(Alert, `${FILE}?node-id=10-40`, {
  variant: { Actions: 'On' },
  props: {
    title: figma.string('Title'),
    description: figma.string('Description'),
    variant: figma.enum('Variant', { Amber: 'amber', Info: 'info' }),
  },
  example: ({ title, description, variant }) => (
    <Alert variant={variant}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      <AlertActions>{/* primary + secondary action buttons (size="xs") */}</AlertActions>
    </Alert>
  ),
});
