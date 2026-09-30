import figma from '@figma/code-connect';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

const FILE = 'https://www.figma.com/design/idOJ0ISbJdYW9gzw1w4tr0/Coredoc-UI-Library';

// Sizes in code: default h-8, sm h-7, xs h-5. The type also accepts "md" but no
// height class exists for it — do not use.
// Placeholder state: the Figma Value is placeholder copy, nothing selected yet.
figma.connect(SelectTrigger, `${FILE}?node-id=14-14`, {
  props: {
    value: figma.string('Value'),
    disabled: figma.enum('State', { Disabled: true }),
  },
  example: ({ value, disabled }) => (
    <Select>
      <SelectTrigger disabled={disabled}>
        <SelectValue placeholder={value} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">Member</SelectItem>
      </SelectContent>
    </Select>
  ),
});

// Value state: an option is chosen — the trigger shows a real selection.
figma.connect(SelectTrigger, `${FILE}?node-id=14-14`, {
  variant: { State: 'Value' },
  example: () => (
    <Select defaultValue="member">
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">Member</SelectItem>
      </SelectContent>
    </Select>
  ),
});
