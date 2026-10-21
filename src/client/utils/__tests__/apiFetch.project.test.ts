import { apexProjectHeaders, getSelectedApexProject, notifySelectedProjectChanged, SELECTED_PROJECT_CHANGE_EVENT, withApexProject } from '../apiFetch';

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
    expect(withApexProject('/api/files/s1')).toBe(
      '/api/files/s1?project=Apex',
    );
    expect(withApexProject('/api/files/x?foo=1')).toBe('/api/files/x?foo=1&project=Apex');
  });

  it('notifies same-tab listeners when the selected project changes', () => {
    const listener = jest.fn();
    window.addEventListener(SELECTED_PROJECT_CHANGE_EVENT, listener);
    notifySelectedProjectChanged();
    window.removeEventListener(SELECTED_PROJECT_CHANGE_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
