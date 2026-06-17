import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useApi } from "../../context/orquester-context";
import type { SessionSummary } from "../../types";

/**
 * xterm.js view bound to a daemon session. Keystrokes (including control codes
 * like Ctrl-C `\x03`) are forwarded as input; the session's output stream is
 * replayed (current buffer) then streamed live. The PTY lives in the daemon,
 * so unmounting this view does not kill the session.
 */
export const TerminalView: React.FC<{ session: SessionSummary }> = ({ session }) => {
  const api = useApi();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#0a0a0a",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#3f3f46"
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    const applyFit = () => {
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
      void api.resizeSession(session.id, term.cols, term.rows);
    };
    applyFit();

    const inputSub = term.onData((data) => {
      void api.sendSessionInput(session.id, data);
    });

    const resizeObserver = new ResizeObserver(() => applyFit());
    resizeObserver.observe(container);

    const stream = api.openSessionOutput(session.id, {
      onData: (chunk) => term.write(chunk),
      onEnd: () => term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n")
    });

    return () => {
      stream.close();
      inputSub.dispose();
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [api, session.id]);

  return <div ref={containerRef} className="h-full w-full bg-[#0a0a0a] p-1" />;
};
