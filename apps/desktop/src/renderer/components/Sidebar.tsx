import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { TuningSquare2, HomeSmile, AddSquare, SlashCircle } from '@solar-icons/react';
import { cn } from '../lib/utils';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useProjectsStore } from '../stores/projects-store';
import { isLoadingStatus } from '../types/project';
import { CoredocLogoIcon } from './icons/CoredocLogo';
import { Spinner } from './ui/spinner';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { useProjectDetailStore } from '../stores/project-detail-store';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const NAV_INDICATOR_HEIGHT = 42;
const WS_INDICATOR_HEIGHT = 20;
const SCROLL_ANIMATION_DELAY = 150;

/* ------------------------------------------------------------------ */
/*  Nav item (Home / Settings)                                         */
/* ------------------------------------------------------------------ */

function NavItem({
  to,
  end,
  dataNav,
  icon: Icon,
  label,
}: {
  to: string;
  end?: boolean;
  dataNav: string;
  icon: typeof HomeSmile;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      data-nav={dataNav}
      className="group relative flex flex-col items-center justify-center gap-0.5 p-2 w-full no-drag"
      title={label}
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'size-6 flex items-center justify-center transition-colors',
              isActive ? 'text-content-secondary' : 'text-content-secondary group-hover:text-content-secondary-hover',
            )}
          >
            <Icon weight={isActive ? 'Bold' : 'Outline'} size={24} />
          </span>
          <span
            className={cn(
              'text-xs leading-4 transition-colors',
              isActive
                ? 'font-medium text-content-secondary'
                : 'font-normal text-content-secondary group-hover:text-content-secondary-hover',
            )}
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}

/* ------------------------------------------------------------------ */
/*  Scroll divider (top / bottom)                                      */
/* ------------------------------------------------------------------ */

