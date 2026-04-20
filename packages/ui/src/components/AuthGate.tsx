import type { ReactNode } from "react";
import {
  Button,
  CustomDialog,
  DialogContainer,
  Heading,
  ProgressCircle,
  Text,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import LockClose from "@react-spectrum/s2/illustrations/gradient/generic2/LockClose";
import { useAuth } from "../contexts/AuthContext";

const gateBg = new URL("../assets/gate-bg.png", import.meta.url).href;

const ADOBE_RED = "#e1251b";

const gateCustomLayout = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  rowGap: 16,
  width: "full",
  boxSizing: "border-box",
});

const gateTitle = style({
  font: "heading-lg",
  textAlign: "center",
  marginY: 0,
});

function GateDialogShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Full-bleed background image */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 499,
          backgroundImage: `url(${gateBg})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      {/* Blur + dark overlay */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 500,
          backgroundColor: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(4px)",
        }}
      />
      <DialogContainer onDismiss={() => {}}>{children}</DialogContainer>
    </>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, isApiReady, authError, signIn } = useAuth();

  const showGate = isLoading || !isAuthenticated || !isApiReady;

  if (!showGate) return <>{children}</>;

  const isNetworkError = authError === "network";

  return (
    <GateDialogShell>
      <CustomDialog
        size="M"
        isDismissible={false}
        isKeyboardDismissDisabled
        role={isLoading ? "dialog" : "alertdialog"}
      >
        <div className={gateCustomLayout}>
          <Heading slot="title" styles={gateTitle}>
            <span style={{ color: ADOBE_RED }}>PIM</span>
          </Heading>

          {isLoading || (isAuthenticated && !isApiReady && !authError) ? (
            <>
              <ProgressCircle size="L" isIndeterminate aria-label="Checking access" />
              <Text styles={style({ font: "body", textAlign: "center" })}>
                Checking access…
              </Text>
            </>
          ) : (
            <>
              {/* @ts-expect-error LockClose supports size prop at runtime; d.ts lists IconProps only */}
              <LockClose aria-hidden size="L" />
              <Text
                styles={style({
                  font: "body",
                  textAlign: "center",
                  maxWidth: "[420px]",
                })}
              >
                {isNetworkError
                  ? "Unable to reach the PIM server. Check your connection and retry."
                  : "Sign in with your Adobe account to continue."}
              </Text>
              <Button variant="accent" onPress={signIn}>
                {isNetworkError ? "Retry" : "Sign in with Adobe"}
              </Button>
            </>
          )}
        </div>
      </CustomDialog>
    </GateDialogShell>
  );
}
