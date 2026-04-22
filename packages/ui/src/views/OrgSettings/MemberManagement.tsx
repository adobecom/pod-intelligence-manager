import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Divider,
  Heading,
  InlineAlert,
  Picker,
  PickerItem,
  ProgressCircle,
  Text,
  TextField,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import {
  getOrgMembers,
  inviteMember,
  revokeInvite,
  updateMemberRole,
  removeMember,
  type OrgMembersResponse,
  type OrgRole,
} from "../../services/api";
import { useAuth } from "../../contexts/AuthContext";
import { useOrg } from "../../contexts/OrgContext";

const page = style({ padding: 24, display: "flex", flexDirection: "column", gap: 24 });
const section = style({ display: "flex", flexDirection: "column", gap: 12 });
const row = style({
  display: "flex",
  alignItems: "center",
  gap: 12,
  paddingY: 8,
});
const grow = style({ flexGrow: 1 });
const form = style({ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" });

function roleVariant(role: OrgRole): "informative" | "positive" | "neutral" {
  if (role === "owner") return "positive";
  if (role === "admin") return "informative";
  return "neutral";
}

export function MemberManagement() {
  const { user } = useAuth();
  const { currentOrg, orgs } = useOrg();
  const [data, setData] = useState<OrgMembersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteBusy, setInviteBusy] = useState(false);

  const slug = currentOrg?.slug;
  const myOrgRecord = orgs.find((o) => o.slug === slug) ?? null;
  const myRole: OrgRole | null = myOrgRecord?.role ?? null;
  const canManage = myRole === "owner" || myRole === "admin";

  const reload = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const next = await getOrgMembers(slug);
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  const submitInvite = async () => {
    if (!slug || !inviteEmail.trim()) return;
    setInviteBusy(true);
    setError(null);
    try {
      await inviteMember(slug, { email: inviteEmail.trim(), role: inviteRole });
      setInviteEmail("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send invite");
    } finally {
      setInviteBusy(false);
    }
  };

  const changeRole = async (userId: string, role: OrgRole) => {
    if (!slug) return;
    setError(null);
    try {
      await updateMemberRole(slug, userId, role);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role");
    }
  };

  const remove = async (userId: string) => {
    if (!slug) return;
    setError(null);
    try {
      await removeMember(slug, userId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove member");
    }
  };

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyInviteLink = (inviteId: string) => {
    const url = `${window.location.origin}/accept/${inviteId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(inviteId);
      setTimeout(() => setCopiedId((prev) => (prev === inviteId ? null : prev)), 2000);
    });
  };

  const revoke = async (inviteId: string) => {
    if (!slug) return;
    setError(null);
    try {
      await revokeInvite(slug, inviteId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke invite");
    }
  };

  if (!currentOrg) {
    return (
      <div className={page}>
        <Text>No org selected.</Text>
      </div>
    );
  }

  return (
    <div className={page}>
      <Heading level={2}>Members — {currentOrg.name}</Heading>

      {error && <InlineAlert variant="negative">{error}</InlineAlert>}

      {canManage && (
        <div className={section}>
          <Heading level={3}>Invite by email</Heading>
          <div className={form}>
            <TextField
              label="Email"
              value={inviteEmail}
              onChange={setInviteEmail}
              isDisabled={inviteBusy}
            />
            <Picker
              label="Role"
              selectedKey={inviteRole}
              onSelectionChange={(key) => key && setInviteRole(key as "admin" | "member")}
              isDisabled={inviteBusy}
            >
              <PickerItem id="member">Member</PickerItem>
              <PickerItem id="admin">Admin</PickerItem>
            </Picker>
            <Button variant="accent" onPress={submitInvite} isDisabled={inviteBusy}>
              {inviteBusy ? "Sending…" : "Send invite"}
            </Button>
          </div>
        </div>
      )}

      <Divider />

      <div className={section}>
        <Heading level={3}>Members</Heading>
        {loading && <ProgressCircle aria-label="Loading members" isIndeterminate />}
        {data?.members.map((m) => {
          const isSelf = m.user_id === user?.user_id;
          return (
            <div key={m.user_id} className={row}>
              <div className={grow}>
                <Text>
                  <strong>{m.display_name || m.email}</strong>
                  {m.display_name && <Text>  ({m.email})</Text>}
                  {isSelf && <Text>  (you)</Text>}
                </Text>
              </div>
              {canManage ? (
                <Picker
                  aria-label={`Role for ${m.email}`}
                  selectedKey={m.role}
                  onSelectionChange={(key) => key && changeRole(m.user_id, key as OrgRole)}
                >
                  <PickerItem id="owner">Owner</PickerItem>
                  <PickerItem id="admin">Admin</PickerItem>
                  <PickerItem id="member">Member</PickerItem>
                </Picker>
              ) : (
                <Badge variant={roleVariant(m.role)}>{m.role}</Badge>
              )}
              {(canManage || isSelf) && (
                <Button variant="negative" onPress={() => remove(m.user_id)}>
                  {isSelf ? "Leave" : "Remove"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {data && data.invites.length > 0 && (
        <>
          <Divider />
          <div className={section}>
            <Heading level={3}>Pending invites</Heading>
            {data.invites.map((i) => (
              <div key={i.invite_id} className={row}>
                <div className={`${grow} ${row}`}>
                  <Text><strong>{i.email}</strong></Text>
                  <Badge variant={roleVariant(i.role)}>{i.role}</Badge>
                </div>
                <Button variant="secondary" onPress={() => copyInviteLink(i.invite_id)}>
                  {copiedId === i.invite_id ? "Copied!" : "Copy link"}
                </Button>
                {canManage && (
                  <Button variant="secondary" onPress={() => revoke(i.invite_id)}>
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
