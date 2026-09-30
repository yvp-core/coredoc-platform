import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '../../lib/utils';

type TabsListVariant = 'default' | 'line' | 'pill' | 'underline';

const TabsListVariantContext = React.createContext<TabsListVariant>('default');

function Tabs({ className, orientation = 'horizontal', ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('gap-2 group/tabs flex data-horizontal:flex-col', className)}
      {...props}
    />
  );
}

const tabsListVariants = cva('group/tabs-list text-muted-foreground inline-flex w-fit items-center justify-center', {
  variants: {
    variant: {
      default:
        'rounded-lg p-[3px] group-data-horizontal/tabs:h-8 bg-muted group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col',
      line: 'rounded-none p-[3px] group-data-horizontal/tabs:h-8 gap-1 bg-transparent group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col',
      pill: 'shadow-field rounded-full p-0.5 gap-1 border border-white bg-selago-50 relative',
      underline: 'w-full justify-start gap-2 rounded-none border-b border-border-input bg-transparent p-0',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

function TabsList({
  className,
  variant = 'default',
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = React.useState<{ left: number; width: number }>({ left: 0, width: 0 });

  React.useLayoutEffect(() => {
    if (variant !== 'pill') return;
    const el = listRef.current;
    if (!el) return;

    const update = () => {
      const active = el.querySelector('[data-state="active"]') as HTMLElement | null;
      setIndicator(active ? { left: active.offsetLeft, width: active.offsetWidth } : { left: 0, width: 0 });
    };

    update();

    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(el, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-state'],
      childList: true,
    });

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(el);

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [variant, children]);

  return (
    <TabsListVariantContext.Provider value={variant as TabsListVariant}>
      <TabsPrimitive.List
        ref={listRef}
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(tabsListVariants({ variant }), className)}
        {...props}
      >
        {variant === 'pill' && indicator.width > 0 && (
          <span
            className="absolute rounded-full bg-bg-primary shadow-field pointer-events-none"
            style={{
              top: 2,
              bottom: 2,
              left: indicator.left,
              width: indicator.width,
              transition: 'left 0.25s cubic-bezier(0.34, 1.2, 0.64, 1), width 0.25s cubic-bezier(0.34, 1.2, 0.64, 1)',
            }}
          />
        )}
        {children}
      </TabsPrimitive.List>
    </TabsListVariantContext.Provider>
  );
}

const pillTriggerClass =
  "relative z-10 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-semibold leading-4 text-content-secondary cursor-pointer transition-colors disabled:pointer-events-none disabled:opacity-50 data-[state=inactive]:hover:text-content-primary data-[state=active]:font-extrabold data-[state=active]:text-content-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const underlineTriggerClass =
  "relative -mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-0.5 pt-2 pb-1 text-xs font-semibold leading-4 text-content-secondary cursor-pointer transition-colors disabled:pointer-events-none disabled:opacity-50 data-[state=inactive]:hover:text-content-primary data-[state=active]:border-border-primary-selected data-[state=active]:font-extrabold data-[state=active]:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const defaultTriggerClass =
  "gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium group-data-vertical/tabs:py-[calc(--spacing(1.25))] [&_svg:not([class*='size-'])]:size-3.5 focus-visible:border-input focus-visible:ring-ring/50 focus-visible:outline-ring text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center whitespace-nowrap transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent data-active:bg-background dark:data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 data-active:text-foreground after:bg-foreground after:absolute after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100";

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsListVariantContext);
  const triggerClass =
    variant === 'pill' ? pillTriggerClass : variant === 'underline' ? underlineTriggerClass : defaultTriggerClass;
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn(triggerClass, className)} {...props} />;
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('text-xs/relaxed flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
