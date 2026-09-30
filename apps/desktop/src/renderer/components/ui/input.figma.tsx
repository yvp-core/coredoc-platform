import figma from '@figma/code-connect';
import { Input } from './input';
import { Label } from './label';

const FILE = 'https://www.figma.com/design/idOJ0ISbJdYW9gzw1w4tr0/Coredoc-UI-Library';

// Empty state: the Figma Value is placeholder text.
figma.connect(Input, `${FILE}?node-id=13-10`, {
  props: {
    value: figma.string('Value'),
    disabled: figma.enum('State', { Disabled: true }),
  },
  example: ({ value, disabled }) => <Input placeholder={value} disabled={disabled} />,
});

// Filled state: the Figma Value is an actual value, not a placeholder.
figma.connect(Input, `${FILE}?node-id=13-10`, {
  variant: { State: 'Filled' },
  props: { value: figma.string('Value') },
  example: ({ value }) => <Input defaultValue={value} />,
});

figma.connect(Label, `${FILE}?node-id=13-11`, {
  props: { text: figma.string('Text') },
  example: ({ text }) => <Label>{text}</Label>,
});
