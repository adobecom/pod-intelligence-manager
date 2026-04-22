import { useEffect, useState, type ReactNode } from "react";
import { Heading, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useAuth } from "../contexts/AuthContext";
import { useOrg } from "../contexts/OrgContext";
import { CreateOrgModal } from "../views/CreateOrg/CreateOrgModal";
import { PendingInvitesBanner } from "./PendingInvitesBanner";

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

export function OrgGate({ children }: { children: ReactNode }) {
  const { hasNoOrgs, currentOrg } = useOrg();
  const { pendingInvites } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);

  // Let the /accept/:inviteId route render directly — it handles its own state.
  if (window.location.pathname.startsWith("/accept/")) return <>{children}</>;

  // Only open the "Create first org" modal when there are zero orgs AND zero
  // pending invites — otherwise the PendingInvitesBanner takes precedence.
  useEffect(() => {
    if (hasNoOrgs && pendingInvites.length === 0) setModalOpen(true);
    else setModalOpen(false);
  }, [hasNoOrgs, pendingInvites.length]);

  if (hasNoOrgs && pendingInvites.length > 0) {
    return <PendingInvitesBanner />;
  }

  if (hasNoOrgs) {
    return (
      <>
        <div className={wrapper}>
          <Heading level={2}>
            <span style={{ color: ADOBE_RED }}>PIM</span>
          </Heading>
          <Text>You're not a member of any org yet. Create one to get started.</Text>
        </div>
        <CreateOrgModal isOpen={modalOpen} onOpenChange={setModalOpen} required />
      </>
    );
  }

  // Wait for the OrgProvider to finish reconciling the stored slug with the
  // /api/me org list before rendering the app (prevents a flash of "no org").
  if (!currentOrg) {
    return (
      <div className={wrapper}>
        <Text>Loading org…</Text>
      </div>
    );
  }

  return <>{children}</>;
}
