/**
 * @apex/skills — public library surface
 *
 * Programmatic API for consuming the foundation skills package from other
 * Node processes (e.g. the APEX server-side installer service).
 */

export { executeInstall, planInstall }       from './install.mjs';
export { checkRepo }                          from './check.mjs';
export { bootstrapSkill }                     from './bootstrap.mjs';
export { runDoctor, formatDoctor, resolveApexRegistry, apexRegistryRemediation } from './doctor.mjs';
export {
  initRegistry,
  mergeApexRegistry,
  hasApexRegistry,
  NPMRC_TEMPLATE_NAME,
} from './initRegistry.mjs';
export { validatePackage }                    from './validatePackage.mjs';
export { loadCatalog, findSkill, validateCatalog } from './catalog.mjs';
export { readLockfile, emptyLockfile, serializeLockfile, lockfileIntegrity } from './lockfile.mjs';
export { migrateSkillRoot, planSkillRootMigration } from './migrateRoot.mjs';
export {
  AGENT_SKILL_ROOT,
  LEGACY_SKILL_ROOT,
  normalizeSkillRoot,
  resolveRepoSkillRoot,
  resolveSkillRoot,
} from './skillRoot.mjs';
