import type { ReactNode } from "react";
import { Button, Heading, ProgressCircle, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useAuth } from "../contexts/AuthContext";

const wrapper = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "[100vh]",
  gap: 16,
  padding: 24,
});

const ADOBE_RED = "#e1251b";

export function AuthGate({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, isApiReady, authError, signIn } = useAuth();

  const showGate = isLoading || !isAuthenticated || !isApiReady;

  if (!showGate) return <>{children}</>;

  if (isLoading || (isAuthenticated && !isApiReady && !authError)) {
    return (
      <div className={wrapper}>
        <Heading level={2}>
          <span style={{ color: ADOBE_RED }}>PIM</span>
        </Heading>
        <ProgressCircle aria-label="Loading" isIndeterminate />
        <Text>Checking access…</Text>
      </div>
    );
  }

  const isNetworkError = authError === "network";
  const message = isNetworkError
    ? "Unable to reach the PIM server. Check your connection and retry."
    : "Sign in with your Adobe account to continue.";
  const actionLabel = isNetworkError ? "Retry" : "Sign in with Adobe";

  return (
    <div className={wrapper}>
      <Heading level={2}>
        <span style={{ color: ADOBE_RED }}>PIM</span>
      </Heading>
      <Text>{message}</Text>
      <Button variant="accent" onPress={signIn}>
        {actionLabel}
      </Button>
    </div>
  );
}
