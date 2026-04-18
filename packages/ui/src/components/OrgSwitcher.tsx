import { Picker, PickerItem, Button } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useAuth } from "../contexts/AuthContext";
import { useOrg } from "../contexts/OrgContext";

const wrapper = style({
  display: "flex",
  alignItems: "center",
  gap: 8,
});

interface OrgSwitcherProps {
  onCreateOrg: () => void;
  onSignOut: () => void;
}

export function OrgSwitcher({ onCreateOrg, onSignOut }: OrgSwitcherProps) {
  const { user } = useAuth();
  const { orgs, currentOrg, setCurrentOrg } = useOrg();

  return (
    <div className={wrapper}>
      <Picker
        aria-label="Current org"
        selectedKey={currentOrg?.slug ?? null}
        onSelectionChange={(key) => key && setCurrentOrg(String(key))}
        isDisabled={orgs.length === 0}
      >
        {orgs.map((o) => (
          <PickerItem key={o.slug} id={o.slug} textValue={o.name}>
            {o.name}
          </PickerItem>
        ))}
      </Picker>
      <Button variant="secondary" onPress={onCreateOrg}>
        New org
      </Button>
      {user && (
        <Button variant="secondary" onPress={onSignOut}>
          Sign out
        </Button>
      )}
    </div>
  );
}
