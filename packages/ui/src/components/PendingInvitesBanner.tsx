import { useState } from "react";
import { Button, Heading, InlineAlert, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { acceptInvite } from "../services/api";
import { useAuth } from "../contexts/AuthContext";
import { useOrg } from "../contexts/OrgContext";

const wrapper = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "[100vh]",
  gap: 16,
  padding: 24,
});

const card = style({
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 16,
  borderStyle: "solid",
  borderWidth: 1,
  borderColor: "gray-200",
  borderRadius: "default",
  maxWidth: 480,
});

const row = style({
  display: "flex",
  alignItems: "center",
  gap: 12,
});

const grow = style({ flexGrow: 1 });

/**
 * Surfaces pending invites for users who have zero orgs. Once a user accepts
 * an invite they enter the app normally; decline just refreshes /api/me so
 * the UI drops back to the "Create your first org" state.
 */
export function PendingInvitesBanner() {
  const { pendingInvites, refreshMe } = useAuth();
  const { setCurrentOrg } = useOrg();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async (inviteId: string, slug: string) => {
    setBusy(inviteId);
    setError(null);
    try {
      await acceptInvite(inviteId);
      await refreshMe();
      setCurrentOrg(slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to accept invite");
    } finally {
      setBusy(null);
    }
  };

  if (pendingInvites.length === 0) return null;

  return (
    <div className={wrapper}>
      <Heading level={2}>Pending invites</Heading>
      <Text>You've been invited to join these orgs:</Text>
      {error && <InlineAlert variant="negative">{error}</InlineAlert>}
      {pendingInvites.map((i) => (
        <div key={i.invite_id} className={card}>
          <div className={row}>
            <div className={grow}>
              <Heading level={4}>{i.org_name}</Heading>
              <Text>Role: {i.role}</Text>
            </div>
            <Button
              variant="accent"
              onPress={() => accept(i.invite_id, i.org_slug)}
              isDisabled={busy !== null}
            >
              {busy === i.invite_id ? "Accepting…" : "Accept"}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
