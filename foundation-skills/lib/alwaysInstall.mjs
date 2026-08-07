/**
 * Skills that ship with every authorized install, even when not listed in the
 * release's selectedSkills. Keep this list tiny — each entry is content every
 * entitled project receives and updates with the package.
 */
export const ALWAYS_INSTALL_SKILLS = Object.freeze(['post-skill-bootstrap']);

/**
 * Merge always-install skills into a skill list (deduped, stable order:
 * original list first, then any missing always-install names).
 */
export function ensureAlwaysInstallSkills(skills = []) {
  const out = [...skills];
  const seen = new Set(out);
  for (const name of ALWAYS_INSTALL_SKILLS) {
    if (!seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  return out;
}

/** True when the skill is always installed (bypass release allowlist reject). */
export function isAlwaysInstallSkill(name) {
  return ALWAYS_INSTALL_SKILLS.includes(name);
}
