"use client";

// The actual AG Grid widget + one-time module registration + theme. This lives
// in its own module so it can be code-split behind next/dynamic (see
// ./agGrid.ts) — pages don't download/parse the heavy AG Grid bundle until a
// grid is about to render. Nothing here touches data or realtime; it's purely
// the grid widget.

import * as React from "react";
import {
  AgGridReact as BaseAgGridReact,
  type AgGridReactProps,
} from "ag-grid-react";
import {
  ModuleRegistry,
  AllCommunityModule,
  themeAlpine,
  colorSchemeDark,
} from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

const lasMunsTheme = themeAlpine.withPart(colorSchemeDark);

// Non-generic props: the generic is preserved by the public wrapper in
// ./agGrid.ts; here we only need the runtime shape.
export default function AgGridImpl(
  props: AgGridReactProps<unknown>,
): React.ReactElement {
  const mergedDefaultColDef = {
    wrapHeaderText: true,
    autoHeaderHeight: true,
    ...(props.defaultColDef ?? {}),
  } as AgGridReactProps<unknown>["defaultColDef"];
  return React.createElement(
    BaseAgGridReact as unknown as React.ComponentType<AgGridReactProps<unknown>>,
    {
      theme: lasMunsTheme,
      ...props,
      defaultColDef: mergedDefaultColDef,
    },
  );
}
