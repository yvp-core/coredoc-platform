import figma from '@figma/code-connect';
import { Button } from './button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './dialog';

const FILE = 'https://www.figma.com/design/idOJ0ISbJdYW9gzw1w4tr0/Coredoc-UI-Library';

// The single source of the modal surface (DESIGN.md modal pattern): Surface A
// panel, border-tertiary, rounded-xl, 480 width; footer = Cancel (variant
// "secondary", per DESIGN.md and every shipped dialog) then the primary action.
figma.connect(DialogContent, `${FILE}?node-id=15-2`, {
  props: {
    title: figma.string('Title'),
    description: figma.string('Description'),
  },
  example: ({ title, description }) => (
    <Dialog>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>{/* body content */}</DialogBody>
        <DialogFooter>
          <Button variant="secondary">Cancel</Button>
          <Button>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
});
