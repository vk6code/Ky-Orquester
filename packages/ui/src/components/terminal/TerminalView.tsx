import React, { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useApi } from "../../context/orquester-context";
import { useIsDesktop } from "../../hooks";
import type { SessionSummary } from "../../types";

const FONT_STACK =
  '"JetBrains Mono", "Cascadia Code", "Fira Code", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';

// Standard 16-colour ANSI palette tuned for a dark, neutral background so
// CLIs/TUIs render with the colours they expect (not washed-out grays).
const THEME: ITheme = {
  background: "#0a0a0a",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#3f3f46",
  black: "#1c1c1c",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa"
};

/**
 * xterm.js view bound to a daemon session. Keystrokes (including control codes
 * like Ctrl-C `\x03`) are forwarded as input; the session's output stream is
 * replayed (current buffer) then streamed live. The PTY lives in the daemon,
 * so unmounting this view does not kill the session.
 *
 * Mobile-specific handling:
 * - WebGL renderer is skipped on small viewports to avoid black screens after
 *   the app returns from background.
 * - The stream is re-opened if it closes while the tab is visible, so users
 *   don't lose live output after switching apps.
 * - A resize/fit is forced when the page becomes visible again.
 */
export const TerminalView: React.FC<{ session: SessionSummary; active?: boolean }> = ({
  session,
  active = true
}) => {
  const api = useApi();
  const isDesktop = useIsDesktop();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputSubRef = useRef<{ dispose: () => void } | null>(null);
  const closingRef = useRef(false);
  // Set by the mount effect so the visibility effect below can re-fit and force
  // a repaint without re-running the (expensive) terminal setup.
  const redrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    closingRef.current = false;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: FONT_STACK,
      fontSize: 13,
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 8000,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      theme: THEME
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(container);

    // Use WebGL only on desktop; mobile GPU contexts are often dropped when the
    // app goes to background, leaving a black/blank terminal on resume.
    if (isDesktop) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* keep the default canvas/DOM renderer */
      }
    }

    const applyFit = () => {
      if (!fitRef.current || !termRef.current) return;
      try {
        fitRef.current.fit();
      } catch {
        /* container not measurable yet */
      }
      void api.resizeSession(session.id, termRef.current.cols, termRef.current.rows);
    };
    applyFit();
    term.focus();

    // Re-fit and force a full repaint. xterm keeps a stale frame while its
    // container is display:none (especially with the WebGL renderer), so when a
    // hidden tab is shown again we must explicitly redraw — a same-size fit()
    // alone does not trigger one.
    redrawRef.current = () => {
      const t = termRef.current;
      if (!t) return;
      applyFit();
      t.refresh(0, t.rows - 1);
      t.focus();
    };

    inputSubRef.current = term.onData((data) => {
      void api.sendSessionInput(session.id, data);
    });

    const resizeObserver = new ResizeObserver(() => applyFit());
    resizeObserver.observe(container);

    let stream = openStream();

    function openStream() {
      // Per-stream guard: once this stream is closed (cleanup, reconnect, or a
      // StrictMode remount) its callbacks must NOT write to termRef anymore.
      // termRef is shared across stream instances, so a lingering old stream
      // would otherwise double every byte written to the current terminal.
      let active = true;
      const handle = api.openSessionOutput(session.id, {
        onData: (chunk) => {
          if (active && termRef.current) {
            termRef.current.write(chunk);
          }
        },
        onEnd: () => {
          if (!active) {
            return;
          }
          if (termRef.current) {
            termRef.current.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
          }
          // Reconnect if the view is still mounted and visible (e.g. browser
          // throttled/killed the connection while in background).
          if (!closingRef.current && !document.hidden && termRef.current) {
            setTimeout(() => {
              if (!closingRef.current && !document.hidden && termRef.current) {
                stream = openStream();
              }
            }, 500);
          }
        }
      });
      return {
        close: () => {
          active = false;
          handle.close();
        }
      };
    }

    const handleVisibility = () => {
      if (!document.hidden) {
        requestAnimationFrame(() => {
          applyFit();
          termRef.current?.focus();
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      closingRef.current = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      stream.close();
      inputSubRef.current?.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      redrawRef.current = null;
    };
  }, [api, session.id, isDesktop]);

  // When this terminal's tab becomes the active one it transitions from
  // display:none to visible. Force a re-fit + repaint on the next frame (once
  // the container is actually laid out) so the view isn't left showing a stale
  // frame after switching tabs.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => redrawRef.current?.());
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-[#0a0a0a] p-2" />;
};
