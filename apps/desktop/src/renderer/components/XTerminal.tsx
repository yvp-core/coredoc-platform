import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface XTerminalProps {
  repoName: string;
  activeCommandIds: Set<string>;
  clearCounter: number;
  isVisible: boolean;
}

export function XTerminal({ activeCommandIds, clearCounter, isVisible }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const knownCommandIdsRef = useRef<Set<string>>(new Set());
  const cleanupPtyDataRef = useRef<(() => void) | null>(null);
  const cleanupPtyExitRef = useRef<(() => void) | null>(null);
  const prevClearCounterRef = useRef(clearCounter);

  // Accumulate command IDs across generate→parse chaining
  useEffect(() => {
    for (const id of activeCommandIds) {
      knownCommandIdsRef.current.add(id);
    }
  }, [activeCommandIds]);

  // Initialize terminal once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const styles = getComputedStyle(document.documentElement);
    const getVar = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      fontWeight: '300',
      lineHeight: 1,
      letterSpacing: 0,
      theme: {
        background: getVar('--color-bg-inverted', '#3f3f46'),
        foreground: getVar('--color-content-inverted', '#ffffff'),
        cursor: getVar('--color-content-inverted', '#ffffff'),
        selectionBackground: getVar('--color-border-inverted', '#52525b'),
      },
      convertEol: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    // Initial fit
    try {
      fitAddon.fit();
    } catch {
      // Container may not be sized yet
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // A drawer width switch fires the observer on every intermediate layout,
    // and each fit() reflows the whole grid.
    // Coalescing to one fit per frame keeps the switch instantaneous.
    let fitFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (fitFrame) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = 0;
        try {
          fitAddon.fit();
        } catch {
          // Ignore fit errors
        }
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (fitFrame) cancelAnimationFrame(fitFrame);
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []); // Mount once

  // Subscribe to PTY data and exit events
  useEffect(() => {
    // Clean up previous listeners
    cleanupPtyDataRef.current?.();
    cleanupPtyExitRef.current?.();

    const unsubData = window.electronAPI.onPtyData((ptyData) => {
      if (knownCommandIdsRef.current.has(ptyData.id)) {
        terminalRef.current?.write(ptyData.data);
      }
    });

    const unsubExit = window.electronAPI.onPtyExit((ptyExit) => {
      if (knownCommandIdsRef.current.has(ptyExit.id)) {
        // Optionally write exit info
        const code = ptyExit.exitCode;
        const msg =
          code === 0
            ? '\r\n\x1b[32m[Process exited successfully]\x1b[0m\r\n'
            : `\r\n\x1b[31m[Process exited with code ${code}]\x1b[0m\r\n`;
        terminalRef.current?.write(msg);
      }
    });

    cleanupPtyDataRef.current = unsubData;
    cleanupPtyExitRef.current = unsubExit;

    return () => {
      unsubData();
      unsubExit();
    };
  }, []);

  // Handle clear counter changes
  useEffect(() => {
    if (clearCounter > prevClearCounterRef.current) {
      terminalRef.current?.reset();
      knownCommandIdsRef.current.clear();
    }
    prevClearCounterRef.current = clearCounter;
  }, [clearCounter]);

  // Re-fit when visibility changes (tab switch)
  useEffect(() => {
    if (isVisible && fitAddonRef.current) {
      // Small delay to let layout settle
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
        } catch {
          // Ignore
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible]);

  return <div ref={containerRef} className="flex-1 min-h-0" style={{ height: '100%' }} />;
}
