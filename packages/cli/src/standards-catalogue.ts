export interface StandardsSource {
  id: string;
  name: string;
  description: string;
  repo: string;
  branch: string;
  path: string;
  files: string[];
}

export const STANDARDS_CATALOGUE: StandardsSource[] = [
  {
    id: "milo-skills",
    name: "Milo Skills",
    description: "build-block-from-figma, build-content-from-figma, build-scroll-animation",
    repo: "overmyheadandbody/milo",
    branch: "main",
    path: ".claude/skills",
    files: ["SKILL.md", "README.md"],
  },
];
