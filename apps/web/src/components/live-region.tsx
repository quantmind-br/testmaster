import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type Announcer, createAnnouncer } from "../lib/announcer";

const AnnouncerContext = createContext<Announcer | null>(null);

/**
 * One polite, atomic live region for the whole app. It never moves focus and coalesces bursts of
 * messages (see lib/announcer.ts). Components announce through `useAnnounce()`.
 */
export function LiveRegionProvider({ children }: { children: ReactNode }): ReactNode {
  const announcer = useMemo(() => createAnnouncer(), []);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const unsubscribe = announcer.subscribe(setMessage);
    return () => {
      unsubscribe();
      announcer.dispose();
    };
  }, [announcer]);
  return (
    <AnnouncerContext.Provider value={announcer}>
      {children}
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="live-region"
      >
        {message}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnounce(): (message: string) => void {
  const announcer = useContext(AnnouncerContext);
  return (message) => announcer?.announce(message);
}
