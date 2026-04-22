import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, Heading, InlineAlert, ProgressCircle, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { acceptInvite } from "../../services/api";
import { useAuth } from "../../contexts/AuthContext";

const wrapper = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "[100vh]",
  gap: 16,
  padding: 24,
});

export function AcceptInvite() {
  const { inviteId } = useParams<{ inviteId: string }>();
  const navigate = useNavigate();
  const { refreshMe } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inviteId) return;
    acceptInvite(inviteId)
      .then(async () => {
        await refreshMe();
        navigate("/org", { replace: true });
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to accept invite");
      });
  }, [inviteId]);

  return (
    <div className={wrapper}>
      <Heading level={2}>Accepting invite…</Heading>
      {!error && <ProgressCircle isIndeterminate aria-label="Accepting invite" />}
      {error && (
        <>
          <InlineAlert variant="negative">{error}</InlineAlert>
          <Text>The invite may have already been used or revoked.</Text>
          <Button variant="secondary" onPress={() => navigate("/org", { replace: true })}>
            Go to dashboard
          </Button>
        </>
      )}
    </div>
  );
}
