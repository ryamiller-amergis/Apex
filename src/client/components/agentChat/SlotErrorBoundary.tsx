import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './AgentHarnessPanel.module.css';

export interface SlotErrorBoundaryProps {
  slotName: string;
  testId?: string;
  children: ReactNode;
}

interface SlotErrorBoundaryState {
  hasError: boolean;
}

/**
 * Isolates render errors thrown inside an AgentHarnessPanel extension slot
 * so sibling slots, transcript, and composer keep working.
 */
export class SlotErrorBoundary extends Component<
  SlotErrorBoundaryProps,
  SlotErrorBoundaryState
> {
  public state: SlotErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): SlotErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Error is intentionally isolated within this slot boundary.
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      const { slotName, testId } = this.props;
      return (
        <div
          role="alert"
          className={styles.slotError}
          {...{ 'data-testid': testId ?? `agent-slot-error-${slotName}` }}
        >
          This section could not load.
        </div>
      );
    }

    return this.props.children;
  }
}
