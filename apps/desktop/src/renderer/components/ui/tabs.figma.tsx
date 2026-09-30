import figma from '@figma/code-connect';
import { Tabs, TabsList, TabsTrigger } from './tabs';

const FILE = 'https://www.figma.com/design/idOJ0ISbJdYW9gzw1w4tr0/Coredoc-UI-Library';

// The white pill behind the active trigger is a sliding indicator rendered by
// TabsList variant="pill"; triggers carry no per-state props in code.
figma.connect(TabsTrigger, `${FILE}?node-id=12-10`, {
  variant: { Style: 'Pill' },
  props: { label: figma.string('Label') },
  example: ({ label }) => (
    <Tabs defaultValue="tab">
      <TabsList variant="pill">
        <TabsTrigger value="tab">{label}</TabsTrigger>
      </TabsList>
    </Tabs>
  ),
});

figma.connect(TabsTrigger, `${FILE}?node-id=12-10`, {
  variant: { Style: 'Underline' },
  props: { label: figma.string('Label') },
  example: ({ label }) => (
    <Tabs defaultValue="tab">
      <TabsList variant="underline">
        <TabsTrigger value="tab">{label}</TabsTrigger>
      </TabsList>
    </Tabs>
  ),
});
