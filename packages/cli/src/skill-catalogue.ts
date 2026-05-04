export interface SkillSource {
  id: string;
  name: string;
  description: string;
  repo: string;
  branch: string;
  path: string;
  skillFiles: string[];
}

export const SKILL_CATALOGUE: SkillSource[] = [
  {
    id: "milo-skills",
    name: "Milo Skills",
    description: "build-block-from-figma, build-content-from-figma, build-scroll-animation",
    repo: "overmyheadandbody/milo",
    branch: "main",
    path: ".claude/skills",
    skillFiles: ["SKILL.md", "README.md"],
  },
];
