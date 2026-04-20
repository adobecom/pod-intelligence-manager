import {
  ActionButton,
  MenuTrigger,
  Menu,
  MenuItem,
  MenuSection,
  Header,
  Text,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Leave from "@react-spectrum/s2/icons/Leave";
import UserGroup from "@react-spectrum/s2/icons/UserGroup";
import Checkmark from "@react-spectrum/s2/icons/Checkmark";
import Add from "@react-spectrum/s2/icons/Add";
import { useAuth } from "../contexts/AuthContext";
import { useOrg } from "../contexts/OrgContext";

interface UserMenuProps {
  onCreateOrg: () => void;
  onSignOut: () => void;
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

export function UserMenu({ onCreateOrg, onSignOut }: UserMenuProps) {
  const { user } = useAuth();
  const { orgs, currentOrg, setCurrentOrg } = useOrg();

  const initials = getInitials(user?.display_name);

  const handleAction = (key: React.Key) => {
    const k = String(key);
    if (k === "signout") {
      onSignOut();
    } else if (k === "neworg") {
      onCreateOrg();
    } else if (k.startsWith("org_")) {
      setCurrentOrg(k.replace("org_", ""));
    }
  };

  return (
    <MenuTrigger>
      <ActionButton isQuiet aria-label="User menu">
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: "#0d66d0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.02em",
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
      </ActionButton>

      <Menu onAction={handleAction} UNSAFE_style={{ minWidth: 220 }}>
        {/* Account info — decorative, not actionable */}
        {user && (
          <MenuSection aria-label="Account">
            <MenuItem id="account-info" isDisabled textValue={user.display_name ?? user.email}>
              <div className={style({ display: "flex", flexDirection: "column", gap: 2 })}>
                <Text slot="label">{user.display_name ?? user.email}</Text>
                {user.display_name && (
                  <Text slot="description">{user.email}</Text>
                )}
              </div>
            </MenuItem>
          </MenuSection>
        )}

        {/* Org switcher */}
        {orgs.length > 0 && (
          <MenuSection>
            <Header>Organization</Header>
            {orgs.map((o) => (
              <MenuItem key={`org_${o.slug}`} id={`org_${o.slug}`} textValue={o.name}>
                {currentOrg?.slug === o.slug ? <Checkmark /> : <UserGroup />}
                <Text slot="label">{o.name}</Text>
              </MenuItem>
            ))}
          </MenuSection>
        )}

        {/* Actions */}
        <MenuSection aria-label="Actions">
          <MenuItem id="neworg" textValue="New org">
            <Add />
            <Text slot="label">New org</Text>
          </MenuItem>
          <MenuItem id="signout" textValue="Sign out">
            <Leave />
            <Text slot="label">Sign out</Text>
          </MenuItem>
        </MenuSection>
      </Menu>
    </MenuTrigger>
  );
}
