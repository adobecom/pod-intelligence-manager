import { useState } from "react";
import {
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogTrigger,
  Heading,
  InlineAlert,
  TextField,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { createUserOrg } from "../../services/api";
import { useAuth } from "../../contexts/AuthContext";
import { useOrg } from "../../contexts/OrgContext";

const form = style({
  display: "flex",
  flexDirection: "column",
  gap: 12,
  marginTop: 12,
});

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

interface CreateOrgModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** When true, the dialog cannot be dismissed — used during the zero-orgs onboarding. */
  required?: boolean;
}

export function CreateOrgModal({ isOpen, onOpenChange, required }: CreateOrgModalProps) {
  const { refreshMe } = useAuth();
  const { setCurrentOrg } = useOrg();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onNameChange = (value: string) => {
    setName(value);
    if (!slugDirty) setSlug(slugify(value));
  };

  const reset = () => {
    setName("");
    setSlug("");
    setSlugDirty(false);
    setError(null);
    setSubmitting(false);
  };

  const submit = async () => {
    const trimmedName = name.trim();
    const cleanedSlug = slugify(slug);
    if (trimmedName.length === 0 || cleanedSlug.length < 2) {
      setError("Name and slug are required (slug must be at least 2 characters).");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createUserOrg({ slug: cleanedSlug, name: trimmedName });
      await refreshMe();
      setCurrentOrg(created.slug);
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create org");
      setSubmitting(false);
    }
  };

  return (
    <DialogTrigger
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) reset();
        onOpenChange(open);
      }}
    >
      <Button
        aria-label="Create org dialog anchor"
        UNSAFE_style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        .
      </Button>
      <Dialog isDismissible={!required} isKeyboardDismissDisabled={required || submitting}>
        <Heading slot="title">{required ? "Create your first org" : "Create a new org"}</Heading>
        <Content>
          {required && (
            <InlineAlert variant="informative">
              You need an org to use PIM. Create one to get started — you'll be the owner and can
              invite teammates later.
            </InlineAlert>
          )}
          <div className={form}>
            <TextField
              label="Org name"
              value={name}
              onChange={onNameChange}
              isDisabled={submitting}
              autoFocus
            />
            <TextField
              label="Slug"
              description="Globally unique, used in URLs. Lowercase letters, numbers, and dashes."
              value={slug}
              onChange={(v) => {
                setSlug(v);
                setSlugDirty(true);
              }}
              isDisabled={submitting}
            />
            {error && <InlineAlert variant="negative">{error}</InlineAlert>}
          </div>
        </Content>
        <ButtonGroup>
          {!required && (
            <Button variant="secondary" onPress={() => onOpenChange(false)} isDisabled={submitting}>
              Cancel
            </Button>
          )}
          <Button variant="accent" onPress={submit} isDisabled={submitting}>
            {submitting ? "Creating…" : "Create org"}
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogTrigger>
  );
}
