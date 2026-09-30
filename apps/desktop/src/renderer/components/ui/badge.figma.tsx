import { DangerTriangle } from '@solar-icons/react';
import figma from '@figma/code-connect';
import { Badge } from './badge';
import { Spinner } from './spinner';

const FILE = 'https://www.figma.com/design/idOJ0ISbJdYW9gzw1w4tr0/Coredoc-UI-Library';

figma.connect(Badge, `${FILE}?node-id=8-58`, {
  props: {
    label: figma.string('Label'),
    variant: figma.enum('Variant', {
      Initial: 'initial',
      Success: 'success',
      Warning: 'warning',
      Error: 'error',
      Info: 'info',
      'Outline Initial': 'outlineInitial',
      'Outline Success': 'outlineSuccess',
      'Outline Info': 'outlineInfo',
    }),
  },
  example: ({ label, variant }) => <Badge variant={variant}>{label}</Badge>,
});

// Status Chip = Badge + status icon, produced by getBadge() in RepoStateBadge.tsx.
figma.connect(Badge, `${FILE}?node-id=8-89`, {
  variant: { Status: 'Updating' },
  props: { label: figma.string('Label') },
  example: ({ label }) => (
    <Badge variant="info" className="shrink-0">
      <Spinner />
      {label}
    </Badge>
  ),
});

figma.connect(Badge, `${FILE}?node-id=8-89`, {
  variant: { Status: 'Warning' },
  props: { label: figma.string('Label') },
  example: ({ label }) => (
    <Badge variant="warning" className="shrink-0">
      <DangerTriangle weight="Bold" className="text-content-tag-warning" />
      {label}
    </Badge>
  ),
});

figma.connect(Badge, `${FILE}?node-id=8-89`, {
  variant: { Status: 'Not started' },
  props: { label: figma.string('Label') },
  example: ({ label }) => (
    <Badge variant="initial" className="shrink-0">
      <span className="text-xs leading-4 text-content-secondary w-3 text-center">•</span>
      {label}
    </Badge>
  ),
});
