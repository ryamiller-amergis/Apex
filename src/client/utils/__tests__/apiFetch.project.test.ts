import { apexProjectHeaders, getSelectedApexProject, withApexProject } from '../apiFetch';
import { pdfFileUrl } from '../pdfUrls';

describe('apex project helpers', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('reads selectedProject from localStorage', () => {
    expect(getSelectedApexProject()).toBeNull();
    localStorage.setItem('selectedProject', 'Apex');
    expect(getSelectedApexProject()).toBe('Apex');
  });

  it('adds X-Apex-Project header when a project is selected', () => {
    localStorage.setItem('selectedProject', 'Apex');
    const headers = apexProjectHeaders({ 'Content-Type': 'application/json' });
    expect(headers.get('X-Apex-Project')).toBe('Apex');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('omits X-Apex-Project when no project is selected', () => {
    const headers = apexProjectHeaders();
    expect(headers.get('X-Apex-Project')).toBeNull();
  });

  it('appends project query param for URL-based loads', () => {
    localStorage.setItem('selectedProject', 'Apex');
    expect(withApexProject('/api/pdf/sessions/s1/files/f1')).toBe(
      '/api/pdf/sessions/s1/files/f1?project=Apex',
    );
    expect(withApexProject('/api/pdf/x?foo=1')).toBe('/api/pdf/x?foo=1&project=Apex');
  });

  it('builds project-scoped pdf file urls', () => {
    localStorage.setItem('selectedProject', 'Apex');
    expect(pdfFileUrl('sess-1', 'file-1')).toBe(
      '/api/pdf/sessions/sess-1/files/file-1?project=Apex',
    );
  });
});
