"use client";

// Re-exports a wrapped AgGridReact so every consumer pulls the grid (and its
// dark themeAlpine look) from "@/lib/agGrid" instead of "ag-grid-react".
//
// The grid itself is loaded LAZILY via next/dynamic: the heavy AG Grid bundle +
// its module registration (see ./agGridImpl) only download and parse once a grid
// is actually rendered, instead of on every grid page's first load. This lightens
// initial paint on the grid-heavy pages for every device. It does NOT touch data
// fetching or realtime — those live in the consuming components and are unchanged.

import * as React from "react";
import dynamic from "next/dynamic";
import { type AgGridReactProps } from "ag-grid-react";

const LazyAgGrid = dynamic(() => import("./agGridImpl"), {
  ssr: false,
  loading: () => null,
});

export function AgGridReact<TData>(
  props: AgGridReactProps<TData>,
): React.ReactElement {
  // The lazy component is non-generic at runtime; the generic is preserved here
  // for consumers (e.g. <AgGridReact<AllocationRow> …>). Runtime payload is
  // identical — cast to opt out of the generic/overload mismatch.
  return React.createElement(
    LazyAgGrid as unknown as React.ComponentType<AgGridReactProps<TData>>,
    props,
  );
}
