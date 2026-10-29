import { useState, type FC } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QuickLinkCategoryField } from '../QuickLinkCategoryField';
import { categoryToneIndex } from '../QuickLinkCategory';

const onChangeSpy = jest.fn();

const Harness: FC<{ initial?: string; options?: string[] }> = ({ initial = '', options = ['Tools', 'Work'] }) => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <QuickLinkCategoryField
        id="cat"
        label="Category"
        value={value}
        onChange={(v) => {
          onChangeSpy(v);
          setValue(v);
        }}
        options={options}
        data-testid="cat"
      />
      <output data-testid="value">{value}</output>
    </>
  );
};

beforeEach(() => onChangeSpy.mockClear());

describe('QuickLinkCategoryField', () => {
  it('lists existing categories with a labelled select', () => {
    render(<Harness />);
    const select = screen.getByLabelText('Category') as HTMLSelectElement;
    expect(select).toBe(screen.getByTestId('cat'));
    expect(Array.from(select.options).map((o) => o.text)).toEqual(['No category', 'Tools', 'Work', '+ New category…']);
  });

  it('picks an existing category', () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId('cat'), { target: { value: 'Work' } });
    expect(screen.getByTestId('value')).toHaveTextContent('Work');
  });

  it('switches to a focused text input for a new category, and back', () => {
    render(<Harness initial="Tools" />);
    fireEvent.change(screen.getByTestId('cat'), { target: { value: '__new_category__' } });

    const input = screen.getByTestId('cat-new');
    expect(input).toHaveFocus();
    expect(screen.getByLabelText('Category')).toBe(input);
    fireEvent.change(input, { target: { value: 'Monitoring' } });
    expect(screen.getByTestId('value')).toHaveTextContent('Monitoring');

    fireEvent.click(screen.getByTestId('cat-choose-existing'));
    expect(screen.getByTestId('cat')).toHaveValue('');
    expect(onChangeSpy).toHaveBeenLastCalledWith('');
  });

  it('starts in text mode when the value is not an existing category', () => {
    render(<Harness initial="Legacy" />);
    expect(screen.getByTestId('cat-new')).toHaveValue('Legacy');
  });

  it('has no Choose existing button when there are no categories yet', () => {
    render(<Harness options={[]} />);
    fireEvent.change(screen.getByTestId('cat'), { target: { value: '__new_category__' } });
    expect(screen.queryByTestId('cat-choose-existing')).not.toBeInTheDocument();
  });
});

describe('categoryToneIndex', () => {
  it('maps the same name to the same tone, ignoring case and spaces', () => {
    expect(categoryToneIndex('Tools')).toBe(categoryToneIndex('  tools '));
    expect(categoryToneIndex('Tools')).toEqual(expect.any(Number));
  });

  it('has no tone for uncategorized links', () => {
    expect(categoryToneIndex(null)).toBeNull();
    expect(categoryToneIndex('  ')).toBeNull();
  });

  it('spreads names across the palette', () => {
    const tones = new Set(['Environments', 'Tools', 'Analytics', 'Work', 'Docs', 'Monitoring', 'Design', 'Support'].map(categoryToneIndex));
    expect(tones.size).toBeGreaterThan(3);
  });
});
