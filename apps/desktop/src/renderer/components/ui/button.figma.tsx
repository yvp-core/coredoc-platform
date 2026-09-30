import figma from '@figma/code-connect';
import { Button } from './button';

const FILE = 'https://www.figma.com/design/idOJ0ISbJdYW9gzw1w4tr0/Coredoc-UI-Library';

// Design→code variant mapping per DESIGN.md: Primary=default, Secondary=secondary,
// Tertiary=outline, Destructive=destructive, Brand=brand.
figma.connect(Button, `${FILE}?node-id=7-39`, {
  props: {
    label: figma.string('Label'),
    variant: figma.enum('Variant', {
      Primary: 'default',
      Secondary: 'secondary',
      Tertiary: 'outline',
      Destructive: 'destructive',
      Brand: 'brand',
    }),
    disabled: figma.enum('State', { Disabled: true }),
  },
  example: ({ label, variant, disabled }) => (
    <Button variant={variant} disabled={disabled}>
      {label}
    </Button>
  ),
});

// Team Accent = Button composed with the border-accent-gradient utility —
// a 2px masked gradient ring over any button background. Never a flat pink border.
figma.connect(Button, `${FILE}?node-id=7-39`, {
  variant: { Variant: 'Team Accent' },
  props: {
    label: figma.string('Label'),
    disabled: figma.enum('State', { Disabled: true }),
  },
  example: ({ label, disabled }) => (
    <Button variant="secondary" className="border-accent-gradient border-2" disabled={disabled}>
      {label}
    </Button>
  ),
});

// Icon Button. The circular "Toolbar" treatment (white fill + zinc-100 ring)
// exists only in the design library today — button.tsx has no such primitive,
// so both styles map to the real ghost icon variant until one is added.
// The icon child and a real aria-label come from the composing screen.
figma.connect(Button, `${FILE}?node-id=7-101`, {
  variant: { Style: 'Toolbar' },
  example: () => <Button variant="ghost" size="icon" aria-label="Action" />,
});

figma.connect(Button, `${FILE}?node-id=7-101`, {
  variant: { Style: 'Ghost' },
  example: () => <Button variant="ghost" size="icon-sm" aria-label="Action" />,
});
