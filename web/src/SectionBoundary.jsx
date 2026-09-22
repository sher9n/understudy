import React from 'react';

/* One part of a page that failed to draw says so in its own place, and the rest of the page stays.
   Without it, one unexpected value in one section blanked the whole app. */
export default class SectionBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) { return { err }; }

  componentDidCatch(err) { console.error(`${this.props.title || 'a section'} failed to draw`, err); }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <section className="opt">
        {this.props.title && <div className="opthead"><h2>{this.props.title}</h2></div>}
        <div className="errbox" style={{ margin: 16 }}>
          This part of the page could not be shown ({String(this.state.err?.message || this.state.err).slice(0, 160)}).
          The rest of the page is unaffected; reloading usually brings it back.
        </div>
      </section>
    );
  }
}
