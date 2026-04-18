import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { setOrgSlugGetter } from "../services/api";
import { useAuth, type MeOrgSummary } from "./AuthContext";

const ORG_STORAGE_KEY = "pim.currentOrgSlug";

export interface OrgContextValue {
  currentOrg: MeOrgSummary | null;
  orgs: MeOrgSummary[];
  setCurrentOrg: (slug: string) => void;
  hasNoOrgs: boolean;
}

const OrgContext = createContext<OrgContextValue | undefined>(undefined);

function readStoredSlug(): string | null {
  try {
    return window.localStorage.getItem(ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredSlug(slug: string | null): void {
  try {
    if (slug) window.localStorage.setItem(ORG_STORAGE_KEY, slug);
    else window.localStorage.removeItem(ORG_STORAGE_KEY);
  } catch {
    // ignore quota / private-mode failures
  }
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const { orgs, isAuthenticated } = useAuth();
  const [currentSlug, setCurrentSlug] = useState<string | null>(() => readStoredSlug());

  // When the org list changes (fresh login, invite accepted, etc.), reconcile
  // the stored slug: drop it if the user is no longer a member, fall back to
  // the first org if nothing is selected.
  useEffect(() => {
    if (!isAuthenticated || orgs.length === 0) {
      if (currentSlug !== null) {
        setCurrentSlug(null);
        writeStoredSlug(null);
      }
      return;
    }
    const stillMember = currentSlug && orgs.some((o) => o.slug === currentSlug);
    if (!stillMember) {
      const next = orgs[0].slug;
      setCurrentSlug(next);
      writeStoredSlug(next);
    }
  }, [isAuthenticated, orgs, currentSlug]);

  const slugRef = useRef<string | null>(currentSlug);
  slugRef.current = currentSlug;

  useEffect(() => {
    setOrgSlugGetter(() => slugRef.current);
    return () => setOrgSlugGetter(null);
  }, []);

  const setCurrentOrg = useCallback(
    (slug: string) => {
      if (!orgs.some((o) => o.slug === slug)) return;
      setCurrentSlug(slug);
      writeStoredSlug(slug);
    },
    [orgs],
  );

  const currentOrg = useMemo(
    () => orgs.find((o) => o.slug === currentSlug) ?? null,
    [orgs, currentSlug],
  );

  const value = useMemo<OrgContextValue>(
    () => ({
      currentOrg,
      orgs,
      setCurrentOrg,
      hasNoOrgs: isAuthenticated && orgs.length === 0,
    }),
    [currentOrg, orgs, setCurrentOrg, isAuthenticated],
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used within <OrgProvider>");
  return ctx;
}
