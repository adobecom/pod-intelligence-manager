export interface StandardsSource {
  id: string;
  name: string;
  description: string;
  repo: string;
  branch: string;
  path: string;
  files: string[];
  /** Known item names, used as fallback when the GitHub listing is unavailable. */
  staticItems?: string[];
  /** Adobe-enforced: pre-selected in the wizard and cannot be deselected. */
  mandatory?: boolean;
  /** Path to a marketplace.json registry within the repo. When set, the system
   *  fetches this file at runtime to discover plugin sub-sources dynamically.
   *  Each plugin's skills are expected at {plugin.source}/skills/. */
  marketplacePath?: string;
}

export const STANDARDS_CATALOGUE: StandardsSource[] = [
  {
    id: "milo-skills",
    name: "Milo Skills",
    description: "Figma-to-Milo component builder skills",
    staticItems: ["build-block-from-figma", "build-content-from-figma", "build-scroll-animation"],
    repo: "adobecom/milo",
    branch: "main",
    path: ".claude/skills",
    files: ["SKILL.md", "README.md"],
  },
  {
    id: "adobe-skills",
    name: "Adobe Skills",
    description: "Official Adobe product skills library",
    repo: "adobe/skills",
    branch: "main",
    path: "plugins",
    marketplacePath: ".claude-plugin/marketplace.json",
    files: ["SKILL.md"],
  },
];
