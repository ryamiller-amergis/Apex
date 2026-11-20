import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import {
  useProjectSkillLibrary,
  useSaveProjectSkill,
} from '../hooks/useProjectSkillLibrary';
import { DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './ProjectSkillLibraryPage.module.css';
import {
  OUTPUT_KIND_OPTIONS,
  buildProjectSkillMarkdown,
  companionFileName,
  filterProjectSkills,
  skillNameFromTitle,
  type ProjectSkillOutputKind,
  type ProjectSkillType,
} from '../utils/projectSkillLibrary';

const ProjectSkillLibraryPage: React.FC<{ project: string }> = ({ project }) => {
  const { can } = useAppShell();
  const canView = can('skills:view') || can('skills:manage');
  const canManage = can('skills:manage');
  const library = useProjectSkillLibrary(project);
  const saveSkill = useSaveProjectSkill(project);
  const [search, setSearch] = useState('');
  const [writing, setWriting] = useState(false);
  const [openSkillId, setOpenSkillId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [skillType, setSkillType] = useState<ProjectSkillType>('autonomous');
  const [outputKind, setOutputKind] = useState<ProjectSkillOutputKind>('document@1');
  const [body, setBody] = useState('');
  const [referenceName, setReferenceName] = useState('');
  const [referenceBody, setReferenceBody] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const skills = library.data?.skills ?? [];
  const visible = useMemo(
    () => filterProjectSkills(skills, search),
    [skills, search],
  );
  const openSkill = skills.find((skill) => skill.id === openSkillId) ?? null;
  const slug = skillNameFromTitle(title);

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!slug) {
      setFormError('The title needs at least one letter or number.');
      return;
    }
    if (!description.trim() || !body.trim()) {
      setFormError('A description and instructions are required.');
      return;
    }
    const companions: { path: string; content: string; classification: 'reference' }[] = [];
    if (referenceName.trim() || referenceBody.trim()) {
      const path = companionFileName(referenceName);
      if (!path || !referenceBody.trim()) {
        setFormError('A reference file needs a file name and contents.');
        return;
      }
      companions.push({ path, content: referenceBody.trim(), classification: 'reference' });
    }
    const skill = buildProjectSkillMarkdown({ title, description, skillType, outputKind, body });
    try {
      await saveSkill.mutateAsync({ content: skill.content, companions });
      setWriting(false);
      setTitle('');
      setDescription('');
      setBody('');
      setReferenceName('');
      setReferenceBody('');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'The skill could not be saved.');
    }
  }

  if (!canView) {
    return (
      <section className={gridStyles.section}>
        <p className={gridStyles.empty}>You can view Playbooks, but not this project's skill library.</p>
      </section>
    );
  }

  return (
    <section className={gridStyles.section} data-testid="project-skill-library">
      <header className={gridStyles.header}>
        <div>
          <Link to="/playbooks" className={styles.backLink}>Back to Playbooks</Link>
          <h1 className={gridStyles.title}>Skill library</h1>
          <p className={gridStyles.hint}>
            Skills written for {project}. Base skills stay in the Playbook picker and are not edited here.
          </p>
        </div>
        {canManage ? (
          <div className={gridStyles.headerActions}>
            <button
              type="button"
              className={gridStyles.buttonPrimary}
              onClick={() => setWriting((open) => !open)}
              data-testid="skill-library-write"
            >
              Write a skill
            </button>
          </div>
        ) : null}
      </header>

      {writing ? (
        <form className={styles.form} onSubmit={onSave} data-testid="skill-library-form">
          <label className={styles.field}>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} data-testid="skill-library-title" />
          </label>
          <p className={styles.slug}>{slug ? `Saved as ${slug}` : 'The title becomes the skill name.'}</p>
          <label className={styles.field}>
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              data-testid="skill-library-description"
            />
          </label>
          <div className={styles.formRow}>
            <label className={styles.field}>
              Type
              <select
                value={skillType}
                onChange={(event) => setSkillType(event.target.value as ProjectSkillType)}
                data-testid="skill-library-type"
              >
                <option value="autonomous">Autonomous</option>
                <option value="interactive">Interactive</option>
              </select>
            </label>
            <label className={styles.field}>
              Output
              <select
                value={outputKind}
                onChange={(event) => setOutputKind(event.target.value as ProjectSkillOutputKind)}
                data-testid="skill-library-output"
              >
                {OUTPUT_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          <label className={styles.field}>
            Instructions
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              data-testid="skill-library-body"
            />
          </label>
          <div className={styles.formRow}>
            <label className={styles.field}>
              Reference file name
              <input
                value={referenceName}
                onChange={(event) => setReferenceName(event.target.value)}
                placeholder="NOTES.md"
                data-testid="skill-library-reference-name"
              />
            </label>
            <label className={styles.field}>
              Reference file
              <textarea
                value={referenceBody}
                onChange={(event) => setReferenceBody(event.target.value)}
                data-testid="skill-library-reference-body"
              />
            </label>
          </div>
          {formError ? <p className={gridStyles.error}>{formError}</p> : null}
          <div className={styles.formActions}>
            <button type="submit" className={gridStyles.buttonPrimary} disabled={saveSkill.isPending}>
              Save skill
            </button>
            <button type="button" className={gridStyles.button} onClick={() => setWriting(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search skills"
        searchTestId="skill-library-search"
      />

      {library.isLoading ? <p className={gridStyles.loading}>Loading skills…</p> : null}
      {library.isError ? (
        <p className={gridStyles.error}>
          {library.error instanceof Error ? library.error.message : 'The skill library could not be loaded.'}
        </p>
      ) : null}

      {!library.isLoading && !library.isError && visible.length === 0 ? (
        <p className={gridStyles.empty} data-testid="skill-library-empty">
          {skills.length === 0 ? 'This project has no skills yet.' : 'No skills match this search.'}
        </p>
      ) : null}

      {visible.length > 0 ? (
        <div className={gridStyles.tableWrap}>
          <table className={gridStyles.table} data-testid="skill-library-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Latest</th>
                <th>Output</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((skill) => {
                const latest = skill.versions[0];
                return (
                  <tr key={skill.id}>
                    <td>{skill.name}</td>
                    <td>{skill.description}</td>
                    <td>{latest ? `v${latest.versionNumber} ${latest.status}` : '—'}</td>
                    <td>{latest?.outputKind ?? '—'}</td>
                    <td>
                      <div className={gridStyles.rowActions}>
                        <button
                          type="button"
                          className={gridStyles.button}
                          onClick={() => setOpenSkillId((current) => (current === skill.id ? null : skill.id))}
                          data-testid={`skill-library-versions-${skill.id}`}
                        >
                          Versions
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {openSkill ? (
        <div className={styles.detail} data-testid="skill-library-versions">
          <h2 className={gridStyles.title}>{openSkill.name}</h2>
          {openSkill.versions.map((version) => (
            <article key={version.id} className={styles.version}>
              <strong>Version {version.versionNumber}</strong>
              <span>{version.status} · {version.skillType ?? 'unspecified'} · {version.outputKind ?? 'unspecified'}</span>
              {version.files.length === 0 ? <p>No companion files.</p> : null}
              {version.files.map((file) => (
                <div key={file.id} className={styles.file}>
                  <span>{file.fileName}</span>
                  <span>{file.classification}</span>
                  <pre className={styles.fileBody}>{file.content}</pre>
                </div>
              ))}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
};

export default ProjectSkillLibraryPage;