function ScrollDivider({
  canScroll,
  widthRatio,
  thick,
  className,
  maxWidth,
}: {
  canScroll: boolean;
  widthRatio: number;
  thick: boolean;
  className?: string;
  maxWidth?: number;
}) {
  const max = maxWidth ?? 60;
  const min = 48;
  return (
    <div className={cn('w-full flex justify-center', className)}>
      <div
        className={cn(
          'rounded-[10px] transition-all duration-150',
          thick ? 'h-[2px] bg-content-secondary' : 'h-px bg-border-tertiary',
        )}
        style={{ width: canScroll ? `${min + (max - min) * widthRatio}px` : `${min}px` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */

export function Sidebar() {
  const { projects } = useProjectsStore();
  const activeDetailProjectId = useProjectDetailStore((s) => s.projectId);
  const activeDetailRunningCount = useProjectDetailStore((s) => s.runningCommands.size);
  const navigate = useNavigate();
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [scrollRatio, setScrollRatio] = useState(0);
  const [canScroll, setCanScroll] = useState(false);
  const [topThick, setTopThick] = useState(false);
  const [bottomThick, setBottomThick] = useState(false);
  const [indicatorTop, setIndicatorTop] = useState(0);
  const [indicatorHeight, setIndicatorHeight] = useState(NAV_INDICATOR_HEIGHT);
  const [showIndicator, setShowIndicator] = useState(false);
  const [animateIndicator, setAnimateIndicator] = useState(false);

  const isSettingsActive = location.pathname === '/settings';
  const projectMatch = location.pathname.match(/^\/project\/(.+)/);
  const activeProjectId = projectMatch?.[1] ? decodeURIComponent(projectMatch[1]) : null;

  /* ---- Scroll state ---- */

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) {
      setCanScroll(false);
      setScrollRatio(0);
      setTopThick(false);
      setBottomThick(false);
      return;
    }

    setCanScroll(true);
    setScrollRatio(el.scrollTop / maxScroll);

    const activeEl = el.querySelector('[data-active-workspace="true"]') as HTMLElement | null;
    if (!activeEl) {
      setTopThick(false);
      setBottomThick(false);
      return;
    }

    const containerRect = el.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    setTopThick(activeRect.bottom < containerRect.top);
    setBottomThick(activeRect.top > containerRect.bottom);
  }, []);

  /* ---- Active indicator position ---- */

  const updateActiveIndicator = useCallback(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;

    const activeEl: HTMLElement | null = isSettingsActive
      ? sidebar.querySelector('[data-nav="settings"]')
      : activeProjectId
        ? sidebar.querySelector('[data-active-workspace="true"]')
        : sidebar.querySelector('[data-nav="home"]');

    if (!activeEl) {
      setShowIndicator(false);
      return;
    }

    // Hide indicator if workspace item is scrolled out of view
    if (activeProjectId && !isSettingsActive && scrollRef.current) {
      const scrollRect = scrollRef.current.getBoundingClientRect();
      const activeRect = activeEl.getBoundingClientRect();
      if (activeRect.bottom < scrollRect.top || activeRect.top > scrollRect.bottom) {
        setShowIndicator(false);
        return;
      }
    }

    const sidebarRect = sidebar.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const isWorkspace = !!activeProjectId && !isSettingsActive;
    const h = isWorkspace ? WS_INDICATOR_HEIGHT : NAV_INDICATOR_HEIGHT;
    const top = activeRect.top - sidebarRect.top + (activeRect.height - h) / 2;

    setIndicatorTop(top);
    setIndicatorHeight(h);
    setShowIndicator(true);
  }, [isSettingsActive, activeProjectId, projects]);

  /* ---- Effects ---- */

  // Set position without animation on mount or when projects change
  useLayoutEffect(() => {
    updateActiveIndicator();
  }, [updateActiveIndicator, projects]);

  // Enable animation after initial position
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimateIndicator(true));
    return () => {
      cancelAnimationFrame(frame);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, []);

  // Animate on route changes
  useEffect(() => {
    setAnimateIndicator(true);
  }, []);

  // Handle scroll: disable animation during scroll, re-enable after pause
  const handleScroll = useCallback(() => {
    setAnimateIndicator(false);
    updateScrollState();
    updateActiveIndicator();

    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      setAnimateIndicator(true);
    }, SCROLL_ANIMATION_DELAY);
  }, [updateScrollState, updateActiveIndicator]);

  // Observe resize changes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();

    const ro = new ResizeObserver(() => {
      updateScrollState();
      updateActiveIndicator();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScrollState, updateActiveIndicator]);

  /* ---- Render ---- */

  return (
    <aside ref={sidebarRef} className="w-[72px] shrink-0 flex flex-col items-start relative">
      {/* Active indicator bar */}
      <span
        className={cn(
          'absolute left-[1px] w-[3px] bg-content-secondary',
          animateIndicator && 'transition-all duration-300 ease-out',
        )}
        style={{
          top: indicatorTop,
          height: indicatorHeight,
          opacity: showIndicator ? 1 : 0,
        }}
      />

      {/* Logo */}
      <div className="flex flex-col items-center justify-center w-full pt-3 pb-3 px-2">
        <div className="h-8 flex items-center justify-center p-1.5 no-drag">
          <CoredocLogoIcon className="size-5" />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center w-full overflow-hidden">
        {/* Home + top divider */}
        <div className="flex flex-col gap-0.5 items-start w-full">
          <NavItem to="/" end dataNav="home" icon={HomeSmile} label="Home" />
          <ScrollDivider canScroll={canScroll} widthRatio={scrollRatio} thick={topThick} maxWidth={60} />
        </div>

        {/* Scrollable workspace list */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 flex flex-col gap-1.5 items-center w-full overflow-y-auto pt-2 pb-1 scrollbar-hide"
        >
          {/* Add workspace */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="group relative flex flex-col items-center justify-center p-2 rounded-sm w-[72px] shrink-0 no-drag"
                onClick={() => window.dispatchEvent(new CustomEvent('open-add-workspace'))}
              >
                <AddSquare
                  size={20}
                  className="text-content-secondary group-hover:text-content-secondary-hover transition-colors"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              sideOffset={-14}
              className="bg-bg-inverted-secondary text-white border-0 shadow-none rounded-md px-1 py-0.5 text-xs font-normal leading-4"
            >
              Create new
            </TooltipContent>
          </Tooltip>

          {/* Workspace items */}
          <div className="flex flex-col gap-1.5 w-full">
            {projects.map((project) => {
              const isActive = activeProjectId === project.id;
              const isMember = !!project.cloudMember;
              const isCloudOwner = !!project.cloud?.enabled && !isMember;
              const isLocalProject = !!project.wizardCompleted && !project.cloud?.enabled && !isMember;
              const isAnyRepoBusy =
                activeDetailProjectId === project.id
                  ? activeDetailRunningCount > 0
                  : project.repositories.some((repo) => isLoadingStatus(repo.status));
              const dotColor = isMember
                ? 'bg-dodger-blue-400'
                : isCloudOwner
                  ? 'bg-dodger-blue-500'
                  : isLocalProject
                    ? 'bg-emerald-500'
                    : 'bg-zinc-600';
              return (
                <Tooltip key={project.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-active-workspace={isActive}
                      className="group/ws relative flex flex-col items-center justify-center px-2 py-1 rounded-sm w-[72px] no-drag"
                      onClick={() => navigate(`/project/${encodeURIComponent(project.id)}`)}
                    >
                      <SlashCircle
                        weight={isActive ? 'Bold' : 'Outline'}
                        size={20}
                        className={cn(
                          'rounded-[5px] transition-colors',
                          isActive
                            ? 'text-content-secondary'
                            : 'text-content-secondary group-hover/ws:text-content-secondary-hover',
                        )}
                      />
                      {/* Workspace type mini-dot or loading spinner */}
                      {isAnyRepoBusy ? (
                        <span
                          className="absolute size-3 rounded-full bg-zinc-50 flex items-center justify-center"
                          style={{ left: 37, top: 15 }}
                        >
                          <Spinner className={cn('size-2.5', dotColor.replace('bg-', 'text-'))} />
                        </span>
                      ) : (
                        <span
                          className={cn(
                            'absolute size-2 rounded-full border border-zinc-50 flex items-center justify-center',
                            dotColor,
                          )}
                          style={{ left: 39, top: 17 }}
                        >
                          {isMember && <span className="size-0.5 rounded-full bg-content-inverted" />}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  {!isActive && (
                    <TooltipContent
                      side="right"
                      sideOffset={-14}
                      className="bg-bg-inverted-secondary text-white border-0 shadow-none rounded-md px-1 py-0.5 text-xs font-normal leading-4"
                    >
                      {project.name}
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer — bottom divider + Settings */}
      <div className={cn('w-full flex flex-col pb-2', projects.length > 0 && canScroll ? 'gap-2' : 'gap-0')}>
        {projects.length > 0 && canScroll && (
          <ScrollDivider canScroll={canScroll} widthRatio={1 - scrollRatio} thick={bottomThick} maxWidth={60} />
        )}
        <NavItem to="/settings" dataNav="settings" icon={TuningSquare2} label="Settings" />
      </div>
    </aside>
  );
}
