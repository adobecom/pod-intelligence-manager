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
import { imsAuthService, type PimIms } from "../services/imsAuth";
import { env } from "../config/env";
import { apiFetch, setAuthTokenGetter } from "../services/api";

export interface MeOrgSummary {
  org_id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "member";
  created_at: string;
}

export interface MeUser {
  user_id: string;
  email: string;
  display_name: string | null;
  ims_user_id: string | null;
}

export interface MePendingInvite {
  invite_id: string;
  org_slug: string;
  org_name: string;
  role: "admin" | "member";
  created_at: string;
}

interface MePayload {
  user: MeUser;
  orgs: MeOrgSummary[];
  pending_invites?: MePendingInvite[];
}

export interface AuthContextValue {
  ims: PimIms | null;
  user: MeUser | null;
  orgs: MeOrgSummary[];
  pendingInvites: MePendingInvite[];
  isAuthenticated: boolean;
  isLoading: boolean;
  isApiReady: boolean;
  authError: string | null;
  signIn: () => void;
  signOut: () => void;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const TRUST_IMS: PimIms = {
  token: "dev",
  profile: { email: "dev@local", name: "Local Dev" },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ims, setIms] = useState<PimIms | null>(env.authMode === "trust" ? TRUST_IMS : null);
  const [user, setUser] = useState<MeUser | null>(null);
  const [orgs, setOrgs] = useState<MeOrgSummary[]>([]);
  const [pendingInvites, setPendingInvites] = useState<MePendingInvite[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(env.authMode === "ims");
  const [isApiReady, setIsApiReady] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const imsRef = useRef<PimIms | null>(ims);
  imsRef.current = ims;

  useEffect(() => {
    setAuthTokenGetter(() => imsRef.current?.token ?? null);
    return () => setAuthTokenGetter(null);
  }, []);

  const fetchMe = useCallback(async (): Promise<void> => {
    const res = await apiFetch("/api/me");
    if (!res.ok) {
      setIsApiReady(false);
      setAuthError(res.status === 401 ? "auth" : "network");
      return;
    }
    const payload = (await res.json()) as MePayload;
    setUser(payload.user);
    setOrgs(payload.orgs);
    setPendingInvites(payload.pending_invites ?? []);
    setAuthError(null);
    setIsApiReady(true);
  }, []);

  useEffect(() => {
    if (env.authMode === "trust") {
      fetchMe().catch(() => {
        /* handled via authError */
      });
      return;
    }

    setIsLoading(true);
    imsAuthService
      .initialize((received) => {
        setIms(received);
        setIsLoading(false);
      })
      .then(() => imsAuthService.getCurrentIms())
      .then((current) => {
        if (current) setIms(current);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("IMS initialization failed", err);
        setIsLoading(false);
      });

    const unsubscribe = imsAuthService.onAuthStateChange((updated) => {
      setIms(updated);
      if (!updated) {
        setUser(null);
        setOrgs([]);
        setPendingInvites([]);
        setIsApiReady(false);
      }
    });

    return unsubscribe;
  }, [fetchMe]);

  useEffect(() => {
    if (!ims?.token) {
      setIsApiReady(false);
      return;
    }
    let cancelled = false;
    fetchMe().catch(() => {
      if (!cancelled) setAuthError("network");
    });
    return () => {
      cancelled = true;
    };
  }, [ims?.token, fetchMe]);

  const signIn = useCallback(() => {
    if (env.authMode === "trust") return;
    imsAuthService.signIn();
  }, []);

  const signOut = useCallback(() => {
    if (env.authMode === "trust") return;
    imsAuthService.signOut();
    setIms(null);
    setUser(null);
    setOrgs([]);
    setPendingInvites([]);
    setIsApiReady(false);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ims,
      user,
      orgs,
      pendingInvites,
      isAuthenticated: Boolean(ims?.token),
      isLoading,
      isApiReady,
      authError,
      signIn,
      signOut,
      refreshMe: fetchMe,
    }),
    [ims, user, orgs, pendingInvites, isLoading, isApiReady, authError, signIn, signOut, fetchMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
