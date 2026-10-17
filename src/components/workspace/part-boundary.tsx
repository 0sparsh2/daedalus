"use client";
import { Component, type ReactNode } from "react";

/**
 * Parts render model output, which can arrive in any shape. One part that fails to render
 * shows a short note instead of taking down the whole workspace (and the live run stream).
 */
export class PartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[workspace] a message part failed to render", error);
  }

  render() {
    if (this.state.failed) return <div className="status-line">This step couldn&apos;t be shown.</div>;
    return this.props.children;
  }
}
