import { Failed } from '@jian/ui';
import { Component, type ReactNode } from 'react';

type State = { failed: boolean };

/**
 * A section the panel could not draw, as the web host's error page shows it: the rest of the
 * panel keeps working, and the section offers to try again.
 */
export class Section extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <Failed retry={() => this.setState({ failed: false })} />;
    return this.props.children;
  }
}
