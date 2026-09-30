import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const alertVariants = cva(
  'relative flex flex-col gap-0.5 rounded-2xl border px-3 py-3 [&>svg~*]:pl-5 [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-3 [&>svg]:size-4 [&>svg]:text-content-primary',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive: 'border-destructive/50 text-content-warning dark:border-destructive [&>svg]:text-content-warning',
        success: 'border-content-tag-success/50 text-content-tag-success [&>svg]:text-content-tag-success',
        warning: 'border-content-tag-warning/50 text-content-tag-warning [&>svg]:text-content-tag-warning',
        amber: 'bg-info-gradient border-amber-100 text-content-primary',
        info: 'bg-bg-tag-progress border-dodger-blue-50 text-content-primary',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn('font-bold text-sm leading-5 tracking-normal text-content-primary', className)}
      {...props}
    />
  ),
);
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-xs font-medium leading-4 text-content-secondary', className)} {...props} />
  ),
);
AlertDescription.displayName = 'AlertDescription';

const AlertActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center gap-1 pt-1', className)} {...props} />
  ),
);
AlertActions.displayName = 'AlertActions';

export { Alert, AlertTitle, AlertDescription, AlertActions };
