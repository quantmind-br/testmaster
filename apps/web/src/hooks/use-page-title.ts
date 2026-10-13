import { useEffect } from "react";

export const siteName = "TestMaster";

/** Sets `document.title`; the shell announces it after each navigation. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} — ${siteName}`;
  }, [title]);
}
