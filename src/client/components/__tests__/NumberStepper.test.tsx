import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumberStepper } from '../NumberStepper';

describe('NumberStepper', () => {
  it('increments and decrements within bounds without a native number input', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const { rerender } = render(
      <NumberStepper value={5} min={1} max={10} step={1} unit="VUs" onChange={onChange} />,
    );

    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByTestId('number-stepper-value')).toHaveTextContent('5');

    await user.click(screen.getByRole('button', { name: 'Increase' }));
    expect(onChange).toHaveBeenLastCalledWith(6);

    rerender(<NumberStepper value={1} min={1} max={10} step={1} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Decrease' })).toBeDisabled();
  });
});
