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

export function UserMenu({ onCreateOrg, onSignOut }: UserMenuProps) {
  const { user } = useAuth();
  const { orgs, currentOrg, setCurrentOrg } = useOrg();

  const displayName = user?.display_name ?? user?.email ?? "";

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
      <ActionButton isQuiet aria-label="User menu" styles={style({ borderRadius: "pill" })}>
        <Text>{displayName}</Text>
      </ActionButton>

      <Menu onAction={handleAction} UNSAFE_style={{ minWidth: 220 }}>
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
